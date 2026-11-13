import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { createWorkMovements, SAFE_DROP } from '../bot/pathing.js';
import { digBlock, gotoGoal, isAbortError, throwIfAborted, wait } from './abort.js';
import { GoalDigFrom, GoalWithinReach } from './goals.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const { goals } = pathfinderPkg;

type Block = NonNullable<ReturnType<Bot['blockAt']>>;

const SEARCH_RADIUS = 48;
const MAX_CONSECUTIVE_FAILURES = 4;
const MAX_TREE_HEIGHT = 32;
/** Máximo de troncos que consideramos parte de un mismo árbol (los robles oscuros son grandes). */
const MAX_TREE_BLOCKS = 128;
/** Recargo por abrirse paso por hojas: equivale a caminar ~8 bloques más. */
const LEAF_PENALTY = 8;

// ─────────────────────────── lógica pura (testeable) ───────────────────────────

/** Lo mínimo que necesitamos saber de un bloque para decidir. */
export interface BlockInfo {
  name: string;
  /** Propiedades de estado, ej: { persistent: false } en las hojas. */
  properties: Record<string, unknown>;
}

export type BlockLookup = (x: number, y: number, z: number) => BlockInfo | undefined;

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

export interface DigHazard {
  kind: 'lava' | 'fall';
  message: string;
}

const FACES_6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/**
 * ¿Es peligroso picar `target` desde donde está el bot (`feet` = posición exacta de sus pies)?
 *  - Lava al lado: al abrir el hueco, la lava fluye hacia el bot.
 *  - Parado encima: al picarlo se cae; si la caída es de más de SAFE_DROP bloques, se lastima
 *    (pasó al talar la punta de un abeto: cayó ~5 bloques y perdió 3 de vida).
 */
export function digHazard(
  target: { x: number; y: number; z: number },
  feet: { x: number; y: number; z: number },
  nameAt: (x: number, y: number, z: number) => string | undefined,
  isSolidAt: (x: number, y: number, z: number) => boolean,
): DigHazard | undefined {
  for (const [dx, dy, dz] of FACES_6) {
    if (nameAt(target.x + dx, target.y + dy, target.z + dz) === 'lava') {
      return { kind: 'lava', message: 'tiene lava al lado' };
    }
  }

  // Su caja (0,6 de ancho) está sobre el bloque y sus pies justo encima.
  const overX = feet.x + 0.3 > target.x && feet.x - 0.3 < target.x + 1;
  const overZ = feet.z + 0.3 > target.z && feet.z - 0.3 < target.z + 1;
  const standsOn = overX && overZ && Math.floor(feet.y) - 1 === target.y;
  if (standsOn) {
    let ground = target.y - 1;
    while (ground > target.y - 64 && !isSolidAt(target.x, ground, target.z)) ground--;
    const drop = target.y - ground;
    if (drop > SAFE_DROP) {
      return { kind: 'fall', message: `estoy parado encima y me caería ${drop} bloques` };
    }
  }
  return undefined;
}

interface Point {
  x: number;
  y: number;
  z: number;
}

/** Celdas bajo los pies que toca la caja del bot (0,6 de ancho): de 1 a 4 bloques. */
export function cellsUnderFeet(feet: Point): Point[] {
  const y = Math.floor(feet.y) - 1;
  const span = (v: number): number[] => {
    const lo = Math.floor(v - 0.3 + 1e-3);
    const hi = Math.floor(v + 0.3 - 1e-3);
    return lo === hi ? [lo] : [lo, hi];
  };
  return span(feet.x).flatMap((x) => span(feet.z).map((z) => ({ x, y, z })));
}

/**
 * Para bajar de un pilar de andamio propio (lo arma el pathfinder para alcanzar la punta de
 * un árbol alto): qué bloques picar bajo los pies para bajar, o `undefined` si no corresponde.
 *
 * Solo baja si está parado sobre al menos un bloque propio; además puede picar hojas naturales
 * que también lo sostengan. Nunca si la caída resultante supera SAFE_DROP.
 */
