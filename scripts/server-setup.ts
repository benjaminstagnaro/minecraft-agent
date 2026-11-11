/**
 * Prepara el servidor de pruebas en `server/` (carpeta fuera de git):
 *  1. Descarga el servidor OFICIAL de Mojang para MC_VERSION y verifica su SHA-1.
 *  2. Escribe server.properties con la configuración segura del proyecto.
 *  3. Acepta el EULA de Minecraft SOLO si se pasa `--acepto-eula` explícitamente.
 *
 * ¿Por qué vanilla y no Paper? Lo probamos: Paper 26.1.2 rechaza (y "teletransporta de
 * vuelta") cada movimiento de mineflayer en que el bot toca una pared, así que el bot no
 * puede saltar escalones y se queda pegado. El servidor vanilla no lo hace (0 correcciones).
 * Además vanilla es igual al juego real del usuario.
 *
 * Uso: npm run server:setup            (descarga y configura)
 *      npm run server:setup -- --acepto-eula
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import {
  ENV_FILE,
  EULA_FILE,
  RCON_PORT,
  SERVER_DIR,
  SERVER_JAR,
  SERVER_JAR_INFO,
  SERVER_PROPERTIES,
} from './lib/paths.js';
import { mergeProperties, readProperty } from './lib/properties.js';

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const USER_AGENT = 'minecraft-agent-setup/0.1.0 (github.com/benjaminstagnaro/minecraft-agent)';

interface ServerDownload {
  sha1: string;
  size: number;
  url: string;
}

interface JarInfo {
  version: string;
  sha1: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${url} respondió ${response.status}`);
  return (await response.json()) as T;
}

/** Busca en el manifiesto oficial de Mojang la descarga del servidor para `version`. */
async function getServerDownload(version: string): Promise<ServerDownload> {
  const manifest = await getJson<{ versions: { id: string; url: string }[] }>(VERSION_MANIFEST);
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Mojang no publica la versión ${version}.`);
  const details = await getJson<{ downloads?: { server?: ServerDownload } }>(entry.url);
  const server = details.downloads?.server;
  if (!server) throw new Error(`La versión ${version} no tiene servidor descargable.`);
  return server;
}

async function downloadServer(version: string): Promise<void> {
  const download = await getServerDownload(version);

  if (existsSync(SERVER_JAR) && existsSync(SERVER_JAR_INFO)) {
    const current = JSON.parse(await readFile(SERVER_JAR_INFO, 'utf8')) as JarInfo;
    if (current.version === version && current.sha1 === download.sha1) {
      console.log(`✔ Servidor vanilla ${version} ya está descargado.`);
      return;
    }
  }

  console.log(
    `↓ Descargando servidor vanilla ${version} desde Mojang (${(download.size / 1e6).toFixed(0)} MB)...`,
  );
  const response = await fetch(download.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Falló la descarga (${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());

  // Verificar integridad: si el hash no coincide, el archivo está corrupto o fue alterado.
  const sha1 = createHash('sha1').update(data).digest('hex');
  if (sha1 !== download.sha1) {
    throw new Error(`SHA-1 no coincide (esperado ${download.sha1}, obtenido ${sha1}).`);
  }

  await writeFile(SERVER_JAR, data);
  const info: JarInfo = { version, sha1 };
  await writeFile(SERVER_JAR_INFO, JSON.stringify(info, null, 2) + '\n');
  console.log(`✔ Servidor vanilla ${version} descargado y verificado (SHA-1 OK).`);
}

async function writeServerProperties(port: number, marker: string): Promise<void> {
  const existing = existsSync(SERVER_PROPERTIES) ? await readFile(SERVER_PROPERTIES, 'utf8') : '';
  // Se conserva la contraseña RCON si ya existía.
  const rconPassword = readProperty(existing, 'rcon.password') || randomBytes(18).toString('hex');

  // Siempre se aplican: protegen la regla 1 y permiten que el bot entre sin cuenta.
  const enforced = {
    'online-mode': 'false', // el bot entra sin cuenta de Microsoft
    'server-ip': '127.0.0.1', // solo accesible desde este PC (importante con online-mode=false)
    'server-port': String(port),
    motd: `${marker} Servidor de pruebas`, // marca que el bot exige antes de conectarse
    hardcore: 'false',
    'enforce-secure-profile': 'false',
    'enable-rcon': 'true', // para que los scripts manden comandos (op, tp, stop...)
    'rcon.port': String(RCON_PORT),
    'rcon.password': rconPassword,
  };

  // Valores iniciales cómodos para probar; puedes cambiarlos después en server.properties.
  const defaults = {
    'level-name': 'mundo-agente',
    gamemode: 'survival',
    difficulty: 'peaceful', // sin monstruos mientras desarrollamos
    'spawn-protection': '0',
    'allow-flight': 'true', // evita que el servidor expulse al bot por "volar" al saltar
    'max-players': '5',
    'view-distance': '10',
    'simulation-distance': '8',
  };

  await writeFile(SERVER_PROPERTIES, mergeProperties(existing, enforced, defaults));
  console.log('✔ server.properties listo (online-mode=false, solo localhost, RCON activo).');
}

async function handleEula(accept: boolean): Promise<boolean> {
  const current = existsSync(EULA_FILE) ? await readFile(EULA_FILE, 'utf8') : '';
  if (/^\s*eula\s*=\s*true\s*$/m.test(current)) {
    console.log('✔ EULA de Minecraft ya aceptado.');
    return true;
  }
  if (!accept) {
    console.log(
      '\n⚠ Falta aceptar el EULA de Minecraft para poder iniciar el servidor.\n' +
        '  Léelo aquí: https://aka.ms/MinecraftEULA\n' +
        '  Si estás de acuerdo, corre:  npm run server:setup -- --acepto-eula\n',
    );
    return false;
  }
  await writeFile(
    EULA_FILE,
    `# Aceptado con --acepto-eula el ${new Date().toISOString()}\n` +
      '# https://aka.ms/MinecraftEULA\n' +
      'eula=true\n',
  );
  console.log('✔ EULA de Minecraft aceptado.');
  return true;
}

async function main(): Promise<void> {
  const config = loadConfig(ENV_FILE);
  const acceptEula = process.argv.includes('--acepto-eula');

  console.log(`Servidor de pruebas: vanilla ${config.server.version} en ${SERVER_DIR}\n`);
  await mkdir(SERVER_DIR, { recursive: true });
  await downloadServer(config.server.version);
  await writeServerProperties(config.server.port, config.safety.serverMarker);
  const eulaOk = await handleEula(acceptEula);

  if (eulaOk) console.log('\nTodo listo. Inicia el servidor con:  npm run server:start');
}

main().catch((error: unknown) => {
  console.error('✖', error instanceof Error ? error.message : error);
  process.exit(1);
});
