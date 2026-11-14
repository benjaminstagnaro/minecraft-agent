import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { EYE_HEIGHT } from './goals.js';

type Block = NonNullable<ReturnType<Bot['blockAt']>>;

/**
 * Hacia dónde mira una entidad, con la misma convención de ángulos que mineflayer
 * (yaw 0 = mirando al norte, -z; pitch positivo = mirando hacia arriba).
 */
export function viewDirection(yaw: number, pitch: number): Vec3 {
  return new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
}

/**
 * ¿El rayo de la mirada se detiene en este bloque? Las hojas y lo que no tiene colisión
 * (pasto, flores) se atraviesan: si miras un tronco a través de la copa, cuenta el tronco.
 */
export function stopsGaze(block: { name: string; boundingBox: string }): boolean {
  return block.boundingBox === 'block' && !block.name.endsWith('_leaves');
}

/**
 * El bloque que está mirando un jugador (hasta `maxDistance` bloques), o `null` si no lo
 * vemos o mira al cielo. Base de "tala este árbol" (y más adelante "pon esto ahí").
 */
export function blockPlayerLooksAt(bot: Bot, username: string, maxDistance = 32): Block | null {
  const entity = bot.players[username]?.entity;
  if (!entity) return null;
  // La cabeza puede girar sin el cuerpo: si el servidor mandó el giro de cabeza, usar ese.
  const yaw = (entity as { headYaw?: number }).headYaw ?? entity.yaw;
  const eye = entity.position.offset(0, EYE_HEIGHT, 0);
  // El rayo recorre solo las celdas que cruza; un tronco llena su celda entera, así que basta
  // con el tipo de bloque (en bloques chicos como una cerca, puede contar aunque roce el borde).
  const hit = bot.world.raycast(eye, viewDirection(yaw, entity.pitch), maxDistance, stopsGaze);
  // Los tipos de prismarine-world dicen {x, y, z, face}, pero con `matcher` devuelve el bloque
  // completo de getBlock (con `position`, `name`, etc.): ver worldsync.js → raycast().
  return hit as unknown as Block | null;
}
