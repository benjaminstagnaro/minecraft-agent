import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { z } from 'zod';
import { ALL_PLANKS, spanishName } from '../bot/names.js';
import { abortable, gotoGoal, isAbortError, throwIfAborted } from './abort.js';
import { findFreeSpotNear, placeOnTop } from './placement.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const { goals } = pathfinderPkg;

type Block = NonNullable<ReturnType<Bot['blockAt']>>;
type Recipe = ReturnType<Bot['recipesFor']>[number];

const TABLE_SEARCH_RADIUS = 32;
/** Reintentos si el servidor no completa un crafteo (ver runCraft). */
const MAX_CRAFT_ATTEMPTS = 3;
/** Ingredientes "normales" para explicar qué falta cuando hay varias recetas equivalentes. */
const COMMON_INGREDIENTS = new Set(['cobblestone', 'oak_planks', 'stick', 'coal', 'iron_ingot']);

// ─────────────────────────── lógica pura (testeable) ───────────────────────────

export interface Ingredient {
  name: string;
  /** Cuántos pide la receta por cada vez que se craftea. */
  perCraft: number;
  /** Cuántos hay en el inventario. */
  have: number;
}

/** Lo que falta para craftear `times` veces. Vacío = alcanza. */
export interface Missing {
  name: string;
  /** Cuántos faltan. */
  count: number;
  /** Cuántos tiene. */
  have?: number;
  /** Cuántos pide la receta en total. */
  need?: number;
}

export function missingIngredients(ingredients: Ingredient[], times: number): Missing[] {
  return ingredients
    .map(({ name, perCraft, have }) => ({
      name,
      count: perCraft * times - have,
      have,
      need: perCraft * times,
    }))
    .filter((m) => m.count > 0);
}

/** "1 tablones de roble (tengo 2 de 3) y 2 palos" */
export function describeMissing(missing: Missing[]): string {
  const parts = missing.map((m) => {
    const detail = m.have && m.need ? ` (tengo ${m.have} de ${m.need})` : '';
    return `${m.count} ${spanishName(m.name)}${detail}`;
  });
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
}

// ───────────────────────────────── herramienta ─────────────────────────────────

const input = z.object({
  items: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('IDs de ítem; sirve cualquiera, ej: todos los tipos de tablones'),
  count: z.number().int().min(1).max(64).describe('Cuántas unidades conseguir como mínimo'),
  label: z.string().optional().describe('Nombre para mostrar en el chat'),
});

export const craftItemTool: Tool<typeof input> = {
  name: 'craft_item',
  description:
    'Craftea un ítem con lo que hay en el inventario. Si la receta necesita mesa de crafteo, ' +
    'usa una cercana (radio 32) o pone una (y la fabrica con tablones o troncos si hace falta). ' +
    'Un solo paso: no fabrica ingredientes intermedios; si faltan, dice exactamente cuáles.',
  input,
  timeoutMs: 90_000,
  run: craft,
};

async function craft(ctx: ToolContext, args: z.infer<typeof input>): Promise<ToolResult> {
  const { bot, signal } = ctx;
  const label = args.label ?? spanishName(args.items[0] ?? '');

  const unknown = args.items.filter((name) => !bot.registry.itemsByName[name]);
  if (unknown.length > 0)
    return { ok: false, message: `No conozco el ítem: ${unknown.join(', ')}.` };
  const itemIds = args.items.map((name) => bot.registry.itemsByName[name]!.id);
  const countTargets = (): number =>
    itemIds.reduce((sum, id) => sum + bot.inventory.count(id, null), 0);
  const before = countTargets();

  // Entre las variantes posibles (ej: tablones de roble o de abeto), usar la de los
  // ingredientes que más tiene: si juntó abeto, que haga tablones de abeto.
  const abundance = (recipe: Recipe): number =>
    recipe.delta
      .filter((d) => d.count < 0)
      .reduce((sum, d) => sum + bot.inventory.count(d.id, null), 0);
  const pickRecipe = (table: true | null): Recipe | undefined =>
    itemIds
      .map((id) => bot.recipesFor(id, null, args.count, table)[0])
      .filter((recipe): recipe is Recipe => recipe !== undefined)
      .sort((a, b) => abundance(b) - abundance(a))[0];

  // 1) ¿Se puede en la cuadrícula 2x2 del inventario?
  const inventoryRecipe = pickRecipe(null);
  if (inventoryRecipe) {
    await runCraft(ctx, inventoryRecipe, args.count, undefined);
    return done(countTargets() - before, label);
  }

  // 2) ¿Se puede con mesa de crafteo?
  {
    const recipe = pickRecipe(true);
    if (recipe) {
      // Reservar los ingredientes del pedido: si hay que fabricar la mesa, que no se coma
      // los tablones que necesita el pico (por ejemplo).
      const reserve = recipeNeeds(recipe, Math.ceil(args.count / recipe.result.count));
      const table = await ensureCraftingTable(ctx, reserve);
      if ('error' in table)
        return { ok: false, message: `No puedo craftear ${label}: ${table.error}.` };
      throwIfAborted(signal);
      await gotoGoal(
        bot,
        new goals.GoalNear(
          table.block.position.x,
          table.block.position.y,
          table.block.position.z,
          2,
        ),
        signal,
        20_000,
      );
      await runCraft(ctx, recipe, args.count, table.block);
      const note = table.placed ? ' (puse una mesa de crafteo aquí)' : '';
      return done(countTargets() - before, label, note);
    }
  }

  // 3) No alcanza: explicar qué falta (según la receta a la que le falta menos).
  return {
    ok: false,
    message: `No puedo craftear ${args.count} ${label}: ${explainMissing(bot, itemIds, args.count)}.`,
  };
}

