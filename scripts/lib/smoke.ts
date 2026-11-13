/**
 * Utilidades compartidas por las pruebas end-to-end (scripts/smoke-*.ts).
 * Cada prueba conecta un bot "Probador" que actúa como jugador y usa RCON para preparar
 * el escenario y verificar resultados en el servidor real.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { createMovements } from '../../src/bot/pathing.js';
import { verifyTestServer } from '../../src/bot/safety.js';
import type { AppConfig } from '../../src/config.js';
import { rconCommand, type RconOptions } from './rcon.js';

const { pathfinder } = pathfinderPkg;

export const TESTER_NAME = 'Probador';

// ─────────────────────────────── resultados ───────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

export function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}: ${detail}`);
}

/** Imprime el resumen y termina el proceso con código 0 (todo OK) o 1. */
export function finish(): void {
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${failed === 0 ? 'PRUEBA OK' : 'PRUEBA FALLIDA'}: ${results.length - failed}/${results.length} chequeos`,
  );
  setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300);
}

// ─────────────────────────────── esperas ───────────────────────────────

export async function waitFor(
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
export function waitForAgentChat(
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

// ─────────────────────────────── RCON ───────────────────────────────

/** Ejecuta un comando por RCON y exige que la respuesta calce con `ok`. */
export async function rconExpect(rcon: RconOptions, command: string, ok: RegExp): Promise<string> {
  const response = await rconCommand(rcon, command);
  if (!ok.test(response)) throw new Error(`RCON "${command}" respondió: ${response}`);
  return response;
}

// ─────────────────────────────── probador ───────────────────────────────

/** Conecta el bot probador (verificando antes que sea el servidor de pruebas). */
export async function connectTester(config: AppConfig): Promise<Bot> {
  const { host, port, version } = config.server;
  // El probador también respeta la regla 1: solo entra al servidor de pruebas.
  const check = await verifyTestServer({
    host,
    port,
    marker: config.safety.serverMarker,
    expectedVersion: version,
  });
  if (!check.ok) throw new Error(check.reason);

  const bot = mineflayer.createBot({ host, port, version, username: TESTER_NAME, auth: 'offline' });
  bot.loadPlugin(pathfinder);
  await new Promise<void>((resolve, reject) => {
    bot.once('spawn', () => resolve());
    bot.once('kicked', (reason) => reject(new Error(`Probador expulsado: ${reason}`)));
    bot.once('error', reject);
  });
  // El probador se mueve con la misma configuración que el agente (no rompe nada, esquiva bayas).
  bot.pathfinder.setMovements(createMovements(bot));

  if (!bot.players[config.bot.name]) {
    bot.quit();
    throw new Error(`${config.bot.name} no está conectado. Inicia el agente con: npm run dev`);
  }
  return bot;
}

// ─────────────────────────────── vida del agente ───────────────────────────────

/** Vigila la vida del agente (por RCON) y guarda la mínima. */
export class HealthWatch {
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
