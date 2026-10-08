// Empaqueta el servidor como MCP Bundle (.mcpb) instalable en Claude Desktop.
// Uso: npm run bundle  →  build/actual-budget-mcp-es.mcpb
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_ELECTRON_PLIST,
  parseElectronVersion,
  checkAddons,
} from './electron-target.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const stage = path.join(build, 'stage');
// Binario local en vez de `npx mcpb`: en un clon recién hecho, si `npm run bundle` se
// lanza antes de `npm install`, `npx` descargaría en silencio otra versión del registro.
const mcpb = path.join(root, 'node_modules', '.bin', 'mcpb');

function run(cmd: string, args: string[], cwd = root) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

// 1. Compilar en un dist/ limpio: `tsc` nunca borra lo que ya hay, así que un .js
// huérfano de un fuente renombrado o eliminado sobreviviría y viajaría en el bundle.
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
run('npm', ['run', 'build']);

// 2. Escenario limpio
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 3. Copiar lo que va dentro del bundle (y nada más)
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
for (const file of [
  'manifest.json',
  'package-lock.json',
  'icon.png',
  'README.md',
  'README.es.md',
  'PRIVACY.md',
  'PRIVACY.es.md',
  'LICENSE',
]) {
  fs.copyFileSync(path.join(root, file), path.join(stage, file));
}

// package.json del bundle: sin scripts. `prepare` ejecuta `npm run build`, y npm lo
// lanzaría durante el `npm ci` de abajo — en el escenario no hay ni src/ ni TypeScript.
// Las dependencias nativas (better-sqlite3) SÍ conservan sus scripts de instalación.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete pkg.scripts;
delete pkg.devDependencies;
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// 4. Solo dependencias de producción, con su binario nativo
run('npm', ['ci', '--omit=dev'], stage);
// package-lock.json solo hacía falta para `npm ci`; no viaja en el bundle
fs.rmSync(path.join(stage, 'package-lock.json'), { force: true });

// 5. Módulo nativo: better-sqlite3 13 es N-API, así que el binario que deja `npm ci` sirve
// tal cual para el Electron de Claude Desktop. La versión de Electron solo se informa.
const electron = (() => {
  try {
    return parseElectronVersion(
      execFileSync('plutil', ['-p', CLAUDE_ELECTRON_PLIST], { encoding: 'utf8' }),
    );
  } catch {
    return null; // Claude Desktop no instalado: no impide empaquetar
  }
})();
console.error(`\nElectron de Claude Desktop: ${electron ?? 'no detectado'} (informativo)`);

// 6. Verificar los binarios que realmente viajan: todos deben ser N-API. Un binario atado a
// un NODE_MODULE_VERSION concreto volvería a romperse con la siguiente subida de Electron.
// Solo se comprueban los darwin-*: el `nm` de macOS no sabe leer los PE de win32 (sin símbolos
// se clasificarían como desconocidos y abortaría). Los prebuilds de las demás plataformas
// siguen viajando en el bundle, intactos.
const sqliteDir = path.join(stage, 'node_modules', 'better-sqlite3');
const darwinAddons = (fs.readdirSync(sqliteDir, { recursive: true }) as string[]).filter(
  (rel) => rel.endsWith('.node') && path.basename(rel).startsWith('darwin-'),
);
if (!darwinAddons.some((rel) => path.basename(rel) === 'darwin-arm64.node')) {
  throw new Error('Falta el binario darwin-arm64.node de better-sqlite3 en el bundle.');
}
const addons = darwinAddons.map((rel) => ({
  file: rel,
  nm: execFileSync('nm', ['-gU', path.join(sqliteDir, rel)], { encoding: 'utf8' }),
}));
const check = checkAddons(addons);
if (!check.ok) throw new Error(`El bundle llevaría un binario nativo inservible: ${check.detail}`);
console.error(`Verificado: ${check.detail}`);

// 7. Validar el manifiesto y empaquetar
run(mcpb, ['validate', path.join(stage, 'manifest.json')]);
const out = path.join(build, 'actual-budget-mcp-es.mcpb');
run(mcpb, ['pack', stage, out]);

// 8. Informe
const sizeMb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.error(`\nBundle listo: ${out} (${sizeMb} MB)`);
console.error('Instálalo arrastrándolo a Claude Desktop → Ajustes → Extensiones.');
