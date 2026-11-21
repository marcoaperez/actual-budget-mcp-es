// templates.ts — utilidades de plantillas de presupuesto (#template / #goal) de Actual.
import { activeMessages } from './messages.js';

/** Líneas cuyo texto, desde la primera `#`, empieza por #template o #goal (regla de Actual). */
export function templateLines(note: string | null): string[] {
  if (!note) return [];
  const out: string[] = [];
  for (const line of note.split('\n')) {
    const i = line.indexOf('#');
    if (i < 0) continue;
    const rest = line.slice(i);
    if (rest.startsWith('#template') || rest.startsWith('#goal')) out.push(rest.trimEnd());
  }
  return out;
}

/** Origen de plantillas por categoría: 'ui' ignora las notas; el resto (por defecto) usa notas. */
export async function templateSources(api: any): Promise<Map<string, 'notes' | 'ui'>> {
  const { data } = await api.runQuery(api.q('categories').select(['id', 'template_settings']));
  const map = new Map<string, 'notes' | 'ui'>();
  for (const row of data ?? []) {
    let ts = row.template_settings;
    if (typeof ts === 'string') {
      try { ts = JSON.parse(ts); } catch { ts = null; }
    }
    map.set(row.id, ts?.source === 'ui' ? 'ui' : 'notes');
  }
  return map;
}

/** Llama a un handler interno de loot-core (api.internal es null sin presupuesto abierto). */
export async function sendInternal(api: any, name: string, args: object): Promise<any> {
  // Con `import * as api` (Node ESM sobre un módulo CJS) el export con nombre `internal` es una
  // instantánea tomada al importar (null); la copia viva vive en `default.internal`.
  const internal = api.internal ?? api.default?.internal;
  if (!internal?.send) throw new Error(activeMessages().internalUnavailable);
  return internal.send(name, args);
}
