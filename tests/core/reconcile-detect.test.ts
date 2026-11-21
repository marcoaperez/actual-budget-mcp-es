import { describe, it, expect } from 'vitest';
import { detectLinks, detectMerges, detectCreateTransfers, detectAll, findKeyword, findCompensation } from '../../src/core/reconcile-detect.js';
import { toTxRow } from '../../src/core/reconcile-data.js';
import type { AccountInfo, DetectInput } from '../../src/core/reconcile-model.js';
import { messagesFor } from '../../src/core/messages.js';

const m = messagesFor('es');
const tx = (over: any) => toTxRow({ account: 'A', date: '2026-09-15', amount: -100, ...over });
const acc = (over: Partial<AccountInfo>): AccountInfo => ({ id: 'A', name: 'Cuenta', offbudget: false, closed: false, bankSynced: false, ...over });
const input = (over: Partial<DetectInput>): DetectInput => ({ rows: [], accounts: [], history: new Map(), payeeNames: new Map(), targetRows: [], ...over });

// Fila compensadora: mismo importe con signo en la cuenta destino (la devolución que vuelve a salir).
const comp = (over: any = {}) => tx({ id: 'comp', account: 'CASH', date: '2026-10-05', amount: -100, ...over });

describe('detectLinks', () => {
  it('propone alta para la única pareja con importe contrario el mismo día', () => {
    const p = detectLinks([tx({ id: 'x', imported_id: 'i1' }), tx({ id: 'y', account: 'B', amount: 100, imported_id: 'i2' })], m);
    expect(p).toHaveLength(1);
    expect(p[0].operation).toEqual({ type: 'link', a: 'x', b: 'y' });
    expect(p[0].confidence).toBe('alta');
  });
  it('baja a dudosa con 2 o 3 días de diferencia y no propone a 4 días', () => {
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100, date: '2026-09-17' })], m)[0].confidence).toBe('dudosa');
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100, date: '2026-09-18' })], m)[0].confidence).toBe('dudosa');
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100, date: '2026-09-19' })], m)).toEqual([]);
  });
  it('con varias candidatas propone una dudosa por candidata', () => {
    const p = detectLinks([tx({ id: 'x' }), tx({ id: 'y1', account: 'B', amount: 100 }), tx({ id: 'y2', account: 'C', amount: 100 })], m);
    expect(p.map((q) => q.confidence)).toEqual(['dudosa', 'dudosa']);
  });
  it('emite cada pareja una sola vez', () => {
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100 })], m)).toHaveLength(1);
  });
  it('ignora conciliados, transferencias ya hechas, la misma cuenta y el importe cero', () => {
    expect(detectLinks([tx({ id: 'x', reconciled: true }), tx({ id: 'y', account: 'B', amount: 100 })], m)).toEqual([]);
    expect(detectLinks([tx({ id: 'x', transfer_id: 'z' }), tx({ id: 'y', account: 'B', amount: 100 })], m)).toEqual([]);
    expect(detectLinks([tx({ id: 'x' }), tx({ id: 'y', amount: 100 })], m)).toEqual([]);
    expect(detectLinks([tx({ id: 'x', amount: 0 }), tx({ id: 'y', account: 'B', amount: 0 })], m)).toEqual([]);
  });
});

