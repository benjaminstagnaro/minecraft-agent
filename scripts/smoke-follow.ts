/**
 * Prueba de humo de la etapa 1 (end-to-end, en el servidor real).
 *
 * Un segundo bot, "Probador", actúa como jugador. Para que la prueba sea exigente y
 * repetible, primero construye (por RCON) una ARENA en el cielo, sobre donde está el agente:
 *
 *        N  (z-)
 *     ┌─────────────────────────────┐   plataforma 33x33 con borde de vidrio
 *     │  A ················ B       │   A→B→C→D→A = recorrido del probador
 *     │                     ┊       │
 *     │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ░ ▓▓▓▓▓│   ▓ muro de 2 bloques, ░ única abertura
 *     │        ▒            ┊       │
 *     │  D ····▒··········· C       │   ▒ escalón de 1 bloque (hay que saltarlo)
 *     └─────────────────────────────┘
 *   + una franja de arbustos de bayas cruzando el tramo A→B (hacen daño: hay que rodearlos)
 *
 * Luego:
 *   1. "@bot sígueme" y recorre A→B→C→D→A: el agente debe rodear el muro por la abertura.
 *   2. "@bot para" y se aleja 20 bloques: el agente debe quedarse quieto.
 *   3. Se pone detrás del muro y dice "@bot ven": el agente debe encontrar el camino.
 * Al terminar, devuelve al agente a su lugar y BORRA la arena (el mundo queda como estaba).
 *
 * Requisitos: servidor encendido (npm run server:start) y agente conectado (npm run dev).
 * Uso: npm run smoke:follow
 */
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';
import { loadConfig } from '../src/config.js';
import { createMovements } from '../src/bot/pathing.js';
import { verifyTestServer } from '../src/bot/safety.js';
import { ENV_FILE } from './lib/paths.js';
import { rconCommand, readRconOptions, type RconOptions } from './lib/rcon.js';

const { pathfinder, goals } = pathfinderPkg;