export function scaffoldToClear(
  feet: Point,
  isOwn: (x: number, y: number, z: number) => boolean,
  isClearable: (x: number, y: number, z: number) => boolean,
  isSolidAt: (x: number, y: number, z: number) => boolean,
): Point[] | undefined {
  const support = cellsUnderFeet(feet).filter(({ x, y, z }) => isSolidAt(x, y, z));
  if (!support.some(({ x, y, z }) => isOwn(x, y, z))) return undefined;
  if (!support.every(({ x, y, z }) => isOwn(x, y, z) || isClearable(x, y, z))) return undefined;

  // Dónde aterrizaría: el bloque sólido más alto bajo cualquiera de las columnas de los pies.
  let landing = -Infinity;
  for (const { x, y, z } of cellsUnderFeet(feet)) {
    let ground = y - 1;
    while (ground > y - 64 && !isSolidAt(x, ground, z)) ground--;
    landing = Math.max(landing, ground);
  }
  const drop = Math.floor(feet.y) - (landing + 1);
  return drop <= SAFE_DROP ? support : undefined;
}

/** Las 26 posiciones vecinas (incluye diagonales: las ramas de la acacia van en diagonal). */
export function neighbors26(x: number, y: number, z: number): [number, number, number][] {
  const list: [number, number, number][] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx !== 0 || dy !== 0 || dz !== 0) list.push([x + dx, y + dy, z + dz]);
      }
    }
  }
  return list;
}

/**
 * Bloques objetivo conectados a `seeds` (búsqueda en anchura con 26 vecinos): "lo que queda
 * del árbol". Claves "x,y,z". Se corta en `limit` para no recorrer un bosque entero.
 */
export function connectedBlocks(
  seeds: ReadonlyArray<readonly [number, number, number]>,
  isTarget: (x: number, y: number, z: number) => boolean,
  limit = MAX_TREE_BLOCKS,
): Set<string> {
  const found = new Set<string>();
  const queue = seeds.filter(([x, y, z]) => isTarget(x, y, z));
  for (const [x, y, z] of queue) found.add(key(x, y, z));
  while (queue.length > 0 && found.size < limit) {
    const [x, y, z] = queue.shift()!;
    for (const [nx, ny, nz] of neighbors26(x, y, z)) {
      const k = key(nx, ny, nz);
      if (!found.has(k) && isTarget(nx, ny, nz)) {
        found.add(k);
        queue.push([nx, ny, nz]);
      }
    }
  }
  return found;
}

interface Positioned {
  position: { x: number; y: number; z: number; distanceTo(other: unknown): number };
}

/**
 * Elige el siguiente bloque: primero los del árbol que está talando (de abajo hacia arriba,
 * como un jugador), y solo cuando lo termina, el más cercano.
 */
export function pickNextTarget<T extends Positioned>(
  candidates: readonly T[],
  here: unknown,
  currentTree: ReadonlySet<string>,
): T | undefined {
  const inTree = (c: T): boolean => currentTree.has(key(c.position.x, c.position.y, c.position.z));
  const fromTree = candidates.filter(inTree);
  if (fromTree.length > 0) {
    return [...fromTree].sort(
      (a, b) =>
        a.position.y - b.position.y || a.position.distanceTo(here) - b.position.distanceTo(here),
    )[0];
  }
  return [...candidates].sort(
    (a, b) => a.position.distanceTo(here) - b.position.distanceTo(here),
  )[0];
}

/** Claves de las posiciones candidatas en la misma columna (x, z): el "árbol" completo. */
export function positionsInColumn(
  x: number,
  z: number,
  positions: ReadonlyArray<{ x: number; z: number; toString(): string }>,
): string[] {
  return positions.filter((p) => p.x === x && p.z === z).map((p) => p.toString());
}

export const isLogName = (name: string): boolean =>
  name.endsWith('_log') && !name.startsWith('stripped_');
export const isLeavesName = (name: string): boolean => name.endsWith('_leaves');

/** Hojas generadas por el mundo (no puestas por un jugador). */
export function isNaturalLeaves(block: BlockInfo | undefined): boolean {
  return block !== undefined && isLeavesName(block.name) && block.properties.persistent === false;
}

/**
 * ¿Este tronco es parte de un árbol natural?
 *
 * Minecraft marca con `persistent=true` las hojas que pone un jugador. Así que subimos por la
 * columna de troncos y buscamos hojas NO persistentes alrededor de la copa. Si no hay, el
 * tronco probablemente es parte de una construcción (una casa, una cerca) y no se toca.
 */
export function isNaturalLog(x: number, y: number, z: number, blockAt: BlockLookup): boolean {
  let top = y;
  while (top - y < MAX_TREE_HEIGHT) {
    const above = blockAt(x, top + 1, z);
    if (!above || !isLogName(above.name)) break;
    top++;
  }
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (isNaturalLeaves(blockAt(x + dx, top + dy, z + dz))) return true;
      }
    }
  }
  return false;
}

