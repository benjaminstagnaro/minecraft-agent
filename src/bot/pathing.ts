import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';

const { Movements } = pathfinderPkg;

type Registry = Bot['registry'];

/**
 * Bloques que se pueden ATRAVESAR (no tienen colisión) pero hacen daño.
 *
 * El pathfinder considera "seguro" cualquier bloque sin colisión, salvo los de su lista
 * `blocksToAvoid`, que por defecto solo trae fuego, telaraña y lava. Sin esto, el bot
 * cruzaba los arbustos de bayas de los bosques de abeto y perdía vida.
 * (Lo encontró Benjamín probando en el juego; ver tests/pathing.test.ts.)
 */
export const HARMFUL_PASSABLE_BLOCKS = [
  'sweet_berry_bush', // pincha y frena
  'wither_rose', // aplica Wither
  'powder_snow', // te hundes y te congelas
  'soul_fire', // quema (el fuego normal ya viene evitado)
] as const;

/** IDs de los bloques dañinos que existen en esta versión de Minecraft. */
export function harmfulBlockIds(registry: Registry): number[] {
  return HARMFUL_PASSABLE_BLOCKS.flatMap((name) => {
    const block = registry.blocksByName[name];
    return block ? [block.id] : [];
  });
}

/**
 * Costo extra por pasar por una casilla vecina a un bloque dañino. El bot mide 0,6 de
 * ancho: aunque la ruta no entre al arbusto, al doblar junto a él lo roza y se pincha
 * (medido en la prueba e2e: la caja del bot se metía 0,25 bloques en el arbusto).
 * Es un costo y no una prohibición: en un bosque lleno de bayas igual encuentra camino,
 * solo que prefiere dar un rodeo de hasta ~5 bloques para no rozarlas.
 */
export const BRUSH_PENALTY = 5;

const NEIGHBORS_8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/** Devuelve el costo extra de pisar `position` según si tiene un bloque dañino al lado. */
export function brushPenalty(
  position: Vec3,
  blockTypeAt: (position: Vec3) => number | undefined,
  harmful: ReadonlySet<number>,
): number {
  for (const [dx, dz] of NEIGHBORS_8) {
    const type = blockTypeAt(position.offset(dx, 0, dz));
    if (type !== undefined && harmful.has(type)) return BRUSH_PENALTY;
  }
  return 0;
}

/**
 * Configuración de movimiento del bot:
 *  - No rompe bloques para abrirse paso (si te sigue a tu casa, no destruye las paredes).
 *  - Corre y hace parkour.
 *  - No atraviesa bloques dañinos y evita pasar rozándolos.
 */
export function createMovements(bot: Bot): InstanceType<typeof Movements> {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowSprinting = true;
  movements.allowParkour = true;

  const harmful = new Set(harmfulBlockIds(bot.registry));
  for (const id of harmful) movements.blocksToAvoid.add(id);

  const blockTypeAt = (position: Vec3): number | undefined => bot.blockAt(position)?.type;
  movements.exclusionAreasStep.push((block) => brushPenalty(block.position, blockTypeAt, harmful));
  return movements;
}
