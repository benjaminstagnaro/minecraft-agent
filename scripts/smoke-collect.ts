/**
 * Prueba de humo de la etapa 2 (end-to-end, en el servidor real): "@bot junta N troncos".
 *
 * El probador arma (por RCON) un bosquecito en el cielo, sobre donde está el agente:
 *   - 3 robles NATURALES generados con /place feature (igual que en el mundo normal),
 *   - 2 señuelos de "construcción": un pilar de troncos sin hojas y otro con hojas
 *     puestas a mano (persistent=true). El agente NO debe tocarlos jamás.
 *
 * Verifica:
 *   1. "junta 10 troncos" → los consigue (se cuentan en su inventario por RCON).
 *   2. "para" a mitad de una recolección → se detiene.
 *   3. "junta 30 troncos" (más de los que hay) → explica que no encuentra más.
 *   4. Los señuelos siguen intactos.
 * Al terminar borra el bosquecito y los ítems sueltos.
 *
 * Requisitos: servidor encendido (npm run server:start) y agente conectado (npm run dev).
 * Uso: npm run smoke:collect
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Bot } from 'mineflayer';
import { loadConfig } from '../src/config.js';
import { ENV_FILE } from './lib/paths.js';
import { rconCommand, readRconOptions, type RconOptions } from './lib/rcon.js';
import {
  connectTester,
  finish,
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
}

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
  for (const [dx, dz] of [
    [-6, -6],
    [6, -6],
    [0, 7],
  ] as const) {
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

    // ── 1. Juntar 10 troncos ───────────────────────────────────────────────────
    const started = Date.now();
    const done = await order(bot, agentName, '@bot junta 10 troncos', /listo|junté|no /i, 180_000);
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    const logs = await countItems(rcon, agentName, '#minecraft:logs');
    record(
      'Junta 10 troncos',
      done !== null && /^listo/i.test(done) && logs >= 10,
      `respondió "${done ?? 'nada'}" en ${seconds} s; tiene ${logs} troncos en el inventario`,
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
