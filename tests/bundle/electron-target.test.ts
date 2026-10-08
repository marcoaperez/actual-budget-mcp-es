import { describe, it, expect } from 'vitest';
import {
  parseElectronVersion,
  classifyAddon,
  checkAddons,
} from '../../scripts/electron-target.js';

// Salida real de `plutil -p` sobre el Info.plist del Electron Framework de Claude Desktop.
const PLUTIL_OUTPUT = `{
  "CFBundleName" => "Electron Framework"
  "CFBundleVersion" => "42.7.0"
  "CFBundleIdentifier" => "com.github.Electron.framework"
}`;

describe('parseElectronVersion', () => {
  it('extrae la versión de Electron del Info.plist', () => {
    expect(parseElectronVersion(PLUTIL_OUTPUT)).toBe('42.7.0');
  });

  it('devuelve null si el plist no trae CFBundleVersion', () => {
    expect(parseElectronVersion('{\n  "CFBundleName" => "Electron Framework"\n}')).toBeNull();
  });
});


// Salida real de `nm -gU` (macOS antepone "_" a los símbolos C).
const NM_NAPI = `0000000000012340 T _napi_register_module_v1
0000000000098760 T _node_api_module_get_api_version_v1`;
const NM_ABI_146 = `0000000000012340 T _node_register_module_v146`;

describe('classifyAddon', () => {
  it('reconoce un binario N-API', () => {
    expect(classifyAddon(NM_NAPI)).toEqual({ kind: 'napi' });
  });

  it('reconoce un binario atado a un ABI concreto y lee su número', () => {
    expect(classifyAddon(NM_ABI_146)).toEqual({ kind: 'abi', abi: 146 });
  });

  it('devuelve unknown si no hay ningún símbolo de registro', () => {
    expect(classifyAddon('0000000000000001 T _otra_cosa')).toEqual({ kind: 'unknown' });
  });
});

describe('checkAddons', () => {
  it('acepta cuando todos los binarios son N-API', () => {
    const r = checkAddons([
      { file: 'a/darwin-arm64.node', nm: NM_NAPI },
      { file: 'b/linux-x64.node', nm: NM_NAPI },
    ]);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/2/);
  });

  it('rechaza si alguno de varios binarios está atado a un ABI', () => {
    const r = checkAddons([
      { file: 'a/bueno.node', nm: NM_NAPI },
      { file: 'b/viejo.node', nm: NM_ABI_146 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/viejo\.node/);
    expect(r.detail).toMatch(/146/);
  });

  it('rechaza un binario que no se puede clasificar', () => {
    const r = checkAddons([{ file: 'raro.node', nm: '' }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/raro\.node/);
  });

  it('rechaza si no hay ningún binario', () => {
    const r = checkAddons([]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/ningún/);
  });
});
