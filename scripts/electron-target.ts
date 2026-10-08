// El servidor de una extensión .mcpb no corre bajo Node: Claude Desktop lo arranca como
// UtilityProcess de su propio Electron. Hasta better-sqlite3 12 eso obligaba a compilar el
// módulo nativo contra el ABI exacto de ese Electron y a reempaquetar con cada subida mayor.
// better-sqlite3 13 es N-API: un mismo binario carga en cualquier Node o Electron. Aquí vive
// la lógica pura de "¿el binario que viaja es N-API?", leída de la salida de `nm -gU`.

/** Info.plist del Electron Framework de la app instalada, tal y como lo lee `plutil -p`. */
export const CLAUDE_ELECTRON_PLIST =
  '/Applications/Claude.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist';

/** Versión de Electron de Claude Desktop. Solo informativa: el bundle ya no depende de ella. */
export function parseElectronVersion(plutilOutput: string): string | null {
  const match = plutilOutput.match(/"CFBundleVersion"\s*=>\s*"(\d+\.\d+\.\d+)"/);
  return match ? match[1] : null;
}

export type AddonKind = { kind: 'napi' } | { kind: 'abi'; abi: number } | { kind: 'unknown' };

/** Clasifica un .node por sus símbolos exportados (`nm -gU`). */
export function classifyAddon(nmOutput: string): AddonKind {
  if (/\b_?napi_register_module_v1\b/.test(nmOutput)) return { kind: 'napi' };
  const abi = nmOutput.match(/\b_?node_register_module_v(\d+)\b/);
  if (abi) return { kind: 'abi', abi: Number(abi[1]) };
  return { kind: 'unknown' };
}

/** Todos los binarios que viajan deben ser N-API; si no hay ninguno, el bundle no sirve. */
export function checkAddons(addons: { file: string; nm: string }[]): { ok: boolean; detail: string } {
  if (addons.length === 0) {
    return { ok: false, detail: 'no se encontró ningún binario nativo de better-sqlite3' };
  }
  for (const { file, nm } of addons) {
    const kind = classifyAddon(nm);
    if (kind.kind === 'abi') {
      return {
        ok: false,
        detail: `${file} está atado a NODE_MODULE_VERSION ${kind.abi}: no es N-API y fallará con otro Electron`,
      };
    }
    if (kind.kind === 'unknown') {
      return { ok: false, detail: `${file} no exporta ningún símbolo de registro reconocible` };
    }
  }
  return { ok: true, detail: `${addons.length} binario(s) nativo(s) N-API` };
}
