/**
 * Prueba de humo de la etapa 2 (end-to-end, en el servidor real): "@bot junta N troncos".
 *
 * El probador arma (por RCON) un bosquecito en el cielo, sobre donde está el agente:
 *   - 4 robles NATURALES en fila, pegados (igual que en un bosque), con /place feature,
 *   - 2 señuelos de "construcción": un pilar de troncos sin hojas y otro con hojas
 *     puestas a mano (persistent=true). El agente NO debe tocarlos jamás.
 *
 * Verifica:
 *   1. "junta 10 troncos" → los consigue (se cuentan en su inventario por RCON).
 *   2. "para" a mitad de una recolección → se detiene.
 *   3. "junta 30 troncos" (más de los que hay) → explica que no encuentra más.
 *   4. Los señuelos siguen intactos.
 *   5. Un abeto de 9 troncos (la punta no se alcanza desde el suelo) con tierra en el
 *      inventario: lo tala entero sin lastimarse y termina en el suelo.
 *   6. "tala este árbol" mirando un abeto alto: tala ESE (no el más cercano) y lo recoge.
 *   7. "para" estando arriba de su andamio: baja y quita la tierra igual.
 * Al terminar borra el bosquecito y los ítems sueltos.
 *
 * Requisitos: servidor encendido (npm run server:start) y agente conectado (npm run dev).
 * Uso: npm run smoke:collect            (todo)
 *      npm run smoke:collect -- --solo-alto   (solo las fases 5 a 7)
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { loadConfig } from '../src/config.js';
import { ENV_FILE } from './lib/paths.js';
import { rconCommand, readRconOptions, type RconOptions } from './lib/rcon.js';
import {
  connectTester,
  finish,
  HealthWatch,
  rconExpect,
  record,
  TESTER_NAME,
  waitFor,
  waitForAgentChat,
} from './lib/smoke.js';

const ARENA_Y = 200;
const HALF = 12;
const FILLED = /filled|rellen/i;

interface Arena {
  ox: number;
  oz: number;
  /** Bloques de los señuelos: deben seguir siendo troncos al final. */
  decoys: { x: number; y: number; z: number }[];
  /** Columnas (x, z) de los troncos de los árboles naturales. */
  trees: { x: number; z: number }[];
}

// Robles en fila a 3 bloques: como en un bosque real, las copas se tocan y la base del árbol
// vecino suele quedar más cerca que los troncos altos del árbol que se está talando.
const TREE_SPOTS = [
  [-5, -5],
  [-2, -5],
  [1, -5],
  [4, -5],
] as const;

async function buildForest(rcon: RconOptions, ox: number, oz: number): Promise<Arena> {
  const y = ARENA_Y;
  const [x1, x2, z1, z2] = [ox - HALF, ox + HALF, oz - HALF, oz + HALF];
  await rconExpect(rcon, `fill ${x1} ${y + 1} ${z1} ${x2} ${y + 15} ${z2} air`, /./);
  await rconExpect(rcon, `fill ${x1} ${y} ${z1} ${x2} ${y} ${z2} grass_block`, FILLED);
  for (const [ax, az, bx, bz] of [
    [x1, z1, x2, z1],
    [x1, z2, x2, z2],
    [x1, z1, x1, z2],
    [x2, z1, x2, z2],
  ] as const) {
    await rconExpect(rcon, `fill ${ax} ${y + 1} ${az} ${bx} ${y + 2} ${bz} glass`, FILLED);
  }

  // Árboles naturales.
  for (const [dx, dz] of TREE_SPOTS) {
    await rconExpect(
      rcon,
      `place feature minecraft:oak ${ox + dx} ${y + 1} ${oz + dz}`,
      /placed|colocad/i,
    );
  }

  // Señuelo 1: pilar de troncos sin hojas (como la esquina de una casa).
  const a = { x: ox + 8, z: oz + 8 };
  await rconExpect(rcon, `fill ${a.x} ${y + 1} ${a.z} ${a.x} ${y + 3} ${a.z} oak_log`, FILLED);
  // Señuelo 2: troncos con hojas puestas a mano (persistent=true), como una decoración.
  const b = { x: ox - 8, z: oz + 8 };
  await rconExpect(rcon, `fill ${b.x} ${y + 1} ${b.z} ${b.x} ${y + 2} ${b.z} oak_log`, FILLED);
  await rconExpect(
    rcon,
    `setblock ${b.x} ${y + 3} ${b.z} oak_leaves[persistent=true]`,
    /changed|cambi/i,
  );

  return {
    ox,
    oz,
    trees: TREE_SPOTS.map(([dx, dz]) => ({ x: ox + dx, z: oz + dz })),
    decoys: [
      { x: a.x, y: y + 1, z: a.z },
      { x: a.x, y: y + 2, z: a.z },
      { x: a.x, y: y + 3, z: a.z },
      { x: b.x, y: y + 1, z: b.z },
      { x: b.x, y: y + 2, z: b.z },
    ],
  };
}

