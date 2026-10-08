import { describe, it, expect } from 'vitest';
import { tool } from '../../src/tools/mark_reconciled.js';
import { testConfig } from '../helpers/mock-api.js';
import { fakeLedger } from '../helpers/fake-ledger.js';

const accounts = [{ id: 'A', name: 'BBVA Nómina' }, { id: 'B', name: 'ING' }];
const rows = [
  { id: 't1', account: 'A', date: '2026-09-10', amount: 100000 },
  { id: 't2', account: 'A', date: '2026-09-30', amount: 23456, cleared: true },
  { id: 't3', account: 'A', date: '2026-08-01', amount: 0, reconciled: true },
  { id: 'later', account: 'A', date: '2026-10-01', amount: -500 },
  { id: 'other', account: 'B', date: '2026-09-10', amount: 7 },
];

describe('mark_reconciled', () => {
  it('se niega si no cuadra y no escribe nada', async () => {
    const { api } = fakeLedger({ accounts, rows });
    const r: any = await tool.handler({ account: 'bbva nomina', date: '2026-09-30', bank_balance: 1234 }, { api, config: testConfig });
    expect(r.reconciled).toBe(false);
    expect(r.difference.amount).toBe(-0.56);
    expect(r.note).toBeTruthy();
    expect(api.updateTransaction).not.toHaveBeenCalled();
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('si cuadra marca liquidados y conciliados solo los no conciliados de esa cuenta hasta la fecha', async () => {
    const { api, db } = fakeLedger({ accounts, rows });
    const r: any = await tool.handler({ account: 'BBVA Nómina', date: '2026-09-30', bank_balance: 1234.56 }, { api, config: testConfig });
    expect(r.reconciled).toBe(true);
    expect(r.marked_count).toBe(2);
    expect(db.get('t1')).toMatchObject({ cleared: true, reconciled: true });
    expect(db.get('t2')).toMatchObject({ cleared: true, reconciled: true });
    expect(db.get('later').reconciled).toBe(false);
    expect(db.get('other').reconciled).toBe(false);
    // sync inicial (datos frescos) + sync final tras escribir
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('si el sync inicial falla, rechaza sin escribir', async () => {
    const { api } = fakeLedger({ accounts, rows });
    (api.sync as any).mockRejectedValueOnce(new Error('sin red'));
    await expect(
      tool.handler({ account: 'A', date: '2026-09-30', bank_balance: 1234.56 }, { api, config: testConfig }),
    ).rejects.toThrow('sin red');
    expect(api.updateTransaction).not.toHaveBeenCalled();
  });

  it('si un update falla a medias, informa del progreso y sincroniza igualmente', async () => {
    const { api, db } = fakeLedger({ accounts, rows });
    const real = (api.updateTransaction as any).getMockImplementation();
    (api.updateTransaction as any).mockImplementationOnce(real).mockRejectedValueOnce(new Error('boom'));
    const r: any = await tool.handler({ account: 'A', date: '2026-09-30', bank_balance: 1234.56 }, { api, config: testConfig });
    expect(r.reconciled).toBe(false);
    expect(r.marked_count).toBe(1);
    expect(r.failed_id).toBeTruthy();
    expect(r.error).toBe('boom');
    expect(r.note).toBeTruthy();
    expect([...db.values()].filter((x) => x.reconciled && x.id !== 't3')).toHaveLength(1);
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('pide el saldo al cierre del día de la fecha', async () => {
    const { api } = fakeLedger({ accounts, rows });
    await tool.handler({ account: 'A', date: '2026-09-30', bank_balance: 0 }, { api, config: testConfig });
    const cutoff = (api.getAccountBalance as any).mock.calls[0][1] as Date;
    expect([cutoff.getFullYear(), cutoff.getMonth() + 1, cutoff.getDate()]).toEqual([2026, 9, 30]);
  });

  it('cuenta lo verificado: las escrituras que aterrizan tras varias lecturas se esperan', async () => {
    const { api, db } = fakeLedger({ accounts, rows, behaviour: { writesLandAfterReads: 3 } });
    const r: any = await tool.handler({ account: 'A', date: '2026-09-30', bank_balance: 1234.56 }, { api, config: testConfig });
    expect(r.reconciled).toBe(true);
    expect(r.marked_count).toBe(2);
    expect(r.pending_ids).toBeUndefined();
    expect(db.get('t1').reconciled).toBe(true);
    expect(db.get('t2').reconciled).toBe(true);
    // el sync final va después del sondeo
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('si alguna escritura nunca aterriza, devuelve reconciled:false con pending_ids y nota', async () => {
    const { api } = fakeLedger({ accounts, rows, behaviour: { writesLandAfterReads: 2, neverLandIds: ['t2'] } });
    const r: any = await tool.handler({ account: 'A', date: '2026-09-30', bank_balance: 1234.56 }, { api, config: testConfig });
    expect(r.reconciled).toBe(false);
    expect(r.marked_count).toBe(1);
    expect(r.pending_ids).toEqual(['t2']);
    expect(r.note).toMatch(/seguro volver a ejecutar/);
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('es una tool de escritura', () => {
    expect(tool.readOnly).toBe(false);
  });
});
