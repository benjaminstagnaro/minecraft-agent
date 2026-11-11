/**
 * Inicia el servidor de pruebas (vanilla) con el Java correcto.
 * La consola queda conectada: puedes escribir comandos del servidor (ej. `op TuNombre`, `stop`).
 * Ctrl+C apaga el servidor de forma ordenada (guarda el mundo).
 *
 * Uso: npm run server:start
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { findJava, MIN_JAVA_MAJOR } from './lib/java.js';
import { ENV_FILE, EULA_FILE, SERVER_DIR, SERVER_JAR } from './lib/paths.js';

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig(ENV_FILE);

  if (!existsSync(SERVER_JAR))
    fail('No está el servidor descargado. Corre primero: npm run server:setup');
  const eula = existsSync(EULA_FILE) ? readFileSync(EULA_FILE, 'utf8') : '';
  if (!/^\s*eula\s*=\s*true\s*$/m.test(eula)) {
    fail('Falta aceptar el EULA. Corre: npm run server:setup -- --acepto-eula');
  }

  const { found: java, tried } = await findJava();
  if (!java) {
    fail(
      `No encontré Java ${MIN_JAVA_MAJOR}+ (Minecraft ${config.server.version} lo necesita).\n` +
        `  Probé:\n    ${tried.join('\n    ') || '(nada)'}\n` +
        '  Opciones: abre una vez Minecraft 26.x desde el launcher (descarga su Java),\n' +
        '  o instala Java 25 y pon su ruta en JAVA_PATH dentro de .env',
    );
  }

  const memory = process.env.SERVER_MEMORY ?? '2G';
  console.log(`Java ${java.major}: ${java.path}`);
  console.log(
    `Iniciando Minecraft vanilla ${config.server.version} con ${memory} de RAM...\n` +
      `  Conéctate desde Minecraft ${config.server.version} → Multijugador → localhost:${config.server.port}\n` +
      '  Comandos útiles en esta consola: op <tu_nombre>, time set day, stop\n',
  );

  const server = spawn(
    java.path,
    [`-Xms${memory}`, `-Xmx${memory}`, '-jar', SERVER_JAR, '--nogui'],
    {
      cwd: SERVER_DIR,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );

  // Reenviar lo que escribes a la consola del servidor. `end: false` para poder mandar
  // "stop" al cerrar aunque la entrada estándar ya se haya cerrado.
  process.stdin.pipe(server.stdin, { end: false });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('\nApagando el servidor (guardando el mundo)...');
    server.stdin.write('stop\n');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  server.on('exit', (code) => {
    console.log(`Servidor detenido (código ${code ?? 'desconocido'}).`);
    process.exit(code ?? 0);
  });
}

main().catch((error: unknown) => {
  console.error('✖', error instanceof Error ? error.message : error);
  process.exit(1);
});
