/**
 * Manda un comando al servidor de pruebas por RCON y muestra la respuesta.
 *
 * Uso: npm run server:cmd -- op TuNombre
 *      npm run server:cmd -- time set day
 *      npm run server:cmd -- stop
 */
import { rconCommand, readRconOptions } from './lib/rcon.js';

async function main(): Promise<void> {
  const command = process.argv.slice(2).join(' ').trim();
  if (!command) {
    console.error('Uso: npm run server:cmd -- <comando>   (ej: op TuNombre)');
    process.exit(1);
  }
  const response = await rconCommand(readRconOptions(), command);
  console.log(response || '(sin respuesta)');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✖ ${message}`);
  if (message.includes('ECONNREFUSED'))
    console.error('  ¿Está encendido el servidor? (npm run server:start)');
  process.exit(1);
});
