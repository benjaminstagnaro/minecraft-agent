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
import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Vec3 } from 'vec3';
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

const { goals } = pathfinderPkg;
const ARENA_Y = 200; // altura del piso de la arena (muy por sobre el terreno)
const HALF = 16; // la arena va de -16 a +16 alrededor del origen
const FOLLOW_TOLERANCE = 5; // followDistance (2) + margen por inercia y desniveles

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
  const agentName = config.bot.name;
  const rcon = readRconOptions();
  const bot = await connectTester(config);

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

    // ── 4. No rompió nada ──────────────────────────────────────────────────────
    // Rellenar con ladrillo el aire del muro: si está intacto, solo se rellena la abertura
    // (2x2 = 4 bloques). Si el agente hubiera abierto hoyos, serían más.
    const y = ARENA_Y;
    const fill = await rconCommand(
      rcon,
      `fill ${ox - HALF + 1} ${y + 1} ${oz} ${ox + HALF - 1} ${y + 2} ${oz} stone_bricks replace air`,
    );
    const holes = Number(/(\d+)/.exec(fill)?.[1] ?? NaN);
    record(
      'No rompe bloques al seguir',
      holes === 4,
      `aire en el muro: ${holes} (esperado 4: la abertura)`,
    );
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
  .finally(finish);