async function removeForest(rcon: RconOptions, { ox, oz }: Arena): Promise<void> {
  const y = ARENA_Y;
  const [x1, z1] = [ox - HALF, oz - HALF];
  await rconCommand(rcon, `fill ${x1} ${y} ${z1} ${ox + HALF} ${y + 15} ${oz + HALF} air`);
  await rconCommand(
    rcon,
    `kill @e[type=minecraft:item,x=${x1},y=${y - 2},z=${z1},dx=${2 * HALF},dy=20,dz=${2 * HALF}]`,
  );
}

/** Cuántos ítems del tipo/etiqueta tiene un jugador (sin quitárselos: `clear ... 0`). */
async function countItems(rcon: RconOptions, player: string, item: string): Promise<number> {
  const response = await rconCommand(rcon, `clear ${player} ${item} 0`);
  const match = /(\d+)/.exec(response);
  return match ? Number(match[1]) : 0;
}

async function intactDecoys(rcon: RconOptions, arena: Arena): Promise<number> {
  let intact = 0;
  for (const { x, y, z } of arena.decoys) {
    const response = await rconCommand(rcon, `execute if block ${x} ${y} ${z} minecraft:oak_log`);
    if (/passed|superad|correct/i.test(response)) intact++;
  }
  return intact;
}

/** Troncos que quedan en la columna de un árbol (el roble normal tiene un tronco recto). */
async function treeLogs(rcon: RconOptions, x: number, z: number, log = 'oak_log'): Promise<number> {
  let count = 0;
  for (let y = ARENA_Y + 1; y <= ARENA_Y + 14; y++) {
    const response = await rconCommand(rcon, `execute if block ${x} ${y} ${z} minecraft:${log}`);
    if (/passed|superad|correct/i.test(response)) count++;
  }
  return count;
}

/** Troncos de cada árbol, contando de a uno (en serie, para no saturar RCON). */
async function countTrees(rcon: RconOptions, arena: Arena): Promise<number[]> {
  const counts: number[] = [];
  for (const { x, z } of arena.trees) counts.push(await treeLogs(rcon, x, z));
  return counts;
}

/** Manda una orden y espera la respuesta final del agente. */
async function order(
  bot: Bot,
  agentName: string,
  message: string,
  finalPattern: RegExp,
  timeoutMs: number,
): Promise<string | null> {
  const reply = waitForAgentChat(bot, agentName, finalPattern, timeoutMs);
  bot.chat(message);
  return reply;
}

/**
 * Abeto fijo con copa de hojas naturales (persistent=false). Con 9 troncos (por defecto) los
 * 3 de arriba no se alcanzan desde el suelo: así fue el árbol en que el bot se cayó en el juego.
 */
async function buildSpruce(rcon: RconOptions, x: number, z: number, height = 9): Promise<number> {
  const y = ARENA_Y;
  const leaves = 'spruce_leaves[persistent=false,distance=1]';
  // Capas de la copa (altura sobre el piso, radio), alternadas como un abeto real.
  const h = height;
  const layers = (
    [
      [h - 5, 2],
      [h - 4, 1],
      [h - 3, 2],
      [h - 2, 1],
      [h - 1, 1],
      [h, 1],
    ] as [number, number][]
  ).filter(([dy]) => dy >= 2);
  await rconExpect(rcon, `fill ${x} ${y + 1} ${z} ${x} ${y + h} ${z} spruce_log`, FILLED);
  for (const [dy, r] of layers) {
    await rconExpect(
      rcon,
      `fill ${x - r} ${y + dy} ${z - r} ${x + r} ${y + dy} ${z + r} ${leaves} replace air`,
      FILLED,
    );
  }
  await rconExpect(rcon, `setblock ${x} ${y + h + 1} ${z} ${leaves}`, /changed|cambi/i);
  return h;
}