const TESTER_NAME = 'Probador';
const ARENA_Y = 200; // altura del piso de la arena (muy por sobre el terreno)
const HALF = 16; // la arena va de -16 a +16 alrededor del origen
const FOLLOW_TOLERANCE = 5; // followDistance (2) + margen por inercia y desniveles

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}: ${detail}`);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  everyMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(everyMs);
  }
  return predicate();
}

/** Espera un mensaje de chat del agente que calce con `pattern`. */
function waitForAgentChat(
  bot: Bot,
  agentName: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const onChat = (username: string, message: string): void => {
      if (username === agentName && pattern.test(message)) {
        cleanup();
        resolve(message);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      bot.off('chat', onChat);
    };
    bot.on('chat', onChat);
  });
}

/** Mide cuánto camina una entidad (suma de tramos), muestreando su posición. */
class PathMeter {
  private total = 0;
  private last: Vec3 | undefined;
  private readonly timer: NodeJS.Timeout;

  constructor(getPosition: () => Vec3 | undefined) {
    this.timer = setInterval(() => {
      const pos = getPosition();
      if (pos && this.last) this.total += pos.distanceTo(this.last);
      if (pos) this.last = pos.clone();
    }, 250);
  }

  stop(): number {
    clearInterval(this.timer);
    return this.total;
  }
}

async function rconExpect(rcon: RconOptions, command: string, ok: RegExp): Promise<void> {
  const response = await rconCommand(rcon, command);
  if (!ok.test(response)) throw new Error(`RCON "${command}" respondió: ${response}`);
}

/** Construye la arena alrededor de (ox, oz). */
async function buildArena(rcon: RconOptions, ox: number, oz: number): Promise<void> {
  const y = ARENA_Y;
  const [x1, x2, z1, z2] = [ox - HALF, ox + HALF, oz - HALF, oz + HALF];
  const filled = /filled|rellen/i;
  await rconExpect(rcon, `fill ${x1} ${y + 1} ${z1} ${x2} ${y + 4} ${z2} air`, /./);
  await rconExpect(rcon, `fill ${x1} ${y} ${z1} ${x2} ${y} ${z2} smooth_stone`, filled);
  // Borde de vidrio de 2 bloques para que nadie se caiga.
  for (const [ax, az, bx, bz] of [
    [x1, z1, x2, z1],
    [x1, z2, x2, z2],
    [x1, z1, x1, z2],
    [x2, z1, x2, z2],
  ] as const) {
    await rconExpect(rcon, `fill ${ax} ${y + 1} ${az} ${bx} ${y + 2} ${bz} glass`, filled);
  }
  // Muro este-oeste con una sola abertura de 2 bloques cerca del lado este.
  await rconExpect(
    rcon,
    `fill ${x1 + 1} ${y + 1} ${oz} ${x2 - 1} ${y + 2} ${oz} stone_bricks`,
    filled,
  );
  await rconExpect(rcon, `fill ${ox + 9} ${y + 1} ${oz} ${ox + 10} ${y + 2} ${oz} air`, filled);
  // Escalón de 1 bloque en la mitad sur.
  await rconExpect(
    rcon,
    `fill ${ox - 4} ${y + 1} ${oz + 2} ${ox - 4} ${y + 1} ${z2 - 1} stone_bricks`,
    filled,
  );
  // Franja de arbustos de bayas (sobre tierra) cruzando el tramo A→B, con un paso libre
  // junto al muro. Atravesarlos hace daño: el agente debe rodearlos.
  await rconExpect(rcon, `fill ${ox} ${y} ${z1 + 1} ${ox} ${y} ${oz - 5} dirt`, filled);
  await rconExpect(
    rcon,
    `fill ${ox} ${y + 1} ${z1 + 1} ${ox} ${y + 1} ${oz - 5} sweet_berry_bush[age=3]`,
    filled,
  );
}

/** Vigila la vida del agente (por RCON) y guarda la mínima. */
class HealthWatch {
  min = Infinity;
  start: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly rcon: RconOptions,
    private readonly agentName: string,
  ) {}

  async read(): Promise<number | undefined> {
    const response = await rconCommand(this.rcon, `data get entity ${this.agentName} Health`);
    const match = /([\d.]+)f?\s*$/.exec(response.trim());
    return match ? Number(match[1]) : undefined;
  }

  async begin(): Promise<void> {
    this.start = await this.read();
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.read()
        .then((health) => {
          if (health !== undefined) this.min = Math.min(this.min, health);
        })
        .catch(() => undefined)
        .finally(() => (this.busy = false));
    }, 400);
  }

  end(): void {
    clearInterval(this.timer);
  }
}

async function removeArena(rcon: RconOptions, ox: number, oz: number): Promise<void> {
  const y = ARENA_Y;
  await rconCommand(
    rcon,
    `fill ${ox - HALF} ${y} ${oz - HALF} ${ox + HALF} ${y + 4} ${oz + HALF} air`,
  );
}

/** Camina hacia (x, z) sobre la arena. Devuelve si llegó antes del timeout. */
async function walkTo(bot: Bot, x: number, z: number, timeoutMs = 30_000): Promise<boolean> {
  const goal = new goals.GoalNear(x + 0.5, ARENA_Y + 1, z + 0.5, 1);
  const timeout = sleep(timeoutMs).then(() => 'timeout' as const);
  try {
    const outcome = await Promise.race([
      bot.pathfinder.goto(goal).then(() => 'ok' as const),
      timeout,
    ]);
    if (outcome === 'timeout') {
      bot.pathfinder.setGoal(null);
      console.log(`    [probador] timeout caminando a (${x}, ${z})`);
    }
    return outcome === 'ok';
  } catch (error) {
    const p = bot.entity.position;
    console.log(
      `    [probador] el pathfinder falló en (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}): ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

