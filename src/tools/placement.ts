import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { abortable } from './abort.js';

type Block = NonNullable<ReturnType<Bot['blockAt']>>;

/** Bloques que se pueden "pisar" al colocar (aire, pasto alto, etc.). */
export function isReplaceable(block: Block | null): boolean {
  if (!block) return false;
  return block.boundingBox === 'empty' && !['water', 'lava'].includes(block.name);
}

/** ¿La caja del jugador (0,6 x 1,8) se cruza con el bloque en `cell`? */
export function overlapsPlayer(cell: Vec3, player: Vec3): boolean {
  const separatedX = cell.x >= player.x + 0.3 || cell.x + 1 <= player.x - 0.3;
  const separatedZ = cell.z >= player.z + 0.3 || cell.z + 1 <= player.z - 0.3;
  const separatedY = cell.y >= player.y + 1.8 || cell.y + 1 <= player.y;
  return !(separatedX || separatedY || separatedZ);
}

// Orden de preferencia: a 2 bloques en línea recta y luego en diagonal.
const SPOT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
  [1, 2],
  [-1, 2],
  [1, -2],
  [-1, -2],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Busca una celda libre cerca del bot, con suelo sólido debajo, donde poner un bloque
 * sin quedar encima de él mismo.
 */
export function findFreeSpotNear(bot: Bot): { position: Vec3; ground: Block } | undefined {
  const feet = bot.entity.position.floored();
  for (const [dx, dz] of SPOT_OFFSETS) {
    for (const dy of [0, 1, -1]) {
      const position = feet.offset(dx, dy, dz);
      const ground = bot.blockAt(position.offset(0, -1, 0));
      if (!ground || ground.boundingBox !== 'block') continue;
      if (!isReplaceable(bot.blockAt(position))) continue;
      if (overlapsPlayer(position, bot.entity.position)) continue;
      return { position, ground };
    }
  }
  return undefined;
}

/**
 * Dónde buscar apoyo para un bloque nuevo, en orden de preferencia: el suelo, los costados y
 * el techo. Cada entrada es el desplazamiento desde la celda objetivo hasta el bloque de apoyo.
 */
const SUPPORT_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
];

/**
 * En Minecraft un bloque se pone "contra" la cara de otro bloque sólido. Devuelve el
 * desplazamiento desde `target` hasta un bloque de apoyo, o undefined si está flotando.
 */
export function findSupportOffset(
  target: { x: number; y: number; z: number },
  isSolidAt: (x: number, y: number, z: number) => boolean,
): readonly [number, number, number] | undefined {
  return SUPPORT_OFFSETS.find(([dx, dy, dz]) =>
    isSolidAt(target.x + dx, target.y + dy, target.z + dz),
  );
}

/**
 * Pone el ítem `itemName` contra la cara `face` del bloque `reference` y verifica que quedó
 * puesto en `reference + face`.
 */
export async function placeAgainst(
  bot: Bot,
  itemName: string,
  reference: Block,
  face: Vec3,
  signal: AbortSignal,
): Promise<Block> {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new Error(`no tengo ${itemName} para poner`);
  await bot.equip(item, 'hand');
  await abortable(bot.placeBlock(reference, face), signal, {
    timeoutMs: 5_000,
    what: `poner ${itemName}`,
  });
  const placed = bot.blockAt(reference.position.plus(face));
  if (placed?.name !== itemName) throw new Error(`no quedó puesto ${itemName}`);
  return placed;
}

/** Pone el ítem encima de `ground` (por ejemplo, la mesa de crafteo). */
export function placeOnTop(
  bot: Bot,
  itemName: string,
  ground: Block,
  signal: AbortSignal,
): Promise<Block> {
  return placeAgainst(bot, itemName, ground, new Vec3(0, 1, 0), signal);
}