describe('detectMerges', () => {
  it('propone alta para importado + manual iguales el mismo día, conservando el importado', () => {
    const p = detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man' })], m);
    expect(p).toHaveLength(1);
    expect(p[0].operation).toEqual({ type: 'merge', keep: 'imp', drop: 'man' });
    expect(p[0].confidence).toBe('alta');
  });
  it('baja a dudosa con 1-2 días y no propone a 3', () => {
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man', date: '2026-09-17' })], m)[0].confidence).toBe('dudosa');
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man', date: '2026-09-18' })], m)).toEqual([]);
  });
  it('NO propone dos importados iguales el mismo día (dos pagos reales)', () => {
    expect(detectMerges([tx({ id: 'a', imported_id: 'i1' }), tx({ id: 'b', imported_id: 'i2' })], m)).toEqual([]);
  });
  it('NO propone dos manuales iguales', () => {
    expect(detectMerges([tx({ id: 'a' }), tx({ id: 'b' })], m)).toEqual([]);
  });
  it('propone fusionar una pata de transferencia manual con el importado que la duplica', () => {
    const p = detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'leg', transfer_id: 'other' })], m);
    expect(p[0].operation).toEqual({ type: 'merge', keep: 'imp', drop: 'leg' });
  });
  it('ignora pares con algo conciliado o con el importado ya como transferencia', () => {
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i', reconciled: true }), tx({ id: 'man' })], m)).toEqual([]);
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i' }), tx({ id: 'man', reconciled: true })], m)).toEqual([]);
    expect(detectMerges([tx({ id: 'imp', imported_id: 'i', transfer_id: 'z' }), tx({ id: 'man' })], m)).toEqual([]);
  });
});

describe('detectCreateTransfers', () => {
  const accounts = [
    acc({ id: 'A', name: 'BBVA', bankSynced: true }),
    acc({ id: 'CASH', name: 'Efectivo' }),
    acc({ id: 'PEN', name: 'Pensión' }),
    acc({ id: 'X', name: 'Ab' }),
  ];
  it('alta cuando el historial apunta a una sola cuenta manual', () => {
    const p = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'CAJERO 123' })], accounts,
      history: new Map([['cajero 123', new Set(['CASH'])]]), targetRows: [comp()],
    }), m, new Set());
    expect(p).toEqual([expect.objectContaining({ operation: { type: 'create_transfer', transaction: 'x', account: 'CASH' }, confidence: 'alta' })]);
  });
  it('dudosa por cada cuenta si el historial apunta a varias', () => {
    const p = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'Traspaso' })], accounts,
      history: new Map([['traspaso', new Set(['CASH', 'PEN'])]]),
    }), m, new Set());
    expect(p.map((q) => [q.operation, q.confidence])).toEqual([
      [{ type: 'create_transfer', transaction: 'x', account: 'CASH' }, 'dudosa'],
      [{ type: 'create_transfer', transaction: 'x', account: 'PEN' }, 'dudosa'],
    ]);
  });
  it('dudosa si el nombre de la cuenta aparece (sin acentos) en beneficiario o notas', () => {
    const p = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'APORTACION PENSION' })], accounts,
    }), m, new Set());
    expect(p).toEqual([expect.objectContaining({ operation: { type: 'create_transfer', transaction: 'x', account: 'PEN' }, confidence: 'dudosa' })]);
  });
  it('el historial es alta solo si el conjunto bruto tiene una única cuenta', () => {
    const accs = [...accounts, acc({ id: 'BBVA2', name: 'Otra', bankSynced: true })];
    const p = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'Traspaso' })], accounts: accs,
      history: new Map([['traspaso', new Set(['CASH', 'BBVA2'])]]),
    }), m, new Set());
    expect(p).toEqual([expect.objectContaining({ operation: { type: 'create_transfer', transaction: 'x', account: 'CASH' }, confidence: 'dudosa' })]);
  });
  it('ignora nombres de cuenta demasiado cortos', () => {
    const p = detectCreateTransfers(input({ rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'ab cd' })], accounts }), m, new Set());
    expect(p).toEqual([]);
  });
  it('no propone si el movimiento tiene candidata de enlace o su cuenta no es sincronizada', () => {
    const rows = [tx({ id: 'x', imported_id: 'i', imported_payee: 'Efectivo' })];
    expect(detectCreateTransfers(input({ rows, accounts }), m, new Set(['x']))).toEqual([]);
    const manualRow = [tx({ id: 'y', account: 'CASH', notes: 'pensión' })];
    expect(detectCreateTransfers(input({ rows: manualRow, accounts }), m, new Set())).toEqual([]);
  });
});

