/**
 * Nombres en español → bloques de Minecraft.
 *
 * Etapa 2: un diccionario chico y explícito para los comandos fijos. En la etapa 3, Claude
 * traducirá el lenguaje natural a IDs, así que esto solo cubre lo más común. También se
 * aceptan los IDs oficiales tal cual (por ejemplo "oak_log").
 */

const LOG_TYPES = [
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'cherry',
  'dark_oak',
  'pale_oak',
  'mangrove',
] as const;

export const ALL_LOGS = LOG_TYPES.map((type) => `${type}_log`);

export interface BlockGroup {
  /** Cómo lo nombramos en el chat. */
  label: string;
  /** Bloques que cuentan (cualquiera de ellos sirve). */
  blocks: string[];
}

// Clave: frase normalizada (minúsculas, sin tildes). Se aceptan singular y plural.
const GROUPS: Record<string, BlockGroup> = {
  troncos: { label: 'troncos', blocks: ALL_LOGS },
  madera: { label: 'troncos', blocks: ALL_LOGS },
  'troncos de roble': { label: 'troncos de roble', blocks: ['oak_log'] },
  'troncos de abeto': { label: 'troncos de abeto', blocks: ['spruce_log'] },
  'troncos de abedul': { label: 'troncos de abedul', blocks: ['birch_log'] },
  'troncos de jungla': { label: 'troncos de jungla', blocks: ['jungle_log'] },
  'troncos de acacia': { label: 'troncos de acacia', blocks: ['acacia_log'] },
  'troncos de cerezo': { label: 'troncos de cerezo', blocks: ['cherry_log'] },
  'troncos de roble oscuro': { label: 'troncos de roble oscuro', blocks: ['dark_oak_log'] },
  'troncos de manglar': { label: 'troncos de manglar', blocks: ['mangrove_log'] },
  tierra: { label: 'tierra', blocks: ['dirt', 'grass_block'] },
  arena: { label: 'arena', blocks: ['sand'] },
  grava: { label: 'grava', blocks: ['gravel'] },
  piedra: { label: 'piedra', blocks: ['stone'] },
  roca: { label: 'piedra', blocks: ['stone'] },
  carbon: { label: 'carbón', blocks: ['coal_ore', 'deepslate_coal_ore'] },
  arcilla: { label: 'arcilla', blocks: ['clay'] },
};

/** Variantes en singular y con "de" opcional: "tronco" → "troncos", etc. */
function candidates(phrase: string): string[] {
  const list = [phrase];
  if (!phrase.endsWith('s')) list.push(`${phrase}s`);
  // "tronco de roble" → "troncos de roble"
  const [first, ...rest] = phrase.split(' ');
  if (first && !first.endsWith('s') && rest.length > 0) list.push([`${first}s`, ...rest].join(' '));
  return list;
}

/**
 * Traduce lo que escribió el jugador a un grupo de bloques.
 * `knownBlock` permite aceptar IDs oficiales que existan en la versión del juego.
 */
export function resolveBlockGroup(
  phrase: string,
  knownBlock: (name: string) => boolean,
): BlockGroup | undefined {
  const text = phrase.trim().toLowerCase();
  for (const candidate of candidates(text)) {
    const group = GROUPS[candidate];
    if (group) return group;
  }
  // ID oficial: "oak_log" o "minecraft:oak_log".
  const id = text.replace(/^minecraft:/, '').replace(/\s+/g, '_');
  if (knownBlock(id)) return { label: id, blocks: [id] };
  return undefined;
}