function done(gained: number, label: string, note = ''): ToolResult {
  return gained > 0
    ? { ok: true, message: `Listo: hice ${gained} ${label}${note}.`, data: { crafted: gained } }
    : { ok: false, message: `Intenté craftear ${label} pero no apareció en mi inventario.` };
}

async function runCraft(
  ctx: ToolContext,
  recipe: Recipe,
  count: number,
  table: Block | undefined,
): Promise<void> {
  const { bot, signal, log } = ctx;
  const times = Math.ceil(count / recipe.result.count);
  const expected = recipe.result.count * times;
  const resultName = bot.registry.items[recipe.result.id]?.name ?? String(recipe.result.id);
  log.info(`Crafteando ${times} vez/veces ${resultName}${table ? ' en la mesa' : ''}`);

  for (let attempt = 1; attempt <= MAX_CRAFT_ATTEMPTS; attempt++) {
    await clearCraftingGrid(bot, signal);
    const before = bot.inventory.count(recipe.result.id, null);
    let problem = 'el resultado no apareció en el inventario';
    try {
      await withPacedClicks(bot, () =>
        abortable(bot.craft(recipe, times, table), signal, {
          timeoutMs: 30_000,
          what: 'craftear',
          onStop: () => {
            if (bot.currentWindow) void bot.closeWindow(bot.currentWindow);
          },
        }),
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      problem = error instanceof Error ? error.message : String(error);
    }
    await clearCraftingGrid(bot, signal);
    // Verificar contra el inventario REAL (recién sincronizado), no contra lo que mineflayer cree.
    if (bot.inventory.count(recipe.result.id, null) - before >= expected) return;

    log.warn(
      `El crafteo de ${resultName} no se completó (intento ${attempt}: ${problem}); ` +
        'devolví lo que quedó en la cuadrícula y reintento',
    );
  }
  throw new Error(
    `el servidor no completó el crafteo de ${resultName} tras ${MAX_CRAFT_ATTEMPTS} intentos`,
  );
}

/** Silencio (sin paquetes de inventario) que indica que el servidor terminó de responder. */
const CLICK_QUIET_MS = 60;
/** Máximo que esperamos la respuesta del servidor a cada clic (6 ticks). */
const CLICK_ACK_TIMEOUT_MS = 300;

/**
 * Ejecuta `fn` haciendo que cada clic de inventario espere la respuesta del servidor.
 *
 * Por qué: desde 1.17 mineflayer envía los clics "a ciegas", sin esperar confirmación. El
 * servidor procesa los paquetes por tick (cada 50 ms) y, tras cada ingrediente que se pone en
 * la cuadrícula, actualiza la vista previa del resultado con un `stateId` nuevo. Si el clic
 * siguiente sale antes de recibir esa actualización, lleva un `stateId` viejo, el servidor
 * fuerza una resincronización completa y la predicción de mineflayer se desarma (deja
 * ingredientes sueltos y no fabrica nada). Medido en la prueba e2e: falla intermitente al
 * fabricar la mesa (3 intentos seguidos). Esperar la respuesta, como haría un humano, lo evita.
 */
async function withPacedClicks<T>(bot: Bot, fn: () => Promise<T>): Promise<T> {
  const original = bot.clickWindow.bind(bot);
  // Espera a que el servidor termine de responder: CLICK_QUIET_MS sin paquetes de inventario
  // (a veces manda dos correcciones seguidas), con un tope de CLICK_ACK_TIMEOUT_MS.
  const waitForServer = (): Promise<void> =>
    new Promise((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      const finish = (): void => {
        clearTimeout(quiet);
        clearTimeout(cap);
        bot._client.off('set_slot', onPacket);
        bot._client.off('window_items', onPacket);
        resolve();
      };
      const onPacket = (): void => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, CLICK_QUIET_MS);
      };
      const cap = setTimeout(finish, CLICK_ACK_TIMEOUT_MS);
      quiet = setTimeout(finish, CLICK_QUIET_MS * 2);
      bot._client.on('set_slot', onPacket);
      bot._client.on('window_items', onPacket);
    });

  bot.clickWindow = async (slot: number, mouseButton: number, mode: number): Promise<void> => {
    const answered = waitForServer();
    await original(slot, mouseButton, mode);
    await answered;
  };
  try {
    return await fn();
  } finally {
    bot.clickWindow = original;
  }
}

