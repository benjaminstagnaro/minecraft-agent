import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';

/**
 * Protecciones de la regla 1 del proyecto: el bot NUNCA debe entrar a un mundo real
 * (en particular "Miami extremo", que es hardcore). Hay tres capas:
 *
 *  1. Solo hosts locales, salvo que se habilite explícitamente (ALLOW_REMOTE_SERVER).
 *  2. Antes de conectarse hace "ping" y exige que el MOTD tenga la marca del servidor
 *     de pruebas. Un mundo abierto a LAN o cualquier otro servidor no la tiene.
 *  3. Al hacer login, si el mundo es hardcore se desconecta de inmediato (ver agentBot.ts).
 */

export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Aplana el MOTD (texto plano o componente de chat JSON) y quita códigos de color `§x`. */
export function motdToPlainText(description: unknown): string {
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as { text?: unknown; translate?: unknown; extra?: unknown };
      if (typeof obj.text === 'string') parts.push(obj.text);
      else if (typeof obj.translate === 'string') parts.push(obj.translate);
      walk(obj.extra);
    }
  };

  walk(description);
  return parts.join('').replace(/§[0-9a-fk-or]/gi, '');
}

/**
 * ¿El paquete de login indica un mundo hardcore?
 *
 * Ojo: no basta con `bot.game.hardcore`. En 26.1 el campo `isHardcore` viene en la raíz del
 * paquete de login, pero mineflayer 4.39 lo busca dentro de `worldState`, así que
 * `bot.game.hardcore` queda siempre en `false`. Por eso revisamos el paquete crudo.
 */
export function isHardcoreLogin(packet: unknown): boolean {
  if (typeof packet !== 'object' || packet === null) return false;
  const p = packet as { isHardcore?: unknown; worldState?: { isHardcore?: unknown } };
  return p.isHardcore === true || p.worldState?.isHardcore === true;
}

export type ServerCheck =
  | { ok: true; motd: string; serverVersion: string; protocol: number }
  | { ok: false; reason: string };

interface VerifyOptions {
  host: string;
  port: number;
  marker: string;
  expectedVersion: string;
  timeoutMs?: number;
}

/** Hace ping al servidor y verifica que sea el servidor de pruebas y la versión correcta. */
export async function verifyTestServer(options: VerifyOptions): Promise<ServerCheck> {
  const { host, port, marker, expectedVersion, timeoutMs = 5000 } = options;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${timeoutMs} ms`)), timeoutMs);
  });

  let result: Awaited<ReturnType<typeof minecraftProtocol.ping>>;
  try {
    result = await Promise.race([minecraftProtocol.ping({ host, port }), timeout]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `No pude contactar el servidor en ${host}:${port} (${detail}). ¿Está encendido? (npm run server:start)`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!('description' in result)) {
    return {
      ok: false,
      reason: 'El servidor respondió con un formato antiguo: no es el de pruebas.',
    };
  }

  const motd = motdToPlainText(result.description);
  if (!motd.includes(marker)) {
    return {
      ok: false,
      reason:
        `El servidor en ${host}:${port} no es el servidor de pruebas (su MOTD "${motd}" no ` +
        `contiene "${marker}"). Por seguridad no me conecto.`,
    };
  }

  const expectedProtocol = minecraftData(expectedVersion)?.version.version;
  if (expectedProtocol !== undefined && result.version.protocol !== expectedProtocol) {
    return {
      ok: false,
      reason:
        `El servidor usa ${result.version.name} (protocolo ${result.version.protocol}) pero el bot ` +
        `está configurado para ${expectedVersion} (protocolo ${expectedProtocol}). Revisa MC_VERSION.`,
    };
  }

  return { ok: true, motd, serverVersion: result.version.name, protocol: result.version.protocol };
}
