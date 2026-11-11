import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Rutas absolutas, independientes de desde dónde se ejecute el script. */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SERVER_DIR = path.join(PROJECT_ROOT, 'server');
export const SERVER_JAR = path.join(SERVER_DIR, 'server.jar');
export const SERVER_JAR_INFO = path.join(SERVER_DIR, 'server-version.json');
export const SERVER_PROPERTIES = path.join(SERVER_DIR, 'server.properties');
export const EULA_FILE = path.join(SERVER_DIR, 'eula.txt');
export const ENV_FILE = path.join(PROJECT_ROOT, '.env');

/** Puerto RCON del servidor de pruebas (solo escucha en 127.0.0.1). */
export const RCON_PORT = 25575;
