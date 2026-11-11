import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { HELP_TEXT, parseCommand, type Command } from './commands.js';
import { MovementController } from './movement.js';
import { isHardcoreLogin } from './safety.js';

const { pathfinder } = pathfinderPkg;

const log = createLogger('bot');
const chatLog = createLogger('chat');

// Límite de largo de un mensaje de chat en Minecraft.
const MAX_CHAT_LENGTH = 256;

export interface BotEnd {
  reason: string;
  /** Si viene, NO hay que reconectar: explica por qué. */
  doNotReconnect?: string;
}

export interface AgentBot {
  bot: Bot;
  /** Se resuelve cuando el bot se desconecta. */
  ended: Promise<BotEnd>;
}

/**
 * Crea el bot, lo conecta y conecta el chat con los comandos.
 * Etapa 1: comandos fijos. En la etapa 3 el texto libre irá al agente con Claude.
 */
export function createAgentBot(config: AppConfig): AgentBot {
  const bot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    username: config.bot.name,
    version: config.server.version,
    auth: 'offline', // el servidor de pruebas usa online-mode=false
    hideErrors: true, // los errores los logueamos nosotros, legibles
  });
  bot.loadPlugin(pathfinder);

  let movement: MovementController | undefined;
  let safetyStop = false;
  let doNotReconnect: string | undefined;

  const say = (message: string): void => {
    const text = message.slice(0, MAX_CHAT_LENGTH);
    chatLog.info(`${bot.username} → ${text}`);
    bot.chat(text);
  };

  // Regla 1, capa 3: si por cualquier motivo entramos a un mundo hardcore, salir YA.
  // Se lee el paquete crudo porque `bot.game.hardcore` no es confiable en 26.1 (ver safety.ts).
  bot._client.once('login', (packet: unknown) => {
    if (isHardcoreLogin(packet) || bot.game.hardcore) {
      safetyStop = true;
      doNotReconnect = 'el mundo es hardcore (regla 1 del proyecto)';
      log.error('¡El mundo es HARDCORE! Me desconecto de inmediato por seguridad.');
      bot.quit('Mundo hardcore detectado');
    }
  });

  bot.once('login', () => {
    if (safetyStop) return;
    log.info(`Login OK como ${bot.username} (${bot.game.gameMode}, ${bot.game.dimension})`);
  });

  bot.once('spawn', () => {
    if (safetyStop) return;
    movement = new MovementController(bot, createLogger('movimiento'), say);
    const p = bot.entity.position;
    log.info(`Apareció en (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`);
    say(`¡Hola! Soy ${bot.username}, tu agente. Escribe "@bot ayuda" para ver qué sé hacer.`);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username || !movement) return;
    const command = parseCommand(message, bot.username);
    if (!command) return;

    chatLog.info(`${username}: ${message}`, { comando: command.kind });
    handleCommand(command, username, movement, say);
  });

  bot.on('kicked', (reason) => {
    log.warn('El servidor me expulsó', reason);
    // Otro proceso entró con el mismo nombre. Si reconectamos, los dos se expulsarían
    // mutuamente para siempre: mejor detenerse y avisar.
    if (JSON.stringify(reason).includes('duplicate_login')) {
      doNotReconnect = `ya hay otro bot conectado como "${bot.username}" (¿quedó otro agente abierto?)`;
    }
  });
  bot.on('error', (error) => log.error('Error de conexión', error));

  const ended = new Promise<BotEnd>((resolve) => {
    bot.once('end', (reason) => {
      movement?.dispose();
      log.info(`Desconectado (${reason})`);
      resolve(doNotReconnect ? { reason, doNotReconnect } : { reason });
    });
  });

  return { bot, ended };
}

function handleCommand(
  command: Command,
  username: string,
  movement: MovementController,
  say: (message: string) => void,
): void {
  switch (command.kind) {
    case 'follow':
      movement.follow(username);
      break;
    case 'come':
      movement.comeTo(username);
      break;
    case 'stop':
      movement.stop();
      break;
    case 'help':
      say(HELP_TEXT);
      break;
    case 'unknown':
      say(`No entendí "${command.text}". ${HELP_TEXT}`);
      break;
  }
}
