/**
 * Prueba de humo de la etapa 2 (end-to-end, en el servidor real): "@bot craftea ...".
 *
 * En una plataforma limpia en el cielo (sin mesas de crafteo cerca), el probador le da
 * materiales al agente por RCON y le pide craftear paso a paso:
 *   1. 4 tablones (con un tronco, en la cuadrícula 2x2 del inventario).
 *   2. 4 palos.
 *   3. Un pico de madera sin tablones suficientes → debe decir qué falta.
 *   4. Un pico de madera necesitando FABRICAR la mesa: con 6 tablones + 1 tronco. Si la mesa
 *      se comiera los tablones del pico, fallaría; debe hacer tablones con el tronco primero.
 *   5. Un cofre: debe usar la mesa que ya puso (no poner otra).
 *   6. Un pico de piedra sin piedra → debe decir qué falta.
 *
 * Requisitos: servidor encendido (npm run server:start) y agente conectado (npm run dev).
 * Uso: npm run smoke:craft
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
const HALF = 7;
const FILLED = /filled|rellen/i;

async function countItems(rcon: RconOptions, player: string, item: string): Promise<number> {
  const response = await rconCommand(rcon, `clear ${player} ${item} 0`);
  return Number(/(\d+)/.exec(response)?.[1] ?? 0);
}

async function main(): Promise<void> {
  const config = loadConfig(ENV_FILE);
  const agent = config.bot.name;
  const rcon = readRconOptions();
  const bot: Bot = await connectTester(config);

  await rconCommand(rcon, `tp ${TESTER_NAME} ${agent}`);
  await waitFor(() => bot.players[agent]?.entity !== undefined, 10_000);
  const home = bot.players[agent]?.entity?.position.clone();
  if (!home) throw new Error(`No veo la entidad de ${agent}.`);
  const [ox, oz] = [Math.floor(home.x), Math.floor(home.z)];
  const y = ARENA_Y;
  const box = `${ox - HALF} ${y} ${oz - HALF} ${ox + HALF} ${y + 4} ${oz + HALF}`;

  const ask = async (message: string, timeoutMs = 60_000): Promise<string> => {
    const reply = waitForAgentChat(
      bot,
      agent,
      /listo|no puedo|no pude|intenté|no sé|no conozco/i,
      timeoutMs,
    );
    bot.chat(message);
    return (await reply) ?? '(sin respuesta)';
  };
  const items = (item: string): Promise<number> => countItems(rcon, agent, item);

  console.log(`Armando plataforma en (${ox}, ${y}, ${oz})...`);
  await rconExpect(rcon, `fill ${box} air`, /./);
  await rconExpect(
    rcon,
    `fill ${ox - HALF} ${y} ${oz - HALF} ${ox + HALF} ${y} ${oz + HALF} smooth_stone`,
    FILLED,
  );
  for (const [ax, az, bx, bz] of [
    [ox - HALF, oz - HALF, ox + HALF, oz - HALF],
    [ox - HALF, oz + HALF, ox + HALF, oz + HALF],
    [ox - HALF, oz - HALF, ox - HALF, oz + HALF],
    [ox + HALF, oz - HALF, ox + HALF, oz + HALF],
  ] as const) {
    await rconExpect(rcon, `fill ${ax} ${y + 1} ${az} ${bx} ${y + 2} ${bz} glass`, FILLED);
  }

  try {
    await rconCommand(rcon, `clear ${agent}`);
    await rconCommand(rcon, `tp ${agent} ${ox + 0.5} ${y + 1} ${oz + 0.5}`);
    await rconCommand(rcon, `tp ${TESTER_NAME} ${ox + 3.5} ${y + 1} ${oz + 0.5}`);
    await sleep(2000);

    // 1. Tablones con un tronco (2x2, sin mesa).
    await rconCommand(rcon, `give ${agent} oak_log 2`);
    let reply = await ask('@bot craftea 4 tablones');
    record(
      'Tablones (sin mesa)',
      /listo: hice 4/i.test(reply) && (await items('oak_planks')) === 4,
      reply,
    );

    // 2. Palos.
    reply = await ask('@bot craftea 4 palos');
    record('Palos', /listo: hice 4/i.test(reply) && (await items('stick')) === 4, reply);

    // 3. Pico sin tablones suficientes (tiene 2 de 3): explicar.
    reply = await ask('@bot craftea un pico de madera');
    record(
      'Explica qué falta',
      /me faltan 1 tablones de roble \(tengo 2 de 3\)/i.test(reply),
      reply,
    );
    // Le queda 1 tronco: debe sugerir hacer tablones con él (lo que esperaba Benjamín en el juego).
    record(
      'Sugiere cómo conseguir lo que falta',
      /dime "craftea 4 tablones de roble"/i.test(reply),
      reply,
    );

    // 4. Pico fabricando la mesa: 6 tablones + 1 tronco + 4 palos. Mesa (4) + pico (3) = 7 > 6:
    //    sin reservar ingredientes fallaría; debe convertir el tronco en tablones primero.
    await rconCommand(rcon, `give ${agent} oak_planks 4`);
    reply = await ask('@bot craftea un pico de madera');
    const pickaxes = await items('wooden_pickaxe');
    record(
      'Pico de madera (fabrica y pone la mesa sin gastar lo del pico)',
      /listo: hice 1 pico de madera \(puse una mesa/i.test(reply) && pickaxes === 1,
      `${reply} | picos: ${pickaxes}, tablones: ${await items('oak_planks')}, troncos: ${await items('oak_log')}`,
    );

    // 5. Cofre con la mesa que ya existe.
    await rconCommand(rcon, `give ${agent} oak_planks 8`);
    reply = await ask('@bot craftea un cofre');
    record(
      'Usa la mesa existente',
      /listo: hice 1 cofre\.$/i.test(reply) && (await items('chest')) === 1,
      reply,
    );

    // 6. Pico de piedra sin piedra.
    reply = await ask('@bot craftea un pico de piedra');
    record(
      'Explica qué falta (piedra)',
      /no puedo craftear.*me faltan 3 adoquines/i.test(reply),
      reply,
    );

    const tables = await rconCommand(rcon, `fill ${box} air replace crafting_table`);
    const placed = Number(/(\d+)/.exec(tables)?.[1] ?? 0);
    record('Puso exactamente una mesa', placed === 1, `mesas en la plataforma: ${placed}`);
  } finally {
    await rconCommand(rcon, `tp ${agent} ${home.x} ${home.y} ${home.z}`);
    await rconCommand(rcon, `tp ${TESTER_NAME} ${home.x} ${home.y} ${home.z}`);
    await sleep(500);
    await rconCommand(rcon, `fill ${box} air`);
    console.log('Plataforma borrada; agente devuelto a su posición.');
    bot.quit('Prueba terminada');
  }
}

main()
  .catch((error: unknown) => {
    record('Prueba', false, error instanceof Error ? error.message : String(error));
  })
  .finally(finish);
