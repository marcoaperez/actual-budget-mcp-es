import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureServerReady } from '../../test/integration/setup.js';

const execFileAsync = promisify(execFile);

describe('household cleanup tools end to end', () => {
  beforeAll(async () => {
    await ensureServerReady();
  });

  it('every check of household-check.ts passes against a real Actual 26.11.0', async () => {
    const script = fileURLToPath(new URL('./household-check.ts', import.meta.url));
    // Same reason as reset.integration.test.ts: never inherit vitest's NODE_ENV=test.
    const env = { ...process.env, ACTUAL_SERVER_URL: 'http://localhost:5006', ACTUAL_SERVER_PASSWORD: 'test-pass' };
    delete env.NODE_ENV;
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await execFileAsync('npx', ['tsx', script], { env, timeout: 110_000 }));
    } catch (err: any) {
      // Exit code 1 = some check failed: the RESULT line below says which one.
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT='));
    expect(line, `${stdout}\n${stderr}`).toBeTruthy();
    const { checks } = JSON.parse(line!.slice('RESULT='.length)) as { checks: { name: string; ok: boolean; detail: unknown }[] };
    expect(checks.length).toBe(10);
    const failed = checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });
});
