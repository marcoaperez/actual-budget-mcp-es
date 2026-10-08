import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureServerReady } from '../../test/integration/setup.js';

const execFileAsync = promisify(execFile);

describe('reconciliation tools end to end', () => {
  beforeAll(async () => {
    await ensureServerReady();
  });

  it('link + merge + create_transfer, then reconcile and mark', async () => {
    const script = fileURLToPath(new URL('./reconcile-check.ts', import.meta.url));
    // Same reason as reset.integration.test.ts: never inherit vitest's NODE_ENV=test.
    const env = { ...process.env, ACTUAL_SERVER_URL: 'http://localhost:5006', ACTUAL_SERVER_PASSWORD: 'test-pass' };
    delete env.NODE_ENV;
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('npx', ['tsx', script], { env, timeout: 100_000 }));
    } catch (err: any) {
      stdout = err.stdout ?? '';
      throw new Error(`reconcile-check failed:\n${stdout}\n${err.stderr ?? ''}`);
    }
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT='));
    expect(line, stdout).toBeTruthy();
    const result = JSON.parse(line!.slice('RESULT='.length));
    expect([...result.proposals].sort()).toEqual(['create_transfer:dudosa', 'link:alta', 'merge:alta', 'merge:alta']);
    expect(result.statuses).toEqual(['aplicada', 'aplicada', 'aplicada', 'aplicada']);
    expect(result.balances).toEqual({ A: -15000, B: 8500, C: 5000, D: 4000 });
    expect(result.reconcileMatches).toBe(true);
    expect(result.marked).toBe(3);
    expect(result.markedAll).toBe(true);
    expect(result.imported).toEqual(['rc-a1', 'rc-a2', 'rc-b1', 'rc-b2', 'rc-b3']);
    expect(result.linkedImported).toEqual(['rc-a1', 'rc-a2', 'rc-b1', 'rc-b3']);
    expect(result.mutualLinks).toBe(true);
    expect(result.b3LinkedToAhorro).toBe(true);
  });
});
