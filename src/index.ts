import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { createLogger, setLogLevel } from './logger.js';
import { createAgentBot, type AgentBot } from './bot/agentBot.js';
import { isLocalHost, verifyTestServer } from './bot/safety.js';

const log = createLogger('main');

// Reconexión: si el servidor se reinicia, el bot vuelve solo (con espera creciente).
const RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000];

let current: AgentBot | undefined;
let shuttingDown = false;

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  setLogLevel(config.logLevel);

  const { host, port, version } = config.server;

  // Regla 1, capa 1: solo servidores locales salvo permiso explícito.
  if (!isLocalHost(host) && !config.safety.allowRemoteServer) {
    log.error(
      `MC_HOST=${host} no es local. Por seguridad el bot solo entra al servidor de pruebas ` +
        'local. Si de verdad quieres otro servidor, usa ALLOW_REMOTE_SERVER=true.',
    );
    process.exit(1);
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info(`Agente "${config.bot.name}" → ${host}:${port} (Minecraft ${version})`);

  let attempt = 0;
  while (!shuttingDown) {
    // Regla 1, capa 2: se verifica en CADA conexión, por si cambió lo que corre en ese puerto.
    const check = await verifyTestServer({
      host,
      port,
      marker: config.safety.serverMarker,
      expectedVersion: version,
    });

    if (!check.ok) {
      log.error(check.reason);
    } else {
      log.info(`Servidor de pruebas verificado: "${check.motd}" (${check.serverVersion})`);
      current = createAgentBot(config);
      const { reason, doNotReconnect } = await current.ended;
      current = undefined;

      if (doNotReconnect) {
        log.error(`No reintento: ${doNotReconnect}.`);
        process.exit(1);
      }
      if (shuttingDown) break;
      log.warn(`Se cortó la conexión (${reason}).`);
      attempt = 0; // estuvo conectado: reiniciar la espera
    }

    if (shuttingDown) break;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000;
    attempt++;
    log.info(`Reintento en ${delay / 1000} s... (Ctrl+C para salir)`);
    await sleep(delay);
  }
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Cerrando el agente...');
  current?.bot.quit('El agente se apagó');
  // Margen para que el mensaje de desconexión alcance a salir.
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch((error: unknown) => {
  log.error('Error fatal', error);
  process.exit(1);
});