/** Slots de la cuadrícula 2x2 del inventario (0 = resultado, 1-4 = ingredientes). */
const GRID_SLOTS = [1, 2, 3, 4];

/**
 * Sincroniza el inventario y, si quedó algo en la cuadrícula 2x2 o en el cursor (un crafteo a
 * medias), lo devuelve al inventario cerrándolo, como hace un jugador al apretar E. Si no, los
 * ingredientes quedarían "atrapados" donde ni el bot ni el conteo los ven (lo vimos: un pico
 * falló con "missing ingredient" después de un reintento).
 */
async function clearCraftingGrid(bot: Bot, signal: AbortSignal): Promise<void> {
  await syncInventory(bot, signal);
  const leftovers =
    GRID_SLOTS.some((slot) => bot.inventory.slots[slot]) || bot.inventory.selectedItem;
  if (!leftovers) return;
  bot._client.write('close_window', { windowId: bot.inventory.id });
  await syncInventory(bot, signal);
}

/**
 * Pide al servidor el inventario completo para que nuestro modelo local sea el real.
 *
 * Por qué: al craftear en la cuadrícula 2x2 del inventario, mineflayer no confirma el último
 * clic (solo lo hace al usar una mesa). Si se encadenan crafteos (tablones → palos), el
 * segundo hace clic sobre un inventario desactualizado y el servidor no produce nada.
 * Medido en la prueba e2e: tablones OK, palos "no aparecen" y el bot cree tener 0 tablones.
 * `_syncWindow` es el mismo mecanismo que usa mineflayer internamente para la mesa.
 */
async function syncInventory(bot: Bot, signal: AbortSignal): Promise<void> {
  const sync = (bot as Bot & { _syncWindow?: (window: Bot['inventory']) => Promise<void> })
    ._syncWindow;
  if (!sync) return;
  await abortable(sync(bot.inventory), signal, {
    timeoutMs: 3_000,
    what: 'sincronizar el inventario',
  });
}

/** Ingredientes que consume una receta hecha `times` veces: id de ítem → cantidad. */
function recipeNeeds(recipe: Recipe, times = 1): Map<number, number> {
  const needs = new Map<number, number>();
  for (const d of recipe.delta) {
    if (d.count < 0) needs.set(d.id, (needs.get(d.id) ?? 0) - d.count * times);
  }
  return needs;
}

/** ¿Alcanza el inventario para todas estas necesidades juntas? */
function affords(bot: Bot, ...needs: Map<number, number>[]): boolean {
  const total = new Map<number, number>();
  for (const need of needs) {
    for (const [id, count] of need) total.set(id, (total.get(id) ?? 0) + count);
  }
  return [...total].every(([id, count]) => bot.inventory.count(id, null) >= count);
}

