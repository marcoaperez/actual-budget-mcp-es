import { describe, it, expect } from 'vitest';
import { applyOperation } from '../../src/core/reconcile-apply.js';
import { messagesFor } from '../../src/core/messages.js';
import { fakeLedger, transferPayeeOf } from '../helpers/fake-ledger.js';

const m = messagesFor('es');
const noSleep = { sleep: async () => {} };
const accounts = [{ id: 'A', name: 'BBVA' }, { id: 'B', name: 'ING' }, { id: 'CASH', name: 'Efectivo' }, { id: 'OLD', name: 'Vieja', closed: true }];
const x = { id: 'x', account: 'A', date: '2026-09-15', amount: -10000, imported_id: 'ix', payee: 'p-orig' };
const y = { id: 'y', account: 'B', date: '2026-09-16', amount: 10000, imported_id: 'iy' };

describe('link', () => {
  it('enlaza dos patas importadas conservando ambos imported_id y sin restos', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y] });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(db.get('x').transfer_id).toBe('y');
    expect(db.get('y').transfer_id).toBe('x');
    expect(db.get('x').imported_id).toBe('ix');
    expect(db.get('y').imported_id).toBe('iy');
    expect(db.size).toBe(2);
    expect(r.survivor_id).toBe('y');
  });

  it('cambia el beneficiario de la pata NO importada para que sobreviva la importada', async () => {
    const manualX = { ...x, imported_id: null };
    const { api, db } = fakeLedger({ accounts, rows: [y, manualX] });
    const r = await applyOperation(api, { type: 'link', a: 'y', b: 'x' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(api.updateTransaction).toHaveBeenCalledWith('x', { payee: transferPayeeOf('B') });
    expect(db.get('y').imported_id).toBe('iy');
    expect(db.get('y').transfer_id).toBe('x');
  });

  it('espera a que aparezca la contrapartida (creación asíncrona)', async () => {
    const { api } = fakeLedger({ accounts, rows: [x, y], behaviour: { counterpartAfterReads: 4 } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('aplicada');
  });

  it('si la contrapartida no aparece, revierte el beneficiario y falla', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y], behaviour: { noCounterpart: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, { ...noSleep, attempts: 3 });
    expect(r.status).toBe('fallida');
    expect(db.get('x').payee).toBe('p-orig');
    expect(db.get('x').transfer_id).toBeNull();
  });

  it('si la fusión falla, revierte (borra la contrapartida) y falla', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y], behaviour: { failMerge: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(r.detail).toMatch(/merge boom/);
    expect(db.size).toBe(2);
    expect(db.get('x').transfer_id).toBeNull();
    expect(db.get('x').payee).toBe('p-orig');
  });

  it('falla sin revertir si tras fusionar el enlace no cuadra, con los ids', async () => {
    const { api } = fakeLedger({ accounts, rows: [x, y], behaviour: { mergeLosesLink: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(r.detail).toMatch(/x/);
    expect(r.detail).toMatch(/y/);
  });

  it('si la fusión falla, restaura también la categoría de X', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [{ ...x, category: 'c1' }, y], behaviour: { failMerge: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(db.get('x').category).toBe('c1');
    expect(db.get('x').payee).toBe('p-orig');
  });

  it('si la fusión rompe los enlaces y falla, borra la contrapartida suelta y restaura X', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [{ ...x, category: 'c1' }, y], behaviour: { mergeDropsLinksThenFails: true } });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(api.deleteTransaction).toHaveBeenCalledWith('cp-1');
    expect(db.has('cp-1')).toBe(false);
    expect(db.size).toBe(2);
    expect(db.get('x').payee).toBe('p-orig');
    expect(db.get('x').category).toBe('c1');
    expect(db.get('x').transfer_id).toBeNull();
  });

  it('no revierte si X ya apunta a otra fila que no es la contrapartida creada', async () => {
    const other = { id: 'zz', account: 'CASH', date: '2026-09-15', amount: 10000, transfer_id: 'x' };
    const { api, db } = fakeLedger({ accounts, rows: [x, y, other], behaviour: { failMerge: true } });
    const realMerge = (api.mergeTransactions as any).getMockImplementation();
    (api.mergeTransactions as any).mockImplementationOnce(async (ids: any) => {
      db.get('x').transfer_id = 'zz';
      return realMerge(ids);
    });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, { ...noSleep, attempts: 3 });
    expect(r.status).toBe('fallida');
    expect(r.detail).toMatch(/zz/);
    expect(r.detail).toMatch(/cp-1/);
    expect(api.updateTransaction).toHaveBeenCalledTimes(1);
    expect(db.get('zz')).toBeTruthy();
    expect(db.get('x').payee).toBe(transferPayeeOf('B'));
  });

  it('no borra la contrapartida suelta si ya apunta a otra fila', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y], behaviour: { mergeDropsLinksThenFails: true } });
    const realMerge = (api.mergeTransactions as any).getMockImplementation();
    (api.mergeTransactions as any).mockImplementationOnce(async (ids: any) => {
      try {
        await realMerge(ids);
      } finally {
        db.get('cp-1').transfer_id = 'elsewhere';
      }
    });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, { ...noSleep, attempts: 3 });
    expect(r.status).toBe('fallida');
    expect(api.deleteTransaction).not.toHaveBeenCalled();
    expect(db.has('cp-1')).toBe(true);
    expect(r.detail).toMatch(/cp-1/);
  });

  it('no borra la contrapartida suelta si aún apunta a X (Actual borraría el original)', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y], behaviour: { mergeDropsLinksThenFails: true } });
    const realMerge = (api.mergeTransactions as any).getMockImplementation();
    (api.mergeTransactions as any).mockImplementationOnce(async (ids: any) => {
      try {
        await realMerge(ids);
      } finally {
        db.get('cp-1').transfer_id = 'x';
      }
    });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, { ...noSleep, attempts: 3 });
    expect(r.status).toBe('fallida');
    expect(api.deleteTransaction).not.toHaveBeenCalled();
    expect(db.has('x')).toBe(true);
    expect(db.has('cp-1')).toBe(true);
    expect(r.detail).toMatch(/cp-1/);
  });

  it('no borra la contrapartida suelta si ya está conciliada', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [x, y], behaviour: { mergeDropsLinksThenFails: true } });
    const realMerge = (api.mergeTransactions as any).getMockImplementation();
    (api.mergeTransactions as any).mockImplementationOnce(async (ids: any) => {
      try {
        await realMerge(ids);
      } finally {
        db.get('cp-1').reconciled = true;
      }
    });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, { ...noSleep, attempts: 3 });
    expect(r.status).toBe('fallida');
    expect(api.deleteTransaction).not.toHaveBeenCalled();
  });

  it('omite si Y está en una cuenta cerrada', async () => {
    const { api } = fakeLedger({ accounts, rows: [x, { ...y, account: 'OLD' }] });
    const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
    expect(r.status).toBe('omitida');
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('omite si un movimiento es hijo o padre de un split', async () => {
    for (const patch of [{ is_child: true, parent_id: 'p' }, { is_parent: true }]) {
      const { api } = fakeLedger({ accounts, rows: [{ ...x, ...patch }, y] });
      const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
      expect(r.status).toBe('omitida');
      expect(r.detail).toMatch(/split/);
      expect(api.updateTransaction).not.toHaveBeenCalled();
    }
  });

  it('omite si algo cambió entre proponer y aplicar', async () => {
    const cases: [any[], string][] = [
      [[{ ...x, reconciled: true }, y], 'conciliad'],
      [[{ ...x, transfer_id: 'zz' }, y], 'transferencia'],
      [[x, { ...y, amount: 9999 }], 'importe'],
      [[x, { ...y, account: 'A' }], 'misma cuenta'],
      [[x], 'y'],
    ];
    for (const [rows, why] of cases) {
      const { api } = fakeLedger({ accounts, rows });
      const r = await applyOperation(api, { type: 'link', a: 'x', b: 'y' }, m, noSleep);
      expect(r.status, why).toBe('omitida');
      expect(r.detail).toMatch(new RegExp(why, 'i'));
      expect(api.updateTransaction).not.toHaveBeenCalled();
    }
  });
});

