// Lanzador del MCP de desarrollo para Claude Code (.mcp.json → actual-dev).
// Se niega a arrancar si no va a hablar con el sandbox local. stdout es el canal MCP:
// los mensajes de error van SOLO a stderr.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDevEnv, checkGuard, forwardSignals, parseEnvFile } from './sandbox-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const devEnvPath = path.join(ROOT, 'dev', '.env');
const devEnvFile = fs.existsSync(devEnvPath) ? parseEnvFile(fs.readFileSync(devEnvPath, 'utf8')) : {};
const env = buildDevEnv(devEnvFile, process.env);

const reason = await checkGuard(env, async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
});
if (reason) {
  console.error(`[actual-dev] ${reason}`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'index.ts')], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
forwardSignals(process, child);
child.on('error', (err) => {
  console.error(`[actual-dev] No se pudo lanzar el MCP: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
