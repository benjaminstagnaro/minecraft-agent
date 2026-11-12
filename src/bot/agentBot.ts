import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { collectBlockTool } from '../tools/collectBlock.js';
import { craftItemTool } from '../tools/craftItem.js';
import { placeBlockTool } from '../tools/placeBlock.js';
import { getStatusTool } from '../tools/getStatus.js';
import { ActionRunner } from '../tools/runner.js';
import { HELP_TEXT, parseCommand, resolveCoordinates, type Command } from './commands.js';
import { MovementController } from './movement.js';
import { resolveBlockGroup, resolveItemGroup } from './names.js';
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
  let runner: ActionRunner | undefined;
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
    runner = new ActionRunner(bot, say);
    const p = bot.entity.position;
    log.info(`Apareció en (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`);
    say(`¡Hola! Soy ${bot.username}, tu agente. Escribe "@bot ayuda" para ver qué sé hacer.`);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username || !movement || !runner) return;
    const command = parseCommand(message, bot.username);
    if (!command) return;

    chatLog.info(`${username}: ${message}`, { comando: command.kind });
    handleCommand(command, username, { bot, movement, runner, say }).catch((error: unknown) => {
      log.error(`Error al ejecutar "${command.kind}"`, error);
      say('Algo falló al ejecutar eso. Revisa el log del agente.');
    });
  });

  // Registrar cada vez que pierde vida y sobre qué bloque estaba: así se diagnostican
  // cosas como "se pincha con los arbustos de bayas" sin tener que estar mirando el juego.
  let lastHealth: number | undefined;
  bot.on('health', () => {
    if (lastHealth !== undefined && bot.health < lastHealth) {
      const p = bot.entity.position;
      log.warn(
        `Recibí daño: ${lastHealth.toFixed(1)} → ${bot.health.toFixed(1)} de vida en ` +
          `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}); tocando: ${blocksTouching(bot).join(', ') || 'nada'}`,
      );
    }
    lastHealth = bot.health;
  });
  bot.on('death', () => log.warn('Morí. Reaparezco en el punto de spawn.'));

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
      void runner?.cancel('el bot se desconectó');
      log.info(`Desconectado (${reason})`);
      resolve(doNotReconnect ? { reason, doNotReconnect } : { reason });
    });
  });

  return { bot, ended };
}

/**
 * Bloques (distintos de aire) que se cruzan con la caja de colisión del jugador
 * (0,6 de ancho x 1,8 de alto). Más útil que mirar solo el bloque del centro: un
 * arbusto de bayas hace daño aunque solo lo rocemos con el borde.
 */
function blocksTouching(bot: Bot): string[] {
  const p = bot.entity.position;
  const names = new Set<string>();
  for (let x = Math.floor(p.x - 0.3); x <= Math.floor(p.x + 0.3); x++) {
    for (let y = Math.floor(p.y); y <= Math.floor(p.y + 1.8); y++) {
      for (let z = Math.floor(p.z - 0.3); z <= Math.floor(p.z + 0.3); z++) {
        const block = bot.blockAt(p.offset(x - p.x, y - p.y, z - p.z).floor());
        if (block && block.name !== 'air') names.add(`${block.name}@${x},${y},${z}`);
      }
    }
  }
  return [...names];
}

interface CommandContext {
  bot: Bot;
  movement: MovementController;
  runner: ActionRunner;
  say: (message: string) => void;
}

/**
 * Ejecuta un comando. Regla: una orden nueva reemplaza a la anterior (si estaba juntando
 * troncos y le dices "sígueme", deja de juntar y te sigue). "@bot para" detiene todo.
 */
async function handleCommand(
  command: Command,
  username: string,
  ctx: CommandContext,
): Promise<void> {
  const { bot, movement, runner, say } = ctx;

  switch (command.kind) {
    case 'follow':
      await runner.cancel('reemplazada por "sígueme"');
      movement.follow(username);
      break;
    case 'come':
      await runner.cancel('reemplazada por "ven"');
      movement.comeTo(username);
      break;
    case 'stop': {
      const wasWorking = await runner.cancel('cancelado por el jugador');
      // Si estaba trabajando, el aviso "Detenido: ..." ya lo da la acción cancelada.
      movement.stop(wasWorking);
      break;
    }
    case 'help':
      say(HELP_TEXT);
      break;
    case 'status': {
      const result = await runner.run(getStatusTool, {});
      say(result.message);
      break;
    }
    case 'collect': {
      const group = resolveBlockGroup(
        command.what,
        (name) => bot.registry.blocksByName[name] !== undefined,
      );
      if (!group) {
        say(`No sé qué es "${command.what}". Prueba con troncos, tierra, arena, grava o piedra.`);
        return;
      }
      movement.stop(true);
      say(`Voy a juntar ${command.count} ${group.label}.`);
      const result = await runner.run(collectBlockTool, {
        blocks: group.blocks,
        count: command.count,
        label: group.label,
      });
      say(result.message);
      break;
    }
    case 'craft': {
      const group = resolveItemGroup(
        command.what,
        (name) => bot.registry.itemsByName[name] !== undefined,
      );
      if (!group) {
        say(`No sé fabricar "${command.what}". Prueba con tablones, palos, mesa o pico de madera.`);
        return;
      }
      movement.stop(true);
      const result = await runner.run(craftItemTool, {
        items: group.items,
        count: command.count,
        label: group.label,
      });
      say(result.message);
      break;
    }
    case 'place': {
      // "tablones", "antorcha", "adoquines" (ítems) o "tierra", "arena", "troncos" (bloques).
      const items = resolveItemGroup(
        command.what,
        (n) => bot.registry.itemsByName[n] !== undefined,
      );
      const blocks = resolveBlockGroup(
        command.what,
        (n) => bot.registry.blocksByName[n] !== undefined,
      );
      const names = items?.items ?? blocks?.blocks;
      const label = items?.label ?? blocks?.label ?? command.what;
      if (!names) {
        say(
          `No sé qué bloque es "${command.what}". Prueba con tierra, adoquines, tablones o troncos.`,
        );
        return;
      }
      // "~" es relativo a la posición del jugador que lo pidió, como en los comandos de Minecraft.
      const target = resolveCoordinates(command.at, bot.players[username]?.entity?.position);
      if (!target) {
        say('No te veo, así que no puedo usar "~". Usa coordenadas exactas (las ves con F3).');
        return;
      }
      movement.stop(true);
      const result = await runner.run(placeBlockTool, { blocks: names, ...target, label });
      say(result.message);
      break;
    }
    case 'unknown':
      say(`No entendí "${command.text}". ${HELP_TEXT}`);
      break;
  }
}