// ───────────────────────────────── herramienta ─────────────────────────────────

const input = z.object({
  blocks: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('IDs de bloque de Minecraft que sirven, ej: ["oak_log"] o todos los troncos'),
  count: z.number().int().min(1).max(64).describe('Cuántos ítems conseguir'),
  label: z.string().optional().describe('Nombre para mostrar en el chat, ej: "troncos"'),
});

export const collectBlockTool: Tool<typeof input> = {
  name: 'collect_block',
  description:
    'Busca bloques cercanos (radio 48), camina hasta ellos, los pica con la mejor herramienta ' +
    'disponible y recoge lo que sueltan, hasta conseguir `count` ítems. Solo tala troncos de ' +
    'árboles naturales (nunca de construcciones). Falla con explicación si no hay más bloques, ' +
    'si falta la herramienta adecuada (ej: pico para piedra) o si el inventario está lleno.',
  input,
  timeoutMs: 5 * 60_000,
  run: collect,
};

async function collect(ctx: ToolContext, args: z.infer<typeof input>): Promise<ToolResult> {
  const { bot, signal, log } = ctx;
  const label = args.label ?? args.blocks.join(', ');

  const unknown = args.blocks.filter((name) => !bot.registry.blocksByName[name]);
  if (unknown.length > 0)
    return { ok: false, message: `No conozco el bloque: ${unknown.join(', ')}.` };

  const targets = args.blocks.map((name) => bot.registry.blocksByName[name]!);
  const targetIds = new Set(targets.map((b) => b.id));
  // Lo que sueltan (piedra → adoquín, pasto → tierra). Si no suelta nada, contamos el mismo ítem.
  const dropIds = new Set(
    targets.flatMap((b) => {
      const drops = (b.drops as number[] | undefined) ?? [];
      const sameItem = bot.registry.itemsByName[b.name]?.id;
      return drops.length > 0 ? drops : sameItem !== undefined ? [sameItem] : [];
    }),
  );
  const countDrops = (): number =>
    bot.inventory.items().reduce((sum, item) => sum + (dropIds.has(item.type) ? item.count : 0), 0);

  const lookup: BlockLookup = (x, y, z) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block ? { name: block.name, properties: block.getProperties() } : undefined;
  };

  const isNatural = (block: Block): boolean =>
    !isLogName(block.name) ||
    isNaturalLog(block.position.x, block.position.y, block.position.z, lookup);

  // Mientras trabaja puede romper en el camino solo hojas naturales y bloques objetivo naturales.
  // Las hojas tienen recargo: prefiere rodear el árbol a abrirse paso por la copa.
  const isLeaves = (block: Block): boolean =>
    isNaturalLeaves({ name: block.name, properties: block.getProperties() });
  // Bloques que el bot pone como andamio durante la tarea (si tiene tierra o adoquines, el
  // pathfinder arma un pilar para alcanzar la punta de un árbol alto). Puede volver a picarlos,
  // como un jugador que baja picando su pilar; si no, queda atrapado arriba (pasó en la prueba).
  const placedByMe = new Set<string>();
  const isOwn = (x: number, y: number, z: number): boolean => placedByMe.has(key(x, y, z));
  const previousMovements = bot.pathfinder.movements;
  const workMovements = createWorkMovements(
    bot,
    (block) =>
      isLeaves(block) ||
      isOwn(block.position.x, block.position.y, block.position.z) ||
      (targetIds.has(block.type) && isNatural(block)),
    (block) => (isLeaves(block) ? LEAF_PENALTY : 0),
  );
  bot.pathfinder.setMovements(workMovements);

  const scaffoldNames = new Set(
    // (sic: el pathfinder lo escribe con una sola "f")
    workMovements.scafoldingBlocks.map((id) => bot.registry.items[id]?.name),
  );
  // No hay evento "el pathfinder puso un bloque": se toma como propio un bloque de andamio que
  // aparece en una celda vacía pegada al bot mientras trabaja.
  const onBlockUpdate = (oldBlock: Block | null, newBlock: Block | null): void => {
    if (!newBlock || !scaffoldNames.has(newBlock.name)) return;
    if (oldBlock?.boundingBox === 'block') return;
    if (newBlock.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position) > 2.5) return;
    const { x, y, z } = newBlock.position;
    placedByMe.add(key(x, y, z));
    log.debug(`Andamio propio en ${x},${y},${z}`);
  };
  bot.on('blockUpdate', onBlockUpdate);

  const start = countDrops();
  const gained = (): number => countDrops() - start;
  const failed = new Set<string>();
  let consecutiveFailures = 0;
  let checkedHarvest = false;
  // Troncos que quedan del árbol que está talando: se terminan antes de pasar a otro, para no
  // dejar árboles a medias con troncos flotando (lo reportó Benjamín probando en el juego).
  let currentTree = new Set<string>();
  const nameAt = (x: number, y: number, z: number): string | undefined =>
    bot.blockAt(new Vec3(x, y, z))?.name;
  const isSolidAt = (x: number, y: number, z: number): boolean =>
    bot.blockAt(new Vec3(x, y, z))?.boundingBox === 'block';
  const isLeavesAt = (x: number, y: number, z: number): boolean => isNaturalLeaves(lookup(x, y, z));
  const isTargetAt = (x: number, y: number, z: number): boolean => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block !== null && targetIds.has(block.type);
  };

  try {
    while (gained() < args.count) {
      throwIfAborted(signal);
      if (bot.inventory.emptySlotCount() === 0) {
        return {
          ok: false,
          message: `Tengo el inventario lleno. Junté ${gained()} ${label}.`,
          data: { gained: gained() },
        };
      }

      // Candidatos: los más cercanos que no hayan fallado y que no sean de construcciones.
      const positions = bot.findBlocks({
        matching: [...targetIds],
        maxDistance: SEARCH_RADIUS,
        count: 128,
      });
      let skippedBuilt = 0;
      const candidates: Block[] = [];
      for (const pos of positions) {
        if (failed.has(pos.toString())) continue;
        const block = bot.blockAt(pos);
        if (!block) continue;
        if (!isNatural(block)) {
          skippedBuilt++;
          continue;
        }
        candidates.push(block);
      }
      const here = bot.entity.position;
      const target = pickNextTarget(candidates, here, currentTree);

      if (!target) {
        const built =
          skippedBuilt > 0
            ? ` (vi ${skippedBuilt} que parecen de una construcción y no los toqué)`
            : '';
        return {
          ok: false,
          message: `Junté ${gained()} de ${args.count} ${label}: no encuentro más cerca${built}.`,
          data: { gained: gained(), skippedBuilt },
        };
      }

      // ¿Puedo cosecharlo con lo que tengo? (ej: piedra sin pico no suelta nada)
      if (!checkedHarvest) {
        const tool = bot.pathfinder.bestHarvestTool(target);
        if (!target.canHarvest(tool?.type ?? null)) {
          return {
            ok: false,
            message: `Para juntar ${label} necesito una herramienta adecuada (ej: un pico) y no tengo.`,
          };
        }
        checkedHarvest = true;
      }

      try {
        const t0 = Date.now();
        // Siempre desde un costado: nunca parado encima de lo que va a picar.
        await gotoGoal(bot, new GoalDigFrom(target.position), signal, 30_000);
        const t1 = Date.now();
        const fresh = bot.blockAt(target.position);
        if (!fresh || !targetIds.has(fresh.type)) continue; // alguien más lo picó
        if (!bot.canDigBlock(fresh)) throw new Error('no alcanzo a picarlo desde aquí');

        // Última revisión de seguridad antes de picar.
        let hazard = digHazard(fresh.position, bot.entity.position, nameAt, isSolidAt);
        if (hazard?.kind === 'fall') {
          // Puede estar en la celda de al lado pero con el borde del cuerpo encima: centrarse.
          const cell = bot.entity.position.floored();
          await gotoGoal(bot, new goals.GoalBlock(cell.x, cell.y, cell.z), signal, 5_000);
          hazard = digHazard(fresh.position, bot.entity.position, nameAt, isSolidAt);
        }
        if (hazard) throw new Error(`no lo pico por seguridad: ${hazard.message}`);

        const tool = bot.pathfinder.bestHarvestTool(fresh);
        if (tool) await bot.equip(tool, 'hand');
        // En el aire se pica 5 veces más lento (regla de Minecraft): 15 s por tronco en vez de 3.
        await settle(bot, signal);
        const t2 = Date.now();
        const me = bot.entity;
        log.debug(
          `Pico ${fresh.position.toString()} desde ${me.position.toString()} ` +
            `(enSuelo=${String(me.onGround)}, tiempo estimado ${bot.digTime(fresh)} ms)`,
        );
        await digBlock(bot, fresh, signal);
        const t3 = Date.now();
        await pickUpDrops(ctx, fresh.position, dropIds, isLeavesAt, isSolidAt);
        const t4 = Date.now();

        consecutiveFailures = 0;
        // Lo que queda conectado a este tronco es "el árbol actual".
        const { x, y, z } = fresh.position;
        currentTree = connectedBlocks(neighbors26(x, y, z), isTargetAt);
        log.info(
          `Llevo ${gained()}/${args.count} ${label} (${fresh.name} en ${x},${y},${z}; ` +
            `quedan ${currentTree.size} en este árbol)`,
        );
        log.debug(
          `Tiempos: caminar ${t1 - t0} ms, revisar ${t2 - t1} ms, picar ${t3 - t2} ms, ` +
            `recoger ${t4 - t3} ms`,
        );
        // Árbol terminado: bajar del andamio antes de seguir (no dejar pilares ni quedar arriba).
        if (currentTree.size === 0) await climbDown(ctx, isOwn, isLeavesAt, isSolidAt, placedByMe);
      } catch (error) {
        if (isAbortError(error)) throw error;
        failed.add(target.position.toString());
        consecutiveFailures++;
        // Descartar el árbol completo (toda la columna), no solo este tronco: si no llego a
        // uno, tampoco llegaré a los de arriba. Así los intentos se gastan en árboles distintos.
        for (const pos of positionsInColumn(target.position.x, target.position.z, positions)) {
          failed.add(pos);
        }
        const here = bot.entity.position;
        log.warn(
          `No pude con ${target.name} en ${target.position.toString()} ` +
            `(yo en ${here.floored().toString()}, enSuelo=${String(bot.entity.onGround)})`,
          error,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return {
            ok: false,
            message: `Junté ${gained()} de ${args.count} ${label}: no logro llegar a los que quedan.`,
            data: { gained: gained() },
          };
        }
      }
    }

    return {
      ok: true,
      message: `Listo: junté ${gained()} ${label}.`,
      data: { gained: gained(), total: countDrops() },
    };
  } finally {
    // Termine como termine (salvo que lo hayan cancelado con "para"), no quedar sobre un pilar.
    if (!signal.aborted && placedByMe.size > 0) {
      await climbDown(ctx, isOwn, isLeavesAt, isSolidAt, placedByMe).catch((error: unknown) =>
        log.warn('No pude bajar del andamio', error),
      );
    }
    bot.off('blockUpdate', onBlockUpdate);
    if (previousMovements) bot.pathfinder.setMovements(previousMovements);
  }
}

