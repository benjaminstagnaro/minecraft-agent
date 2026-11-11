/**
 * Manejo simple de `server.properties` (formato clave=valor de Java).
 * Se edita línea a línea para respetar comentarios, orden y lo que el usuario haya cambiado.
 */

const KEY_VALUE = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/;

export function readProperty(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = KEY_VALUE.exec(line);
    if (match?.[1] === key) return match[2];
  }
  return undefined;
}

/**
 * Mezcla propiedades en un archivo existente:
 *  - `enforced`: se escriben SIEMPRE (son las que protegen la seguridad del proyecto).
 *  - `defaults`: solo se agregan si no existen (el usuario puede cambiarlas después).
 */
export function mergeProperties(
  existing: string,
  enforced: Record<string, string>,
  defaults: Record<string, string>,
): string {
  const seen = new Set<string>();
  const lines = existing === '' ? [] : existing.split(/\r?\n/);

  const merged = lines.map((line) => {
    const match = KEY_VALUE.exec(line);
    const key = match?.[1];
    if (key === undefined) return line;
    seen.add(key);
    return key in enforced ? `${key}=${enforced[key]}` : line;
  });

  // Quitar líneas vacías al final antes de agregar las nuevas.
  while (merged.length > 0 && merged[merged.length - 1]?.trim() === '') merged.pop();

  for (const [key, value] of Object.entries(enforced)) {
    if (!seen.has(key)) merged.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (!seen.has(key) && !(key in enforced)) merged.push(`${key}=${value}`);
  }

  return merged.join('\n') + '\n';
}