function explainMissing(bot: Bot, itemIds: number[], count: number): string {
  let best:
    | { missing: { name: string; count: number }[]; total: number; have: number; common: number }
    | undefined;
  for (const id of itemIds) {
    for (const recipe of bot.recipesAll(id, null, true)) {
      const times = Math.ceil(count / recipe.result.count);
      const ingredients = recipe.delta
        .filter((d) => d.count < 0)
        .map((d) => ({
          name: bot.registry.items[d.id]?.name ?? String(d.id),
          perCraft: -d.count,
          have: bot.inventory.count(d.id, null),
        }));
      const missing = missingIngredients(ingredients, times);
      const total = missing.reduce((sum, m) => sum + m.count, 0);
      // Empates: preferir la variante con ingredientes que ya tengo (tablones de roble si
      // tengo roble) y, si sigue empatado, la de ingredientes comunes ("adoquines" antes que
      // "pizarra profunda labrada").
      const have = ingredients.reduce((sum, i) => sum + Math.min(i.have, i.perCraft * times), 0);
      const common = missing.filter((m) => COMMON_INGREDIENTS.has(m.name)).length;
      const better =
        !best ||
        total < best.total ||
        (total === best.total &&
          (have > best.have || (have === best.have && common > best.common)));
      if (better) best = { missing, total, have, common };
    }
  }
  if (!best) return 'no conozco ninguna receta para eso';
  return `me faltan ${describeMissing(best.missing)}${craftHint(bot, best.missing)}`;
}

/**
 * Si algo de lo que falta se puede fabricar con lo que tiene (ej: tablones con troncos), lo
 * sugiere. Un jugador espera eso: "le di 10 troncos, ¿por qué no le alcanzan los tablones?".
 * (En la etapa 3 Claude encadenará estos pasos solo.)
 */
function craftHint(bot: Bot, missing: Missing[]): string {
  for (const m of missing) {
    const item = bot.registry.itemsByName[m.name];
    if (!item) continue;
    const recipe =
      bot.recipesFor(item.id, null, m.count, null)[0] ??
      bot.recipesFor(item.id, null, m.count, true)[0];
    if (!recipe) continue;
    const amount = Math.ceil(m.count / recipe.result.count) * recipe.result.count;
    const name = spanishName(m.name);
    return `. Puedo hacer ${name} con lo que tengo: dime "craftea ${amount} ${name}"`;
  }
  return '';
}

/**
 * Consigue una mesa de crafteo: una cercana, o pone una. Si no tiene, la fabrica con
 * tablones (y si no hay tablones, primero los hace con troncos).
 */
async function ensureCraftingTable(
  ctx: ToolContext,
  reserve: Map<number, number>,
): Promise<{ block: Block; placed: boolean } | { error: string }> {
  const { bot, signal, log } = ctx;
  const tableBlockId = bot.registry.blocksByName.crafting_table!.id;
  const tableItemId = bot.registry.itemsByName.crafting_table!.id;

  const nearby = bot.findBlock({ matching: tableBlockId, maxDistance: TABLE_SEARCH_RADIUS });
  if (nearby) return { block: nearby, placed: false };

  if (bot.inventory.count(tableItemId, null) === 0) {
    // Una variante de la receta de la mesa que alcance SIN tocar lo reservado.
    const pickTableRecipe = (): Recipe | undefined =>
      bot
        .recipesAll(tableItemId, null, null)
        .find((recipe) => affords(bot, recipeNeeds(recipe), reserve));

    let tableRecipe = pickTableRecipe();
    if (!tableRecipe) {
      // Sin tablones suficientes: hacer 4 con un tronco de cualquier tipo.
      const plankRecipe = ALL_PLANKS.map((name) => bot.registry.itemsByName[name])
        .filter((item) => item !== undefined)
        .flatMap((item) => bot.recipesAll(item.id, null, null))
        .find((recipe) => affords(bot, recipeNeeds(recipe), reserve));
      if (plankRecipe) await runCraft(ctx, plankRecipe, plankRecipe.result.count, undefined);
      tableRecipe = pickTableRecipe();
    }
    if (!tableRecipe) {
      return {
        error:
          'necesito una mesa de crafteo y no hay una cerca; tampoco me alcanzan los tablones ' +
          'para hacer la mesa y además lo que me pediste',
      };
    }
    log.info('Fabricando una mesa de crafteo');
    await runCraft(ctx, tableRecipe, 1, undefined);
  }

  const spot = findFreeSpotNear(bot);
  if (!spot) return { error: 'no encuentro un lugar libre para poner la mesa de crafteo' };
  log.info(`Poniendo la mesa de crafteo en ${spot.position.toString()}`);
  const block = await placeOnTop(bot, 'crafting_table', spot.ground, signal);
  return { block, placed: true };
}
