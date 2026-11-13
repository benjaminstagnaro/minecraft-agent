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

/**
 * Variantes en singular y plural de la primera palabra:
 * "tronco de roble" ↔ "troncos de roble", "tablon" ↔ "tablones", "picos de madera" → "pico de madera".
 */
function candidates(phrase: string): string[] {
  const [first = '', ...rest] = phrase.split(' ');
  const forms = new Set([first, `${first}s`, `${first}es`]);
  if (first.endsWith('es')) forms.add(first.slice(0, -2));
  if (first.endsWith('s')) forms.add(first.slice(0, -1));
  return [phrase, ...[...forms].map((form) => [form, ...rest].join(' '))];
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

// ───────────────────────────── ítems para craftear ─────────────────────────────

/** Nombre en español de cada tipo de madera (para tablones, troncos, etc.). */
const WOOD_ES: Record<string, string> = {
  oak: 'roble',
  spruce: 'abeto',
  birch: 'abedul',
  jungle: 'jungla',
  acacia: 'acacia',
  cherry: 'cerezo',
  dark_oak: 'roble oscuro',
  pale_oak: 'roble pálido',
  mangrove: 'manglar',
  bamboo: 'bambú',
  crimson: 'carmesí',
  warped: 'distorsionado',
};

export const ALL_PLANKS = Object.keys(WOOD_ES).map((wood) => `${wood}_planks`);

export interface ItemGroup {
  label: string;
  /** Ítems que sirven: se usa el primero que se pueda fabricar con lo que hay. */
  items: string[];
}

const ITEM_GROUPS: Record<string, ItemGroup> = {
  tablones: { label: 'tablones', items: ALL_PLANKS },
  tablas: { label: 'tablones', items: ALL_PLANKS },
  palos: { label: 'palos', items: ['stick'] },
  palitos: { label: 'palos', items: ['stick'] },
  'mesa de crafteo': { label: 'mesa de crafteo', items: ['crafting_table'] },
  'mesa de trabajo': { label: 'mesa de crafteo', items: ['crafting_table'] },
  mesa: { label: 'mesa de crafteo', items: ['crafting_table'] },
  'pico de madera': { label: 'pico de madera', items: ['wooden_pickaxe'] },
  'pico de piedra': { label: 'pico de piedra', items: ['stone_pickaxe'] },
  'hacha de madera': { label: 'hacha de madera', items: ['wooden_axe'] },
  'hacha de piedra': { label: 'hacha de piedra', items: ['stone_axe'] },
  'pala de madera': { label: 'pala de madera', items: ['wooden_shovel'] },
  'pala de piedra': { label: 'pala de piedra', items: ['stone_shovel'] },
  'espada de madera': { label: 'espada de madera', items: ['wooden_sword'] },
  'espada de piedra': { label: 'espada de piedra', items: ['stone_sword'] },
  antorchas: { label: 'antorchas', items: ['torch'] },
  adoquines: { label: 'adoquines', items: ['cobblestone'] },
  vidrio: { label: 'vidrio', items: ['glass'] },
  cofre: { label: 'cofre', items: ['chest'] },
  horno: { label: 'horno', items: ['furnace'] },
};

// "tablones de roble", "tablones de abeto"...: los usa el bot en sus sugerencias de crafteo.
for (const [wood, es] of Object.entries(WOOD_ES)) {
  ITEM_GROUPS[`tablones de ${es}`] = { label: `tablones de ${es}`, items: [`${wood}_planks`] };
}

/** Traduce lo que escribió el jugador a ítems que se pueden fabricar. */
export function resolveItemGroup(
  phrase: string,
  knownItem: (name: string) => boolean,
): ItemGroup | undefined {
  const text = phrase.trim().toLowerCase();
  for (const candidate of candidates(text)) {
    const group = ITEM_GROUPS[candidate];
    if (group) return group;
  }
  const id = text.replace(/^minecraft:/, '').replace(/\s+/g, '_');
  if (knownItem(id)) return { label: id, items: [id] };
  return undefined;
}

const SPANISH_NAMES: Record<string, string> = {
  stick: 'palos',
  crafting_table: 'mesa de crafteo',
  cobblestone: 'adoquines',
  cobbled_deepslate: 'pizarra profunda labrada',
  coal: 'carbón',
  charcoal: 'carbón vegetal',
  iron_ingot: 'lingotes de hierro',
  dirt: 'tierra',
  sand: 'arena',
};

/** Nombre en español para los mensajes ("oak_planks" → "tablones de roble"). */
export function spanishName(name: string): string {
  const known = SPANISH_NAMES[name];
  if (known) return known;
  const wood = /^(.+)_(planks|log)$/.exec(name);
  if (wood?.[1] && WOOD_ES[wood[1]]) {
    return `${wood[2] === 'planks' ? 'tablones' : 'troncos'} de ${WOOD_ES[wood[1]]}`;
  }
  return name.replace(/_/g, ' ');
}
