import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dateRange } from '../../src/core/aql.js';

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('dateRange', () => {
  it('compone dos filtros bajo $and (AQL solo compila el primer operador de un objeto)', () => {
    expect(dateRange('2026-11-01', '2026-11-30')).toEqual({
      $and: [{ date: { $gte: '2026-11-01' } }, { date: { $lte: '2026-11-30' } }],
    });
  });
  it('guarda: ningún objeto de src/ mezcla $gte y $lte en un mismo operador', () => {
    const offenders = tsFiles('src').filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /\{\s*\$gte:[^{}]*\$lte:/.test(s) || /\{\s*\$lte:[^{}]*\$gte:/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});
