/**
 * Comandos fijos (sin IA). En la etapa 3 el texto libre lo interpretará Claude;
 * estos comandos se mantienen como "atajos" rápidos y gratis.
 */

export type Command =
  | { kind: 'follow' }
  | { kind: 'come' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'collect'; count: number; what: string }
  | { kind: 'chop' }
  | { kind: 'craft'; count: number; what: string }
  | { kind: 'place'; what: string; at: [Coordinate, Coordinate, Coordinate] }
  | { kind: 'unknown'; text: string };

/** Una coordenada: absoluta ("12") o relativa al jugador ("~", "~2", "~-1"), como en Minecraft. */
export interface Coordinate {
  relative: boolean;
  value: number;
}

type SimpleKind = 'follow' | 'come' | 'stop' | 'help' | 'status';

// Frases aceptadas, ya normalizadas (minúsculas, sin tildes ni signos).
const ALIASES: Record<SimpleKind, readonly string[]> = {
  follow: ['sigueme', 'seguime', 'sigue me', 'ven conmigo', 'acompaname', 'follow', 'follow me'],
  come: ['ven', 'ven aca', 'ven aqui', 'veni', 'vente', 'come', 'come here'],
  stop: ['para', 'parate', 'detente', 'stop', 'alto', 'quieto', 'quedate ahi', 'quedate aqui'],
  help: ['ayuda', 'help', 'comandos'],
  status: ['estado', 'inventario', 'que tienes', 'como estas', 'status', 'inv'],
};

/** Cantidad por defecto si el jugador no dice cuántos ("@bot junta troncos"). */
export const DEFAULT_COLLECT_COUNT = 10;
/** "@bot craftea un pico" o "@bot craftea pico" → 1. */
export const DEFAULT_CRAFT_COUNT = 1;

const COLLECT_VERBS =
  'junta|juntame|recolecta|recoge|consigue|consigueme|trae|traeme|mina|pica|tala|corta|collect|get';
const CRAFT_VERBS = 'craftea|craftear|crafteame|fabrica|fabricame|haz|hazme|crea|creame|craft|make';

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
  veinte: 20,
};

/**
 * "<verbo> [cantidad] <cosa>": "junta 10 troncos", "craftea un pico de madera",
 * "junta troncos" (sin número → `defaultCount`).
 */
function parseCounted(
  normalized: string,
  verbs: string,
  defaultCount: number,
): { count: number; what: string } | undefined {
  const match = new RegExp(`^(?:${verbs})\\s+(?:(\\d+|[a-z]+)\\s+)?(.+)$`).exec(normalized);
  if (!match) return undefined;
  const [, amount, rest] = match;
  if (!rest) return undefined;

  if (amount === undefined) return { count: defaultCount, what: rest };
  if (/^\d+$/.test(amount)) return { count: Number(amount), what: rest };
  const word = NUMBER_WORDS[amount];
  if (word !== undefined) return { count: word, what: rest };
  // La primera palabra no era un número: es parte del nombre ("junta tierra roja").
  return { count: defaultCount, what: `${amount} ${rest}` };
}

const PLACE_VERBS = 'pon|ponme|coloca|colocame|place|put';
const COORDINATE = String.raw`(~-?\d*|-?\d+)`;
const PLACE_PATTERN = new RegExp(
  String.raw`^(?:${PLACE_VERBS})\s+(?:(?:un|una|el|la)\s+)?(?:bloque\s+de\s+)?(.+?)\s+en\s+` +
    String.raw`${COORDINATE}\s+${COORDINATE}\s+${COORDINATE}$`,
);

export function parseCoordinate(token: string): Coordinate {
  if (token.startsWith('~')) {
    return { relative: true, value: token.length > 1 ? Number(token.slice(1)) : 0 };
  }
  return { relative: false, value: Number(token) };
}

