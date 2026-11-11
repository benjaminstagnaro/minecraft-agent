import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { createWorkMovements } from '../bot/pathing.js';
import { digBlock, gotoGoal, isAbortError, throwIfAborted, wait } from './abort.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const { goals } = pathfinderPkg;

type Block = NonNullable<ReturnType<Bot['blockAt']>>;

const SEARCH_RADIUS = 48;
const MAX_CONSECUTIVE_FAILURES = 4;
const MAX_TREE_HEIGHT = 32;

// ─────────────────────────── lógica pura (testeable) ───────────────────────────

/** Lo mínimo que necesitamos saber de un bloque para decidir. */
export interface BlockInfo {
  name: string;
  /** Propiedades de estado, ej: { persistent: false } en las hojas. */
  properties: Record<string, unknown>;
}

export type BlockLookup = (x: number, y: number, z: number) => BlockInfo | undefined;

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
  const previousMovements = bot.pathfinder.movements;
  bot.pathfinder.setMovements(
    createWorkMovements(bot, (block) => {
      const info = { name: block.name, properties: block.getProperties() };
      if (isNaturalLeaves(info)) return true;
      return targetIds.has(block.type) && isNatural(block);
    }),
  );

  const start = countDrops();
  const gained = (): number => countDrops() - start;
  const failed = new Set<string>();
  let consecutiveFailures = 0;
  let checkedHarvest = false;

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
      candidates.sort((a, b) => here.distanceTo(a.position) - here.distanceTo(b.position));
      const target = candidates[0];

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
        await gotoGoal(
          bot,
          new goals.GoalLookAtBlock(target.position, bot.world, { reach: 4.5 }),
          signal,
          30_000,
        );
        const fresh = bot.blockAt(target.position);
        if (!fresh || !targetIds.has(fresh.type)) continue; // alguien más lo picó
        if (!bot.canDigBlock(fresh)) throw new Error('no alcanzo a picarlo desde aquí');

        const tool = bot.pathfinder.bestHarvestTool(fresh);
        if (tool) await bot.equip(tool, 'hand');
        await digBlock(bot, fresh, signal);
        await pickUpDrops(ctx, fresh.position, dropIds);

        consecutiveFailures = 0;
        log.info(`Llevo ${gained()}/${args.count} ${label}`);
      } catch (error) {
        if (isAbortError(error)) throw error;
        failed.add(target.position.toString());
        consecutiveFailures++;
        log.warn(`No pude con ${target.name} en ${target.position.toString()}`, error);
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
    if (previousMovements) bot.pathfinder.setMovements(previousMovements);
  }
}

/** Recoge los ítems que cayeron cerca de `around` (los pasos encima para que entren al inventario). */
async function pickUpDrops(ctx: ToolContext, around: Vec3, dropIds: Set<number>): Promise<void> {
  const { bot, signal } = ctx;
  await wait(350, signal); // dejar que el ítem aparezca y caiga

  for (let attempt = 0; attempt < 6; attempt++) {
    const items = Object.values(bot.entities).filter((entity) => {
      if (entity.name !== 'item' || entity.position.distanceTo(around) > 6) return false;
      const item = entity.getDroppedItem();
      return item === null || dropIds.has(item.type);
    });
    const here = bot.entity.position;
    const nearest = items.sort(
      (a, b) => here.distanceTo(a.position) - here.distanceTo(b.position),
    )[0];
    if (!nearest) return;

    const { x, y, z } = nearest.position;
    await gotoGoal(bot, new goals.GoalNear(x, y, z, 1), signal, 8_000).catch((error: unknown) => {
      if (isAbortError(error)) throw error;
    });
    // Esperar a que el ítem desaparezca del suelo (lo recogimos).
    for (let i = 0; i < 6 && bot.entities[nearest.id]; i++) await wait(150, signal);
    if (bot.entities[nearest.id]) return; // no se pudo recoger: seguir con lo demás
  }
}
