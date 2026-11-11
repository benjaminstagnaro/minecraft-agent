import { styleText } from 'node:util';

/**
 * Logger mínimo y legible: hora, nivel, módulo y mensaje.
 * Sin dependencias: para un bot local no hace falta más.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_COLOR = {
  debug: 'gray',
  info: 'green',
  warn: 'yellow',
  error: 'red',
} as const satisfies Record<LogLevel, string>;

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Defensa extra (regla 2 del proyecto): si algún día una API key termina en un log
 * por error, se enmascara antes de imprimirse.
 */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
}

function formatData(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return ` ${data.message}`;
  if (typeof data === 'string') return ` ${data}`;
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ' [dato no serializable]';
  }
}

function write(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const time = new Date().toLocaleTimeString('es-CL', { hour12: false });
  const line =
    `${styleText('gray', time)} ${styleText(LEVEL_COLOR[level], level.toUpperCase().padEnd(5))} ` +
    `${styleText('cyan', `[${scope}]`)} ${redactSecrets(message + formatData(data))}`;

  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, data?: unknown) => write('debug', scope, message, data),
    info: (message: string, data?: unknown) => write('info', scope, message, data),
    warn: (message: string, data?: unknown) => write('warn', scope, message, data),
    error: (message: string, data?: unknown) => write('error', scope, message, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