describe('create_transfer: palabras clave y compensación', () => {
  const accounts = [acc({ id: 'A', name: 'BBVA', bankSynced: true }), acc({ id: 'CASH', name: 'Efectivo' })];
  const history = new Map([['cajero', new Set(['CASH'])]]);
  const run = (row: any, targetRows: any[]) =>
    detectCreateTransfers(input({ rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'CAJERO', ...row })], accounts, history, targetRows }), m, new Set());

  it('alta si el historial es único, sin palabra clave y compensado; la razón cita fecha e importe', () => {
    const [p] = run({}, [comp({ date: '2026-10-05' })]);
    expect(p.confidence).toBe('alta');
    expect(p.reason).toContain('2026-10-05');
    expect(p.reason).toContain('-1.00');
  });
  it('dudosa con una palabra clave en las notas; la razón nombra «nómina» y el campo', () => {
    const [p] = run({ notes: 'NÓMINA NOVIEMBRE' }, [comp()]);
    expect(p.confidence).toBe('dudosa');
    expect(p.reason).toContain('nómina');
    expect(p.reason).toContain('notas');
  });
  it('dudosa con beneficiario APPLE.COM/BILL y notas «Factura»', () => {
    const accs = accounts;
    const h = new Map([['apple.com/bill', new Set(['CASH'])]]);
    const [p] = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'APPLE.COM/BILL', notes: 'Factura' })],
      accounts: accs, history: h, targetRows: [comp()],
    }), m, new Set());
    expect(p.confidence).toBe('dudosa');
    expect(p.reason).toContain('factura');
  });
  it('dudosa y reasonNotCompensated(60) si la compensación está a 61 días', () => {
    const [p] = run({}, [comp({ date: '2026-11-15' })]); // 2026-09-15 + 61 días
    expect(p.confidence).toBe('dudosa');
    expect(p.reason).toContain(m.reasonNotCompensated(60));
  });
  it('compensación a exactamente 60 días cuenta', () => {
    expect(run({}, [comp({ date: '2026-11-14' })])[0].confidence).toBe('alta');
  });
  it('una compensación que ya es transferencia cuenta', () => {
    expect(run({}, [comp({ transfer_id: 'tt' })])[0].confidence).toBe('alta');
  });
  it('un importe de signo contrario o de otra cuenta no compensa', () => {
    expect(run({}, [comp({ amount: 100 })])[0].confidence).toBe('dudosa');
    expect(run({}, [comp({ account: 'OTRA' })])[0].confidence).toBe('dudosa');
  });
  it('las propuestas por nombre siguen siendo dudosas aunque estén compensadas', () => {
    const [p] = detectCreateTransfers(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'Pago Efectivo' })], accounts, targetRows: [comp()],
    }), m, new Set());
    expect(p.confidence).toBe('dudosa');
  });
});

describe('findKeyword', () => {
  it('coincide por palabra completa, sin acentos ni mayúsculas', () => {
    expect(findKeyword('Clínica privada')).toBeNull();
    expect(findKeyword('Taxi aeropuerto')).toBeNull();
    expect(findKeyword('Pago IVA 3T')).toBe('iva');
    expect(findKeyword('NÓMINA noviembre')).toBe('nomina');
    expect(findKeyword('Cuota Seguridad   Social')).toBe('seguridad social');
    expect(findKeyword('Seguridad')).toBeNull();
  });
});

describe('findCompensation', () => {
  it('no devuelve la propia fila ni filas de otra cuenta', () => {
    const x = tx({ id: 'x', amount: -100 });
    expect(findCompensation(x, 'CASH', [x])).toBeNull();
    expect(findCompensation(x, 'CASH', [comp()])?.id).toBe('comp');
  });
});