type At = (x: number, y: number, z: number) => boolean;

/**
 * Espera a que el pathfinder termine lo que está haciendo y el bot pise suelo. Ojo:
 * `pathfinder.stop()` no frena en seco; termina el movimiento en curso (ej: saltar y poner
 * un bloque del pilar), que se cruzaba con lo siguiente que hacía el bot.
 */
async function settle(bot: Bot, signal: AbortSignal, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = bot.pathfinder.isMoving() || bot.pathfinder.isBuilding();
    if (!busy && bot.entity.onGround) return;
    await wait(100, signal);
  }
}

/**
 * Baja de su pilar de andamio picando el bloque bajo los pies, de a uno (cada caída es de
 * 1 bloque). Se detiene en cuanto ya no está parado sobre un bloque propio.
 */
async function climbDown(
  ctx: ToolContext,
  isOwn: At,
  isLeavesAt: At,
  isSolidAt: At,
  placed: Set<string>,
): Promise<void> {
  const { bot, signal, log } = ctx;
  await settle(bot, signal);
  const startY = Math.floor(bot.entity.position.y);
  for (let step = 0; step < 64; step++) {
    throwIfAborted(signal);
    const cells = scaffoldToClear(bot.entity.position, isOwn, isLeavesAt, isSolidAt);
    log.debug(
      `Bajar: pies en ${bot.entity.position.toString()}, picar ${JSON.stringify(cells ?? 'nada')}`,
    );
    if (!cells) break;
    const before = bot.entity.position.y;
    for (const { x, y, z } of cells) {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (block && block.boundingBox === 'block') await digBlock(bot, block, signal);
      placed.delete(key(x, y, z));
    }
    // Esperar a caer y tocar suelo antes de mirar de nuevo qué hay bajo los pies.
    for (let i = 0; i < 30; i++) {
      if (bot.entity.onGround && bot.entity.position.y < before - 0.5) break;
      await wait(100, signal);
    }
  }
  const fell = startY - Math.floor(bot.entity.position.y);
  if (fell > 0) log.info(`Bajé ${fell} bloques picando mi andamio`);

  // Lo que quedó del andamio al alcance (ej: un escalón al lado del tronco): no dejar basura.
  const feet = cellsUnderFeet(bot.entity.position);
  for (const k of [...placed]) {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block || !isOwn(x, y, z) || !isSolidAt(x, y, z)) {
      placed.delete(k);
      continue;
    }
    const underFeet = feet.some((c) => c.x === x && c.y === y && c.z === z);
    const reachable = bot.canDigBlock(block);
    log.debug(`Andamio en ${k}: ${underFeet ? 'bajo mis pies' : reachable ? 'lo pico' : 'lejos'}`);
    if (underFeet || !reachable) continue;
    await digBlock(bot, block, signal);
    placed.delete(k);
  }
}

