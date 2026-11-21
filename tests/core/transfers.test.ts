import { describe, it, expect } from 'vitest';
import { sameBudgetSide, transferAccountOfPayee } from '../../src/core/transfers.js';
import { mockApi } from '../helpers/mock-api.js';

describe('sameBudgetSide', () => {
  const accounts = [{ id: 'a', offbudget: false }, { id: 'b', offbudget: 0 }, { id: 'c', offbudget: true }, { id: 'd', offbudget: 1 }];
  it('is true when both are on the same side', () => {
    expect(sameBudgetSide(accounts, 'a', 'b')).toBe(true);
    expect(sameBudgetSide(accounts, 'c', 'd')).toBe(true);
  });
  it('is false when sides differ', () => {
    expect(sameBudgetSide(accounts, 'a', 'c')).toBe(false);
  });
  it('is null when an account is unknown', () => {
    expect(sameBudgetSide(accounts, 'a', 'zz')).toBeNull();
    expect(sameBudgetSide(accounts, 'zz', 'a')).toBeNull();
  });
});

describe('transferAccountOfPayee', () => {
  const api = mockApi({ getPayees: async () => [{ id: 'pt', name: 'T', transfer_acct: 'a2' }, { id: 'p1', name: 'X' }] });
  it('returns the transfer account of a transfer payee', async () => {
    expect(await transferAccountOfPayee(api, 'pt')).toBe('a2');
  });
  it('returns null for ordinary, unknown or null payees', async () => {
    expect(await transferAccountOfPayee(api, 'p1')).toBeNull();
    expect(await transferAccountOfPayee(api, 'nope')).toBeNull();
    expect(await transferAccountOfPayee(api, null)).toBeNull();
  });
});
