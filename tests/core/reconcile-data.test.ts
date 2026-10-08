import { describe, it, expect, vi } from 'vitest';
import {
  normalizeText, addDays, daysApart, closeOfDay, todayLocal, toTxRow, loadTxRows, loadAccounts,
  syncedAccountIds, resolveAccount, loadTransferHistory, loadDetectInput,
} from '../../src/core/reconcile-data.js';
import { summarizeTx } from '../../src/core/reconcile-model.js';
import { messagesFor } from '../../src/core/messages.js';
import { mockApi } from '../helpers/mock-api.js';

const m = messagesFor('es');
const acc = (over: any) => ({ id: 'a', name: 'Cuenta', offbudget: false, closed: false, bankSynced: false, ...over });
const row = (over: any) => toTxRow({ id: 't', account: 'a', date: '2026-09-15', amount: -100, ...over });

describe('helpers de texto y fecha', () => {
  it('normalizeText quita acentos, mayúsculas y espacios de los bordes', () => {
    expect(normalizeText('  Ahorro Vivienda ÉLITE ')).toBe('ahorro vivienda elite');
  });
  it('addDays cruza meses y años', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('daysApart es simétrico y en días enteros', () => {
    expect(daysApart('2026-09-15', '2026-09-18')).toBe(3);
    expect(daysApart('2026-09-18', '2026-09-15')).toBe(3);
  });
  it('closeOfDay cae en el día local pedido (getAccountBalance incluye ese día)', () => {
    const d = closeOfDay('2026-09-15');
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 9, 15]);
  });
  it('todayLocal formatea la fecha local', () => {
    expect(todayLocal(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('toTxRow y loadTxRows', () => {
  it('normaliza nulls y booleanos', () => {
    const r = toTxRow({ id: 'x', account: 'a', date: '2026-09-15', amount: 5, reconciled: 1, cleared: 0 });
    expect(r).toEqual({
      id: 'x', account: 'a', date: '2026-09-15', amount: 5, imported_id: null, transfer_id: null,
      reconciled: true, cleared: false, payee: null, imported_payee: null, notes: null,
    });
  });
  it('lee el rango con splits all y descarta padres e hijos de split', async () => {
    const api = mockApi({
      runQuery: async () => ({ data: [
        { id: 'p', account: 'a', date: '2026-09-15', amount: -100, is_parent: true },
        { id: 'c', account: 'a', date: '2026-09-15', amount: -100, is_child: true },
        { id: 's', account: 'a', date: '2026-09-15', amount: -100 },
      ] }),
    });
    const rows = await loadTxRows(api, { start: '2026-09-01', end: '2026-09-30' });
    expect(rows.map((r) => r.id)).toEqual(['s']);
    const q = (api.q as any).mock.results[0].value;
    expect(q.calls.filter[0]).toEqual({ date: { $gte: '2026-09-01', $lte: '2026-09-30' } });
    expect(q.calls.options[0]).toEqual({ splits: 'all' });
  });
});

describe('cuentas', () => {
  it('loadAccounts marca bankSynced cuando el banco rellena balance_current', async () => {
    const api = mockApi({ getAccounts: async () => [
      { id: 'a', name: 'BBVA', balance_current: 1000 },
      { id: 'b', name: 'Efectivo', balance_current: null },
      { id: 'c', name: 'Viejo', closed: true },
    ] });
    const accounts = await loadAccounts(api);
    expect(accounts.map((a) => [a.id, a.bankSynced, a.closed])).toEqual([['a', true, false], ['b', false, false], ['c', false, true]]);
  });
  it('syncedAccountIds añade las cuentas con movimientos importados', () => {
    const ids = syncedAccountIds([acc({ id: 'a', bankSynced: true }), acc({ id: 'b' }), acc({ id: 'c' })], [row({ account: 'c', imported_id: 'imp' })]);
    expect([...ids].sort()).toEqual(['a', 'c']);
  });
  it('resolveAccount acepta el id', () => {
    expect(resolveAccount([acc({ id: 'x1', name: 'BBVA' })], 'x1', m).id).toBe('x1');
  });
  it('resolveAccount acepta el nombre sin importar mayúsculas ni acentos', () => {
    expect(resolveAccount([acc({ id: 'x1', name: 'Ahorro Vivienda' })], 'ahorro vivienda', m).id).toBe('x1');
    expect(resolveAccount([acc({ id: 'x2', name: 'Pensión' })], 'PENSION', m).id).toBe('x2');
  });
  it('resolveAccount falla si el nombre es ambiguo y lista los ids', () => {
    const accounts = [acc({ id: 'x1', name: 'Tarjeta' }), acc({ id: 'x2', name: 'tarjeta' })];
    expect(() => resolveAccount(accounts, 'Tarjeta', m)).toThrow(/x1.*x2/);
  });
  it('resolveAccount falla si no existe y lista las cuentas abiertas', () => {
    const accounts = [acc({ id: 'x1', name: 'BBVA' }), acc({ id: 'x2', name: 'Cerrada', closed: true })];
    let message = '';
    try { resolveAccount(accounts, 'Revolut', m); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/Revolut/);
    expect(message).toMatch(/BBVA/);
    expect(message).not.toMatch(/Cerrada/);
  });
});

describe('historial de transferencias', () => {
  it('agrupa por imported_payee normalizado las cuentas destino', async () => {
    const api = mockApi({ runQuery: async () => ({ data: [
      { imported_payee: 'TRASPASO AHORRO', payee: 'tp-ahorro' },
      { imported_payee: 'traspaso ahorro', payee: 'tp-ahorro' },
      { imported_payee: 'Cajero', payee: 'tp-cash' },
      { imported_payee: 'Otro', payee: 'normal-payee' },
    ] }) });
    const history = await loadTransferHistory(api, new Map([['tp-ahorro', 'acc-ahorro'], ['tp-cash', 'acc-cash']]));
    expect([...history.get('traspaso ahorro')!]).toEqual(['acc-ahorro']);
    expect([...history.get('cajero')!]).toEqual(['acc-cash']);
    expect(history.has('otro')).toBe(false);
  });
});

describe('loadDetectInput', () => {
  it('reúne filas, cuentas, historial y nombres de beneficiario', async () => {
    const api = mockApi({
      getAccounts: async () => [{ id: 'a', name: 'BBVA', balance_current: 1 }],
      getPayees: async () => [{ id: 'p1', name: 'Mercadona' }, { id: 'tp', name: 'BBVA', transfer_acct: 'a' }],
      runQuery: vi.fn(async () => ({ data: [] })),
    });
    const input = await loadDetectInput(api, { start: '2026-09-01', end: '2026-09-30' });
    expect(input.accounts[0].bankSynced).toBe(true);
    expect(input.payeeNames.get('p1')).toBe('Mercadona');
    expect(input.rows).toEqual([]);
    expect(input.history.size).toBe(0);
  });
});

describe('summarizeTx', () => {
  it('usa el nombre del beneficiario, o el importado si no lo hay, y convierte el importe', () => {
    const s = summarizeTx(row({ id: 'x', payee: 'p1', imported_id: 'i', amount: -1234 }), new Map([['p1', 'Mercadona']]), 'es-ES', 'EUR');
    expect(s).toMatchObject({ id: 'x', account_id: 'a', payee: 'Mercadona', imported: true, amount: -12.34 });
    expect(summarizeTx(row({ imported_payee: 'BIZUM' }), new Map(), 'es-ES', 'EUR').payee).toBe('BIZUM');
  });
});
