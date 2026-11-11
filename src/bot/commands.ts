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
  | { kind: 'unknown'; text: string };

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

const COLLECT_VERBS =
  'junta|juntame|recolecta|recoge|consigue|consigueme|trae|traeme|mina|pica|tala|corta|collect|get';

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

const COLLECT_PATTERN = new RegExp(`^(?:${COLLECT_VERBS})\\s+(?:(\\d+|[a-z]+)\\s+)?(.+)$`);

function parseCollect(normalized: string): Command | undefined {
  const match = COLLECT_PATTERN.exec(normalized);
  if (!match) return undefined;
  const [, amount, rest] = match;
  if (!rest) return undefined;

  // "junta 10 troncos" / "junta diez troncos" / "junta troncos" (sin número).
  if (amount === undefined) return { kind: 'collect', count: DEFAULT_COLLECT_COUNT, what: rest };
  if (/^\d+$/.test(amount)) return { kind: 'collect', count: Number(amount), what: rest };
  const word = NUMBER_WORDS[amount];
  if (word !== undefined) return { kind: 'collect', count: word, what: rest };
  // La primera palabra no era un número: es parte del nombre ("junta tierra roja").
  return { kind: 'collect', count: DEFAULT_COLLECT_COUNT, what: `${amount} ${rest}` };
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
  return parseCollect(normalized) ?? { kind: 'unknown', text };
}

export const HELP_TEXT =
  'Comandos: "@bot sígueme", "@bot ven", "@bot para", "@bot estado", ' +
  '"@bot junta 10 troncos" (también tierra, arena, piedra...).';
