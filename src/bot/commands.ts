/**
 * Comandos fijos de la etapa 1 (sin IA). En la etapa 3 el texto libre lo interpretará Claude;
 * estos comandos se mantienen como "atajos" rápidos y gratis.
 */

export type Command =
  | { kind: 'follow' }
  | { kind: 'come' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

type KnownKind = Exclude<Command['kind'], 'unknown'>;

// Frases aceptadas, ya normalizadas (minúsculas, sin tildes ni signos).
const ALIASES: Record<KnownKind, readonly string[]> = {
  follow: ['sigueme', 'seguime', 'sigue me', 'ven conmigo', 'acompaname', 'follow', 'follow me'],
  come: ['ven', 'ven aca', 'ven aqui', 'veni', 'vente', 'come', 'come here'],
  stop: ['para', 'parate', 'detente', 'stop', 'alto', 'quieto', 'quedate ahi', 'quedate aqui'],
  help: ['ayuda', 'help', 'comandos'],
};

// Cortesías que se ignoran para no complicar el match ("sígueme por favor").
const POLITE_WORDS = /\b(por favor|porfa|porfis|pls|please|plis)\b/g;

const COMMAND_BY_PHRASE = new Map<string, KnownKind>(
  Object.entries(ALIASES).flatMap(([kind, phrases]) =>
    phrases.map((phrase) => [phrase, kind as KnownKind] as const),
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
  return kind ? { kind } : { kind: 'unknown', text };
}

export const HELP_TEXT =
  'Comandos: "@bot sígueme", "@bot ven", "@bot para". Pronto entenderé lenguaje natural.';