function agentPos(bot: Bot, agentName: string): Vec3 | undefined {
  return bot.players[agentName]?.entity?.position;
}

function distanceToAgent(bot: Bot, agentName: string): number {
  const pos = agentPos(bot, agentName);
  return pos ? pos.distanceTo(bot.entity.position) : Infinity;
}

async function main(): Promise<void> {
  const config = loadConfig(ENV_FILE);
  const { host, port, version } = config.server;
  const agentName = config.bot.name;

  // El probador también respeta la regla 1: solo entra al servidor de pruebas.
  const check = await verifyTestServer({
    host,
    port,
    marker: config.safety.serverMarker,
    expectedVersion: version,
  });
  if (!check.ok) throw new Error(check.reason);

  const rcon = readRconOptions();
  const bot = mineflayer.createBot({ host, port, version, username: TESTER_NAME, auth: 'offline' });
  bot.loadPlugin(pathfinder);
  await new Promise<void>((resolve, reject) => {
    bot.once('spawn', () => resolve());
    bot.once('kicked', (reason) => reject(new Error(`Probador expulsado: ${reason}`)));
    bot.once('error', reject);
  });
  // El probador se mueve con la misma configuración que el agente (no rompe nada, esquiva bayas).
  bot.pathfinder.setMovements(createMovements(bot));

  if (!bot.players[agentName]) {
    throw new Error(`${agentName} no está conectado. Inicia el agente con: npm run dev`);
  }

  // Origen de la arena: sobre donde está el agente (así los chunks ya están cargados).
  await rconCommand(rcon, `tp ${TESTER_NAME} ${agentName}`);
  await waitFor(() => agentPos(bot, agentName) !== undefined, 10_000);
  const agentHome = agentPos(bot, agentName)?.clone();
  if (!agentHome) throw new Error(`No veo la entidad de ${agentName}.`);
  const ox = Math.floor(agentHome.x);
  const oz = Math.floor(agentHome.z);

  const A: [number, number] = [ox - 10, oz - 10];
  const B: [number, number] = [ox + 10, oz - 10];
  const C: [number, number] = [ox + 10, oz + 10];
  const D: [number, number] = [ox - 10, oz + 10];

  try {
    console.log(`Construyendo arena en (${ox}, ${ARENA_Y}, ${oz})...`);
    await rconCommand(rcon, 'time set day');
    await rconCommand(rcon, 'weather clear');
    await buildArena(rcon, ox, oz);
    await rconCommand(rcon, `tp ${TESTER_NAME} ${A[0] + 0.5} ${ARENA_Y + 1} ${A[1] + 0.5}`);
    await rconCommand(rcon, `tp ${agentName} ${A[0] - 1.5} ${ARENA_Y + 1} ${A[1] + 0.5}`);
    await waitFor(() => distanceToAgent(bot, agentName) < 4, 10_000);
    await sleep(2000); // que ambos aterricen y reciban los chunks

    // ── 1. Sígueme ─────────────────────────────────────────────────────────────
    const followReply = waitForAgentChat(bot, agentName, /te sigo/i, 5000);
    bot.chat('@bot sígueme');
    const followText = await followReply;
    record('Responde a "sígueme"', followText !== null, followText ?? 'sin respuesta');

    const agentMeter = new PathMeter(() => agentPos(bot, agentName));
    const health = new HealthWatch(rcon, agentName);
    await health.begin();
    let worst = 0;
    for (const [label, [x, z]] of [
      ['A→B (esquivando bayas)', B],
      ['B→C (por la abertura)', C],
      ['C→D (saltando el escalón)', D],
      ['D→A (rodeando el muro)', A],
    ] as const) {
      const testerMeter = new PathMeter(() => bot.entity.position);
      const reached = await walkTo(bot, x, z, 40_000);
      await sleep(4000); // tiempo para que el agente me alcance
      const walked = testerMeter.stop();
      const d = distanceToAgent(bot, agentName);
      worst = Math.max(worst, d);
      console.log(
        `  ${label.padEnd(26)} probador caminó ${walked.toFixed(0).padStart(2)} bloques` +
          `${reached ? '' : ' (no llegó)'} → agente a ${d.toFixed(1)}`,
      );
      if (!reached)
        throw new Error(`El probador no pudo completar ${label}; arena mal construida?`);
    }
    const agentWalked = agentMeter.stop();
    record(
      'Sigue al jugador rodeando obstáculos',
      worst <= FOLLOW_TOLERANCE,
      `peor distancia ${worst.toFixed(1)} (máx ${FOLLOW_TOLERANCE}); el agente caminó ${agentWalked.toFixed(0)} bloques`,
    );
    health.end();
    const startHealth = health.start ?? NaN;
    record(
      'No se hace daño en el recorrido (bayas)',
      Number.isFinite(health.min) && health.min >= startHealth,
      `vida al inicio ${startHealth.toFixed(1)}, mínima ${health.min.toFixed(1)}`,
    );

    // ── 2. Para ────────────────────────────────────────────────────────────────
    const stopReply = waitForAgentChat(bot, agentName, /me quedo/i, 5000);
    bot.chat('@bot para');
    const stopText = await stopReply;
    record('Responde a "para"', stopText !== null, stopText ?? 'sin respuesta');
    await sleep(1000);
    const stoppedAt = agentPos(bot, agentName)?.clone();
    await walkTo(bot, B[0], B[1]);
    await sleep(4000);
    const away = distanceToAgent(bot, agentName);
    const movedAfterStop = stoppedAt
      ? (agentPos(bot, agentName)?.distanceTo(stoppedAt) ?? Infinity)
      : Infinity;
    record(
      'Se queda quieto tras "para"',
      movedAfterStop < 1.5 && away >= 10,
      `se movió ${movedAfterStop.toFixed(1)} bloques mientras me alejé a ${away.toFixed(0)}`,
    );

    // ── 3. Ven (detrás del muro) ──────────────────────────────────────────────
    await walkTo(bot, D[0], D[1], 40_000);
    const startDistance = distanceToAgent(bot, agentName);
    const arrivedReply = waitForAgentChat(bot, agentName, /aqu[ií] estoy/i, 50_000);
    const comeStart = Date.now();
    bot.chat('@bot ven');
    const arrived = await waitFor(() => distanceToAgent(bot, agentName) <= 3.5, 45_000);
    const seconds = ((Date.now() - comeStart) / 1000).toFixed(1);
    record(
      'Llega tras "ven" (rodeando el muro)',
      arrived && startDistance >= 10,
      `partió a ${startDistance.toFixed(0)} bloques, llegó a ${distanceToAgent(bot, agentName).toFixed(1)} en ${seconds} s`,
    );
    const arrivedText = await arrivedReply;
    record('Avisa que llegó', arrivedText !== null, arrivedText ?? 'sin aviso');
  } finally {
    // Dejar todo como estaba: agente de vuelta en su lugar y arena borrada.
    bot.chat('@bot para');
    await sleep(500);
    await rconCommand(rcon, `tp ${agentName} ${agentHome.x} ${agentHome.y} ${agentHome.z}`);
    await rconCommand(rcon, `tp ${TESTER_NAME} ${agentHome.x} ${agentHome.y} ${agentHome.z}`);
    await sleep(500);
    await removeArena(rcon, ox, oz);
    console.log('Arena borrada; agente devuelto a su posición.');
    bot.quit('Prueba terminada');
  }
}

main()
  .catch((error: unknown) => {
    record('Prueba', false, error instanceof Error ? error.message : String(error));
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      `\n${failed === 0 ? 'PRUEBA OK' : 'PRUEBA FALLIDA'}: ${results.length - failed}/${results.length} chequeos`,
    );
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300);
  });