/** Resuelve coordenadas relativas ("~2") respecto de la posición (de bloque) del jugador. */
export function resolveCoordinates(
  at: readonly [Coordinate, Coordinate, Coordinate],
  origin: { x: number; y: number; z: number } | undefined,
): { x: number; y: number; z: number } | undefined {
  if (at.some((c) => c.relative) && !origin) return undefined;
  const base = [origin?.x ?? 0, origin?.y ?? 0, origin?.z ?? 0];
  const [x = 0, y = 0, z = 0] = at.map((c, i) =>
    c.relative ? Math.floor(base[i] ?? 0) + c.value : c.value,
  );
  return { x, y, z };
}

/** "pon tierra en 10 64 -5", "pon un bloque de tierra en ~2 ~ ~". */
function parsePlace(normalized: string): Command | undefined {
  const match = PLACE_PATTERN.exec(normalized);
  if (!match) return undefined;
  const [, what, cx, cy, cz] = match;
  if (!what || cx === undefined || cy === undefined || cz === undefined) return undefined;
  return {
    kind: 'place',
    what,
    at: [parseCoordinate(cx), parseCoordinate(cy), parseCoordinate(cz)],
  };
}

/** "tala este árbol", "corta ese árbol", "tala el árbol que estoy mirando". */
const CHOP_PATTERN =
  /^(?:tala|talame|corta|cortame|chop)\s+(?:(?:este|ese|aquel)\s+arbol|el\s+arbol\s+que\s+(?:estoy\s+mirando|miro))$/;

function parseAction(normalized: string): Command | undefined {
  // Antes que "junta": "tala" también es verbo de recolectar ("tala 5 troncos").
  if (CHOP_PATTERN.test(normalized)) return { kind: 'chop' };
  const place = parsePlace(normalized);
  if (place) return place;
  const collect = parseCounted(normalized, COLLECT_VERBS, DEFAULT_COLLECT_COUNT);
  if (collect) return { kind: 'collect', ...collect };
  const craft = parseCounted(normalized, CRAFT_VERBS, DEFAULT_CRAFT_COUNT);
  if (craft) return { kind: 'craft', ...craft };
  return undefined;
}

// Cortesías que se ignoran para no complicar el match ("sígueme por favor").
const POLITE_WORDS = /\b(por favor|porfa|porfis|pls|please|plis)\b/g;

const COMMAND_BY_PHRASE = new Map<string, SimpleKind>(
  Object.entries(ALIASES).flatMap(([kind, phrases]) =>
    phrases.map((phrase) => [phrase, kind as SimpleKind] as const),
  ),
);

/** Minúsculas, sin tildes, sin signos de puntuación y con espacios simples. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[¡!¿?.,;:"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Si el mensaje está dirigido al bot (empieza con `@bot` o `@<nombre del bot>`),
 * devuelve el texto que sigue. Si no, devuelve `null`.
 */
export function extractMention(message: string, botName: string): string | null {
  const mention = new RegExp(`^\\s*@(?:bot|${escapeRegExp(botName)})(?=$|[\\s,:!])[\\s,:]*`, 'i');
  const match = mention.exec(message);
  if (!match) return null;
  return message.slice(match[0].length).trim();
}

/** Convierte un mensaje de chat en un comando. `null` = el mensaje no era para el bot. */
export function parseCommand(message: string, botName: string): Command | null {
  const text = extractMention(message, botName);
  if (text === null) return null;

  const normalized = normalize(text).replace(POLITE_WORDS, '').replace(/\s+/g, ' ').trim();
  if (normalized === '') return { kind: 'help' };

  const kind = COMMAND_BY_PHRASE.get(normalized);
  if (kind) return { kind };
  return parseAction(normalized) ?? { kind: 'unknown', text };
}

export const HELP_TEXT =
  'Comandos: "@bot sígueme", "@bot ven", "@bot para", "@bot estado", ' +
  '"@bot junta 10 troncos", "@bot tala este árbol" (el que miras), "@bot craftea 4 tablones", ' +
  '"@bot pon tierra en x y z".';