/** Cuenta (y borra) los bloques de tierra/adoquín que quedaron sobre el piso de la arena. */
async function removeScaffold(rcon: RconOptions, ox: number, oz: number): Promise<number> {
  let scaffold = 0;
  for (const block of ['dirt', 'cobblestone']) {
    const response = await rconCommand(
      rcon,
      `fill ${ox - HALF} ${ARENA_Y + 1} ${oz - HALF} ${ox + HALF} ${ARENA_Y + 15} ${oz + HALF} air replace ${block}`,
    );
    scaffold += FILLED.test(response) ? Number(/(\d+)/.exec(response)?.[1] ?? 0) : 0;
  }
  return scaffold;
}

/**
 * Fase "árbol alto". En el juego el bot tenía tierra (sobrante de otra prueba): armó un pilar,
 * se paró sobre el último tronco, lo picó y cayó ~6 bloques (3 de vida). Se reproduce igual:
 * abeto de 9 troncos y tierra en el inventario. Debe talarlo sin lastimarse y volver al suelo.
 */
async function tallTreePhase(
  bot: Bot,
  rcon: RconOptions,
  agentName: string,
  ox: number,
  oz: number,
): Promise<void> {
  const spruce = { x: ox - 8, z: oz + 1 };
  const tall = await buildSpruce(rcon, spruce.x, spruce.z);
  await rconCommand(rcon, `give ${agentName} dirt 8`);
  await rconCommand(rcon, `give ${agentName} cobblestone 4`);
  await rconCommand(rcon, `tp ${agentName} ${spruce.x + 3.5} ${ARENA_Y + 1} ${spruce.z + 0.5}`);
  await sleep(2000);

  const health = new HealthWatch(rcon, agentName);
  await health.begin();
  const started = Date.now();
  const reply = await order(
    bot,
    agentName,
    `@bot junta ${tall} troncos de abeto`,
    /listo|junté/i,
    240_000,
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  await sleep(1500); // por si cae al final
  health.end();

  const left = await treeLogs(rcon, spruce.x, spruce.z, 'spruce_log');
  const got = await countItems(rcon, agentName, 'spruce_log');
  const feet = bot.players[agentName]?.entity?.position;
  record(
    'No se lastima talando un árbol alto',
    Number.isFinite(health.min) && health.min >= (health.start ?? 20),
    `abeto de ${tall} troncos; vida al inicio ${health.start ?? '?'}, mínima ${health.min}; ` +
      `respondió "${reply ?? 'nada'}" en ${seconds} s`,
  );
  record(
    'Tala el árbol alto completo y recoge los troncos',
    left === 0 && got === tall,
    `quedaron ${left} de ${tall} troncos en el árbol; tiene ${got} en el inventario`,
  );
  const scaffold = await removeScaffold(rcon, ox, oz);
  record('No deja andamios', scaffold === 0, `bloques de tierra/adoquín que quedaron: ${scaffold}`);
  record(
    'Termina en el suelo (no queda atrapado arriba)',
    feet !== undefined && feet.y < ARENA_Y + 2,
    `pies en y=${feet?.y.toFixed(2) ?? '?'} (suelo: ${ARENA_Y + 1})`,
  );
}

/** El probador mira el tronco (a la altura de los ojos) para "tala este árbol". */
async function lookAtTrunk(bot: Bot, x: number, z: number): Promise<void> {
  await bot.lookAt(new Vec3(x + 0.5, ARENA_Y + 2.5, z + 0.5), true);
  await sleep(700); // que el servidor le avise al agente hacia dónde miramos
}

/**
 * Fase "tala este árbol": un abeto alto (A) y uno chico (B) MÁS CERCA del agente. El probador
 * mira A y le pide "tala este árbol": debe talar A completo y no tocar B (antes siempre iba al
 * más cercano; lo pidió Benjamín).
 */
async function chopLookedPhase(
  bot: Bot,
  rcon: RconOptions,
  agentName: string,
  ox: number,
  oz: number,
): Promise<void> {
  const a = { x: ox + 7, z: oz + 1 };
  const b = { x: ox + 2, z: oz + 4 };
  const tallA = await buildSpruce(rcon, a.x, a.z);
  const smallB = await buildSpruce(rcon, b.x, b.z, 4);
  await rconCommand(rcon, `give ${agentName} dirt 8`);
  await rconCommand(rcon, `tp ${agentName} ${ox + 3.5} ${ARENA_Y + 1} ${oz + 3.5}`);
  await rconCommand(rcon, `tp ${TESTER_NAME} ${ox + 3.5} ${ARENA_Y + 1} ${oz - 1.5}`);
  await sleep(2000);
  await lookAtTrunk(bot, a.x, a.z);

  const before = await countItems(rcon, agentName, 'spruce_log');
  const started = Date.now();
  const reply = await order(bot, agentName, '@bot tala este árbol', /listo|talé|no /i, 240_000);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  await sleep(1000);
  const leftA = await treeLogs(rcon, a.x, a.z, 'spruce_log');
  const leftB = await treeLogs(rcon, b.x, b.z, 'spruce_log');
  const got = (await countItems(rcon, agentName, 'spruce_log')) - before;
  record(
    'Tala el árbol que miro (no el más cercano)',
    reply !== null && /talé el árbol completo/i.test(reply) && leftA === 0 && leftB === smallB,
    `respondió "${reply ?? 'nada'}" en ${seconds} s; quedan ${leftA}/${tallA} en el que miré y ` +
      `${leftB}/${smallB} en el más cercano`,
  );
  record('Recoge los troncos del árbol que miro', got === tallA, `recogió ${got} de ${tallA}`);
  await removeScaffold(rcon, ox, oz);
}

/**
 * Fase "para en el andamio": Benjamín vio que si le dice "para" mientras está arriba de su
 * pilar, la tierra queda puesta. Ahora, aunque lo cancelen, debe bajar y quitarla.
 */
async function stopOnScaffoldPhase(
  bot: Bot,
  rcon: RconOptions,
  agentName: string,
  ox: number,
  oz: number,
): Promise<void> {
  const a = { x: ox + 7, z: oz + 1 };
  await buildSpruce(rcon, a.x, a.z);
  await rconCommand(rcon, `give ${agentName} dirt 8`);
  await rconCommand(rcon, `tp ${agentName} ${ox + 3.5} ${ARENA_Y + 1} ${oz + 3.5}`);
  await sleep(2000);
  await lookAtTrunk(bot, a.x, a.z);

  const working = await order(bot, agentName, '@bot tala este árbol', /voy a talar/i, 5_000);
  // Parado sobre su andamio: pies sobre el suelo y a una altura entera (no a mitad de un salto,
  // cuando todavía no alcanza a poner el bloque).
  const standingHigh = (): boolean => {
    const y = bot.players[agentName]?.entity?.position.y ?? 0;
    return y >= ARENA_Y + 2 && Math.abs(y - Math.round(y)) < 0.01;
  };
  const elevated = await waitFor(standingHigh, 120_000, 100);
  await sleep(300);
  const stopReply = waitForAgentChat(bot, agentName, /detenido/i, 30_000);
  bot.chat('@bot para');
  const stopped = await stopReply;
  await sleep(1500);
  const feet = bot.players[agentName]?.entity?.position;
  const scaffold = await removeScaffold(rcon, ox, oz);
  record(
    'Con "para" arriba del andamio: baja y quita la tierra',
    working !== null &&
      elevated &&
      stopped !== null &&
      scaffold === 0 &&
      (feet?.y ?? 999) < ARENA_Y + 2,
    `subió: ${String(elevated)}; respondió "${stopped ?? 'nada'}"; pies en ` +
      `y=${feet?.y.toFixed(2) ?? '?'}; tierra que quedó: ${scaffold}`,
  );
}

/** Con `--solo-alto` corre solo las fases de árboles altos (5 a 7), para iterar rápido. */
const ONLY_TALL = process.argv.includes('--solo-alto');

async function tallPhases(
  bot: Bot,
  rcon: RconOptions,
  agentName: string,
  ox: number,
  oz: number,
): Promise<void> {
  // ── 5. Árbol alto ──────────────────────────────────────────────────────────
  await tallTreePhase(bot, rcon, agentName, ox, oz);
  // ── 6. "Tala este árbol" (el que miro, no el más cercano) ──────────────────
  await chopLookedPhase(bot, rcon, agentName, ox, oz);
  // ── 7. "Para" estando arriba del andamio ───────────────────────────────────
  await stopOnScaffoldPhase(bot, rcon, agentName, ox, oz);
}

async function main(): Promise<void> {
  const config = loadConfig(ENV_FILE);
  const agentName = config.bot.name;
  const rcon = readRconOptions();
  const bot = await connectTester(config);

  await rconCommand(rcon, `tp ${TESTER_NAME} ${agentName}`);
  await waitFor(() => bot.players[agentName]?.entity !== undefined, 10_000);
  const home = bot.players[agentName]?.entity?.position.clone();
  if (!home) throw new Error(`No veo la entidad de ${agentName}.`);

  console.log(
    `Plantando bosquecito en (${Math.floor(home.x)}, ${ARENA_Y}, ${Math.floor(home.z)})...`,
  );
  await rconCommand(rcon, 'time set day');
  const arena = await buildForest(rcon, Math.floor(home.x), Math.floor(home.z));
  const { ox, oz } = arena;

  try {
    await rconCommand(rcon, `clear ${agentName}`);
    await rconCommand(rcon, `tp ${agentName} ${ox + 0.5} ${ARENA_Y + 1} ${oz + 0.5}`);
    await rconCommand(rcon, `tp ${TESTER_NAME} ${ox + 2.5} ${ARENA_Y + 1} ${oz - 0.5}`);
    await sleep(2500);
    if (ONLY_TALL) {
      await tallPhases(bot, rcon, agentName, ox, oz);
      return;
    }

    // ── 1. Juntar 10 troncos ───────────────────────────────────────────────────
    const logsBefore = await countTrees(rcon, arena);
    const started = Date.now();
    const done = await order(bot, agentName, '@bot junta 10 troncos', /listo|junté|no /i, 180_000);
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    const logs = await countItems(rcon, agentName, '#minecraft:logs');
    record(
      'Junta 10 troncos',
      done !== null && /^listo/i.test(done) && logs >= 10,
      `respondió "${done ?? 'nada'}" en ${seconds} s; tiene ${logs} troncos en el inventario`,
    );
    // Un jugador termina un árbol antes de pasar a otro: a lo más queda a medias el último.
    const logsAfter = await countTrees(rcon, arena);
    const halfDone = logsAfter.filter((left, i) => left > 0 && left < (logsBefore[i] ?? 0)).length;
    // Benjamín vio troncos tirados en el suelo que el bot no recogía.
    const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);
    const chopped = sum(logsBefore) - sum(logsAfter);
    record(
      'Recoge todo lo que tala',
      logs === chopped,
      `taló ${chopped} troncos y tiene ${logs} en el inventario`,
    );
    record(
      'Termina cada árbol antes de pasar a otro',
      halfDone <= 1,
      `troncos por árbol antes [${logsBefore.join(', ')}] → después [${logsAfter.join(', ')}]; a medias: ${halfDone}`,
    );

    // ── 2. Cancelar a mitad ────────────────────────────────────────────────────
    const stopReply = waitForAgentChat(bot, agentName, /detenido/i, 15_000);
    const working = await order(bot, agentName, '@bot junta 20 troncos', /voy a juntar/i, 5_000);
    await sleep(2000);
    bot.chat('@bot para');
    const stopped = await stopReply;
    const before = bot.players[agentName]?.entity?.position.clone();
    await sleep(2000);
    const moved = before
      ? (bot.players[agentName]?.entity?.position.distanceTo(before) ?? Infinity)
      : Infinity;
    record(
      'Se detiene con "para" a mitad de la tarea',
      working !== null && stopped !== null && moved < 0.5,
      `respondió "${stopped ?? 'nada'}"; después se movió ${moved.toFixed(2)} bloques`,
    );

    // ── 3. Pedir más de los que hay ────────────────────────────────────────────
    const leftover = await order(bot, agentName, '@bot junta 30 troncos', /junté|listo/i, 240_000);
    record(
      'Explica cuando no hay suficientes',
      leftover !== null && /de 30/.test(leftover),
      `respondió "${leftover ?? 'nada'}"`,
    );

    // ── 4. Señuelos intactos ───────────────────────────────────────────────────
    const intact = await intactDecoys(rcon, arena);
    record(
      'No tala troncos de construcciones',
      intact === arena.decoys.length,
      `${intact}/${arena.decoys.length} bloques de los señuelos siguen en su lugar`,
    );

    // ── 5 a 7. Árboles altos ───────────────────────────────────────────────────
    await tallPhases(bot, rcon, agentName, ox, oz);
  } finally {
    bot.chat('@bot para');
    await sleep(500);
    await rconCommand(rcon, `tp ${agentName} ${home.x} ${home.y} ${home.z}`);
    await rconCommand(rcon, `tp ${TESTER_NAME} ${home.x} ${home.y} ${home.z}`);
    await sleep(500);
    await removeForest(rcon, arena);
    console.log('Bosquecito borrado; agente devuelto a su posición.');
    bot.quit('Prueba terminada');
  }
}

main()
  .catch((error: unknown) => {
    record('Prueba', false, error instanceof Error ? error.message : String(error));
  })
  .finally(finish);