describe('detectAll', () => {
  it('pone primero las de confianza alta', () => {
    const p = detectAll(input({
      rows: [
        tx({ id: 'x' }), tx({ id: 'y1', account: 'B', amount: 100 }), tx({ id: 'y2', account: 'C', amount: 100 }),
        tx({ id: 'imp', account: 'D', amount: -7, imported_id: 'i' }), tx({ id: 'man', account: 'D', amount: -7 }),
      ],
    }), m);
    expect(p[0].confidence).toBe('alta');
    expect(p[0].operation.type).toBe('merge');
    expect(p.slice(1).every((q) => q.confidence === 'dudosa')).toBe(true);
  });
  it('una fusión excluye a sus movimientos de enlaces', () => {
    const p = detectAll(input({
      rows: [tx({ id: 'k', imported_id: 'i' }), tx({ id: 'd' }), tx({ id: 'Y', account: 'B', amount: 100 })],
    }), m);
    expect(p.map((q) => q.operation)).toEqual([{ type: 'merge', keep: 'k', drop: 'd' }]);
  });
  it('una fusión excluye al importado de create_transfer aunque haya historial', () => {
    const p = detectAll(input({
      rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'Traspaso' }), tx({ id: 'd' })],
      accounts: [acc({ id: 'A', name: 'BBVA', bankSynced: true }), acc({ id: 'CASH', name: 'Efectivo' })],
      history: new Map([['traspaso', new Set(['CASH'])]]),
    }), m);
    expect(p.map((q) => q.operation.type)).toEqual(['merge']);
  });
});

describe('clears_category', () => {
  const accs = [
    acc({ id: 'A', name: 'BBVA', bankSynced: true }),
    acc({ id: 'B', name: 'ING', bankSynced: true }),
    acc({ id: 'INV', name: 'Inversión', offbudget: true }),
    acc({ id: 'CASH', name: 'Efectivo' }),
  ];
  it('link entre cuentas del mismo lado con alguna categoría la marca; sin categoría o con lados distintos no', () => {
    const same = detectLinks([tx({ id: 'x', category: 'c1' }), tx({ id: 'y', account: 'B', amount: 100 })], m, accs);
    expect(same[0].clears_category).toBe(true);
    const none = detectLinks([tx({ id: 'x' }), tx({ id: 'y', account: 'B', amount: 100 })], m, accs);
    expect(none[0].clears_category).toBe(false);
    const sides = detectLinks([tx({ id: 'x', category: 'c1' }), tx({ id: 'y', account: 'INV', amount: 100 })], m, accs);
    expect(sides[0].clears_category).toBe(false);
    const bothOff = detectLinks(
      [tx({ id: 'x', account: 'INV', category: 'c1' }), tx({ id: 'y', account: 'INV2', amount: 100 })],
      m, [...accs, acc({ id: 'INV2', name: 'Otra inv', offbudget: true })],
    );
    expect(bothOff[0].clears_category).toBe(true);
  });
  it('create_transfer lo marca si origen y destino están del mismo lado y la fila tiene categoría', () => {
    const base = { accounts: accs, history: new Map([['cajero', new Set(['CASH'])]]), targetRows: [comp()] };
    const withCat = detectCreateTransfers(input({ ...base, rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'CAJERO', category: 'c1' })] }), m, new Set());
    expect(withCat[0].clears_category).toBe(true);
    const noCat = detectCreateTransfers(input({ ...base, rows: [tx({ id: 'x', imported_id: 'i', imported_payee: 'CAJERO' })] }), m, new Set());
    expect(noCat[0].clears_category).toBe(false);
  });
  it('merge nunca limpia la categoría', () => {
    const p = detectMerges([tx({ id: 'imp', imported_id: 'i', category: 'c1' }), tx({ id: 'man', category: 'c2' })], m);
    expect(p[0].clears_category).toBe(false);
  });
  it('detectAll lo propaga a la presentación', async () => {
    const { presentProposal } = await import('../../src/core/reconcile-model.js');
    const [p] = detectAll(input({ rows: [tx({ id: 'x', category: 'c1' }), tx({ id: 'y', account: 'B', amount: 100 })], accounts: accs }), m);
    const out = presentProposal(p, new Map(), 'es-ES', 'EUR');
    expect(out.clears_category).toBe(true);
    expect(out.transactions[0].category).toBe('c1');
  });
});
