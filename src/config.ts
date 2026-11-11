import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Configuración del agente, leída desde variables de entorno (.env).
 * Se valida al arrancar: si algo está mal, el bot no parte y explica qué corregir.
 */

// Nombres válidos de Minecraft: 3 a 16 caracteres, letras, números o guion bajo.
const MINECRAFT_USERNAME = /^[A-Za-z0-9_]{3,16}$/;

const envSchema = z.object({
  MC_HOST: z.string().min(1).default('127.0.0.1'),
  MC_PORT: z.coerce.number().int().min(1).max(65535).default(25565),
  MC_VERSION: z
    .string()
    .regex(/^\d+\.\d+(\.\d+)?$/, 'debe ser una versión tipo 26.1.2')
    .default('26.1.2'),
  BOT_NAME: z
    .string()
    .regex(MINECRAFT_USERNAME, 'debe tener 3-16 caracteres: letras, números o _')
    .default('Agente'),
  // Texto que debe aparecer en el MOTD del servidor. Así el bot reconoce el servidor
  // de pruebas y se niega a entrar a cualquier otro (por ejemplo un mundo abierto a LAN).
  SERVER_MARKER: z.string().min(3).default('[minecraft-agent]'),
  // Por seguridad el bot solo se conecta a localhost. Esto lo habilita explícitamente.
  ALLOW_REMOTE_SERVER: z.stringbool().default(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface AppConfig {
  server: { host: string; port: number; version: string };
  bot: { name: string };
  safety: { serverMarker: string; allowRemoteServer: boolean };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Valida un objeto tipo `process.env`. Función pura para poder testearla. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  // Una variable vacía en el .env (`MC_HOST=`) se trata como "no definida" para usar el default.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Configuración inválida en .env:\n${problems}`);
  }

  const e = result.data;
  return {
    server: { host: e.MC_HOST, port: e.MC_PORT, version: e.MC_VERSION },
    bot: { name: e.BOT_NAME },
    safety: { serverMarker: e.SERVER_MARKER, allowRemoteServer: e.ALLOW_REMOTE_SERVER },
    logLevel: e.LOG_LEVEL,
  };
}

/** Carga `.env` (si existe) y devuelve la configuración validada. */
export function loadConfig(envFile = '.env'): AppConfig {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseConfig(process.env);
}