describe('merge', () => {
  const imp = { id: 'imp', account: 'B', date: '2026-09-15', amount: 2500, imported_id: 'ib' };
  const man = { id: 'man', account: 'B', date: '2026-09-15', amount: 2500 };

  it('conserva el importado y borra el duplicado', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [imp, man] });
    const r = await applyOperation(api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(db.has('man')).toBe(false);
    expect(db.get('imp').imported_id).toBe('ib');
  });

  it('si el duplicado era una pata de transferencia, el enlace pasa al importado', async () => {
    const other = { id: 'o', account: 'A', date: '2026-09-15', amount: -2500, transfer_id: 'man' };
    const { api, db } = fakeLedger({ accounts, rows: [imp, { ...man, transfer_id: 'o' }, other] });
    const r = await applyOperation(api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(db.get('imp').transfer_id).toBe('o');
    expect(db.get('o').transfer_id).toBe('imp');
  });

  it('omite la fusión si la contrapartida del duplicado ya no existe o está conciliada', async () => {
    const orphanLeg = fakeLedger({ accounts, rows: [imp, { ...man, transfer_id: 'gone' }] });
    const r1 = await applyOperation(orphanLeg.api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r1.status).toBe('omitida');
    expect(r1.detail).toMatch(/gone/);
    expect(orphanLeg.api.mergeTransactions).not.toHaveBeenCalled();

    const other = { id: 'o', account: 'A', date: '2026-09-15', amount: -2500, transfer_id: 'man', reconciled: true };
    const rec = fakeLedger({ accounts, rows: [imp, { ...man, transfer_id: 'o' }, other] });
    const r2 = await applyOperation(rec.api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r2.status).toBe('omitida');
    expect(r2.detail).toMatch(/contrapartida o/);
    expect(rec.api.mergeTransactions).not.toHaveBeenCalled();
    expect(rec.db.has('man')).toBe(true);
  });

  it('omite si keep no es el importado o drop sí lo es', async () => {
    const { api } = fakeLedger({ accounts, rows: [imp, man] });
    expect((await applyOperation(api, { type: 'merge', keep: 'man', drop: 'imp' }, m, noSleep)).status).toBe('omitida');
    const both = fakeLedger({ accounts, rows: [imp, { ...man, imported_id: 'other' }] });
    expect((await applyOperation(both.api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep)).status).toBe('omitida');
  });

  it('falla con los ids si el enlace de la transferencia no pasó al superviviente', async () => {
    const other = { id: 'o', account: 'A', date: '2026-09-15', amount: -2500, transfer_id: 'man' };
    const { api } = fakeLedger({ accounts, rows: [imp, { ...man, transfer_id: 'o' }, other], behaviour: { mergeLosesLink: true } });
    const r = await applyOperation(api, { type: 'merge', keep: 'imp', drop: 'man' }, m, noSleep);
    expect(r.status).toBe('fallida');
    expect(r.detail).toMatch(/imp/);
  });
});

describe('create_transfer', () => {
  const bank = { id: 'w', account: 'A', date: '2026-09-15', amount: -5000, imported_id: 'iw' };

  it('apunta el movimiento al beneficiario de transferencia y devuelve la contrapartida', async () => {
    const { api, db } = fakeLedger({ accounts, rows: [bank] });
    const r = await applyOperation(api, { type: 'create_transfer', transaction: 'w', account: 'CASH' }, m, noSleep);
    expect(r.status).toBe('aplicada');
    expect(r.transfer_id).toBe(db.get('w').transfer_id);
    expect(db.get(r.transfer_id!).account).toBe('CASH');
  });

  it('omite si la cuenta destino está cerrada, no existe o es la misma', async () => {
    for (const account of ['OLD', 'NOPE', 'A']) {
      const { api } = fakeLedger({ accounts, rows: [bank] });
      expect((await applyOperation(api, { type: 'create_transfer', transaction: 'w', account }, m, noSleep)).status).toBe('omitida');
    }
  });
});
