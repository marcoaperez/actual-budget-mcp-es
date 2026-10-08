import { describe, it, expect } from 'vitest';
import { detectLinks, detectMerges, detectCreateTransfers, detectAll } from '../../src/core/reconcile-detect.js';
import { toTxRow } from '../../src/core/reconcile-data.js';
import type { AccountInfo, DetectInput } from '../../src/core/reconcile-model.js';
import { messagesFor } from '../../src/core/messages.js';

const m = messagesFor('es');
const tx = (over: any) => toTxRow({ account: 'A', date: '2026-09-15', amount: -100, ...over });
const acc = (over: Partial<AccountInfo>): AccountInfo => ({ id: 'A', name: 'Cuenta', offbudget: false, closed: false, bankSynced: false, ...over });
const input = (over: Partial<DetectInput>): DetectInput => ({ rows: [], accounts: [], history: new Map(), payeeNames: new Map(), ...over });

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
      history: new Map([['cajero 123', new Set(['CASH'])]]),
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
});