/**
 * Recoge los ítems que cayeron cerca de `around` (los pasos encima para que entren al
 * inventario). Si uno quedó atrapado sobre las hojas del árbol, rompe la hoja de abajo para
 * que caiga, como haría un jugador (en el juego quedaban troncos arriba de la copa).
 */
async function pickUpDrops(
  ctx: ToolContext,
  around: Vec3,
  dropIds: Set<number>,
  isLeavesAt: At,
  isSolidAt: At,
): Promise<void> {
  const { bot, signal, log } = ctx;
  await wait(350, signal); // dejar que el ítem aparezca y caiga

  const tried = new Set<number>();
  for (let attempt = 0; attempt < 10; attempt++) {
    const items = Object.values(bot.entities).filter((entity) => {
      if (entity.name !== 'item' || tried.has(entity.id)) return false;
      if (entity.position.distanceTo(around) > 8) return false;
      const item = entity.getDroppedItem();
      return item === null || dropIds.has(item.type);
    });
    const here = bot.entity.position;
    const nearest = items.sort(
      (a, b) => here.distanceTo(a.position) - here.distanceTo(b.position),
    )[0];
    if (!nearest) return;

    // Dónde queda (o quedará al caer) el ítem. Ir a buscarlo a la altura donde está flotando
    // hacía que el pathfinder armara un pilar para "subir" hasta él.
    const { x, y, z } = nearest.position;
    const under = { x: Math.floor(x), y: Math.floor(y - 0.2), z: Math.floor(z) };
    while (under.y > y - 64 && !isSolidAt(under.x, under.y, under.z)) under.y--;
    if (isLeavesAt(under.x, under.y, under.z)) {
      try {
        await gotoGoal(bot, new GoalWithinReach(under), signal, 8_000);
        const leaf = bot.blockAt(new Vec3(under.x, under.y, under.z));
        if (leaf) await digBlock(bot, leaf, signal);
        await wait(500, signal); // que el ítem caiga
        continue;
      } catch (error) {
        if (isAbortError(error)) throw error;
        log.debug(
          `No pude soltar un ítem atrapado en las hojas (${under.x},${under.y},${under.z})`,
        );
        return;
      }
    }

    // Pararse SOBRE la celda del ítem. Con "a 1 bloque" el pathfinder cuenta por celdas y el bot
    // podía quedar al borde de la vecina, a 1,6 del ítem: fuera del radio en que se recoge
    // (Benjamín vio troncos tirados que no recogía). Si esa celda no sirve, al lado.
    try {
      await gotoGoal(bot, new goals.GoalNear(x, under.y + 1, z, 0), signal, 6_000);
    } catch (error) {
      if (isAbortError(error)) throw error;
      await gotoGoal(bot, new goals.GoalNear(x, under.y + 1, z, 1), signal, 6_000).catch(
        (error2: unknown) => {
          if (isAbortError(error2)) throw error2;
          log.debug('No llegué hasta un ítem', error2);
        },
      );
    }
    await settle(bot, signal);
    // Esperar a que el ítem desaparezca del suelo (lo recogimos).
    for (let i = 0; i < 6 && bot.entities[nearest.id]; i++) await wait(150, signal);
    log.debug(
      `Ítem ${nearest.getDroppedItem()?.name ?? '?'} #${nearest.id} en ${nearest.position.toString()} ` +
        `(meta suelo y=${under.y + 1}; yo en ${bot.entity.position.toString()}): ` +
        `${bot.entities[nearest.id] ? 'NO lo recogí' : 'recogido'}`,
    );
    // Si este no se pudo, no rendirse con los demás: seguir con el siguiente.
    if (bot.entities[nearest.id]) tried.add(nearest.id);
  }
}
