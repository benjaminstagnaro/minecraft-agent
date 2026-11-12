/**
 * Prueba de humo de la etapa 2 (end-to-end, en el servidor real): "@bot pon <bloque> en x y z".
 *
 * En una plataforma en el cielo, el probador le da tierra y adoquines al agente y verifica:
 *   1. Pone un bloque en el suelo y otro encima (apilar).
 *   2. Explica cuando no puede: flotando sin apoyo, lugar ocupado, no tiene el bloque,
 *      alguien parado ahí.
 *   3. Coordenadas relativas al jugador ("~2 ~ ~").
 *   4. Camina hasta un lugar lejano para ponerlo.
 *   5. Si está parado justo donde va el bloque, se corre y lo pone.
 * Cada bloque puesto se verifica en el servidor por RCON. Al terminar se borra todo.
 *
 * Requisitos: servidor encendido (npm run server:start) y agente conectado (npm run dev).
 * Uso: npm run smoke:place
 */
import { setTimeout as sleep } from 'node:timers/promises';
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
const HALF = 8;
const FILLED = /filled|rellen/i;
const REPLY = /listo|no |ya hay|está parado|parado en/i;

async function blockIs(rcon: RconOptions, x: number, y: number, z: number, name: string) {
  const response = await rconCommand(rcon, `execute if block ${x} ${y} ${z} minecraft:${name}`);
  return /passed|superad|correct/i.test(response);
}

async function main(): Promise<void> {
  const config = loadConfig(ENV_FILE);
  const agent = config.bot.name;
  const rcon = readRconOptions();
  const bot = await connectTester(config);

  await rconCommand(rcon, `tp ${TESTER_NAME} ${agent}`);
  await waitFor(() => bot.players[agent]?.entity !== undefined, 10_000);
  const home = bot.players[agent]?.entity?.position.clone();
  if (!home) throw new Error(`No veo la entidad de ${agent}.`);
  const [ox, oz] = [Math.floor(home.x), Math.floor(home.z)];
  const y = ARENA_Y;
  const floor = y + 1; // celda justo encima del piso
  const box = `${ox - HALF} ${y} ${oz - HALF} ${ox + HALF} ${y + 6} ${oz + HALF}`;

  const ask = async (message: string, timeoutMs = 45_000): Promise<string> => {
    const reply = waitForAgentChat(bot, agent, REPLY, timeoutMs);
    bot.chat(message);
    return (await reply) ?? '(sin respuesta)';
  };

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
    await rconCommand(rcon, `give ${agent} dirt 8`);
    await rconCommand(rcon, `give ${agent} cobblestone 4`);
    await rconCommand(rcon, `tp ${agent} ${ox + 0.5} ${floor} ${oz + 0.5}`);
    await rconCommand(rcon, `tp ${TESTER_NAME} ${ox + 3.5} ${floor} ${oz + 0.5}`);
    await sleep(2000);

    // 1. Poner en el suelo y apilar.
    let reply = await ask(`@bot pon tierra en ${ox - 3} ${floor} ${oz}`);
    record(
      'Pone un bloque en el suelo',
      /listo: puse/i.test(reply) && (await blockIs(rcon, ox - 3, floor, oz, 'dirt')),
      reply,
    );
    reply = await ask(`@bot pon tierra en ${ox - 3} ${floor + 1} ${oz}`);
    record(
      'Apila un bloque encima de otro',
      /listo: puse/i.test(reply) && (await blockIs(rcon, ox - 3, floor + 1, oz, 'dirt')),
      reply,
    );

    // 2. Errores que debe explicar.
    reply = await ask(`@bot pon tierra en ${ox - 5} ${floor + 3} ${oz + 4}`);
    record('Explica que flotando no hay apoyo', /no hay dónde apoyarlo/i.test(reply), reply);
    reply = await ask(`@bot pon tierra en ${ox - 3} ${floor} ${oz}`);
    record('Explica que el lugar está ocupado', /ya hay tierra/i.test(reply), reply);
    reply = await ask(`@bot pon vidrio en ${ox - 4} ${floor} ${oz}`);
    record('Explica que no tiene el bloque', /no tengo vidrio/i.test(reply), reply);
    reply = await ask('@bot pon tierra en ~ ~ ~');
    record('No pone un bloque encima de un jugador', /parado en ese lugar/i.test(reply), reply);

    // 3. Relativo al jugador (el probador está en la celda ox+3).
    reply = await ask('@bot pon adoquines en ~2 ~ ~');
    record(
      'Coordenadas relativas al jugador (~2 ~ ~)',
      /listo: puse/i.test(reply) && (await blockIs(rcon, ox + 5, floor, oz, 'cobblestone')),
      reply,
    );

    // 4. Lejos: tiene que caminar hasta la esquina.
    reply = await ask(`@bot pon tierra en ${ox + 6} ${floor} ${oz - 6}`);
    record(
      'Camina hasta un lugar lejano para ponerlo',
      /listo: puse/i.test(reply) && (await blockIs(rcon, ox + 6, floor, oz - 6, 'dirt')),
      reply,
    );

    // 5. Parado justo donde va el bloque: debe correrse.
    await rconCommand(rcon, `tp ${agent} ${ox + 0.5} ${floor} ${oz + 3.5}`);
    await sleep(1500);
    reply = await ask(`@bot pon tierra en ${ox} ${floor} ${oz + 3}`);
    record(
      'Se corre si está parado donde va el bloque',
      /listo: puse/i.test(reply) && (await blockIs(rcon, ox, floor, oz + 3, 'dirt')),
      reply,
    );
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
