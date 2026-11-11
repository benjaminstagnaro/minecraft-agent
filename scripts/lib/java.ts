import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Minecraft 26.x exige Java 25 o superior. */
export const MIN_JAVA_MAJOR = 25;

/**
 * Extrae la versión mayor de la salida de `java -version`.
 * Ejemplos: `"25.0.1"` → 25, `"1.8.0_451"` → 8, `"21"` → 21.
 */
export function parseJavaMajor(versionOutput: string): number | undefined {
  const match = /version "([^"]+)"/.exec(versionOutput);
  if (!match?.[1]) return undefined;
  const parts = match[1].split(/[._-]/);
  const first = Number(parts[0]);
  if (Number.isNaN(first)) return undefined;
  return first === 1 ? Number(parts[1]) : first;
}

/**
 * Lugares donde buscar Java, en orden de preferencia:
 * 1. JAVA_PATH del .env  2. JAVA_HOME  3. `java` del PATH
 * 4. El Java que trae el launcher de Minecraft (así no hay que instalar nada).
 */
function candidates(): string[] {
  const list: string[] = [];
  const { JAVA_PATH, JAVA_HOME, LOCALAPPDATA, APPDATA } = process.env;
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const launcherRuntime = path.join(
    'runtime',
    'java-runtime-epsilon',
    'windows-x64',
    'java-runtime-epsilon',
    'bin',
    exe,
  );

  if (JAVA_PATH) list.push(JAVA_PATH);
  if (JAVA_HOME) list.push(path.join(JAVA_HOME, 'bin', exe));
  list.push('java');
  if (LOCALAPPDATA) {
    list.push(
      path.join(
        LOCALAPPDATA,
        'Packages',
        'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
        'LocalCache',
        'Local',
        launcherRuntime,
      ),
    );
  }
  if (APPDATA) list.push(path.join(APPDATA, '.minecraft', launcherRuntime));
  list.push(path.join('C:\\Program Files (x86)', 'Minecraft Launcher', launcherRuntime));
  return list;
}

async function javaMajor(javaPath: string): Promise<number | undefined> {
  try {
    // `java -version` escribe en stderr.
    const { stderr, stdout } = await execFileAsync(javaPath, ['-version'], { timeout: 10_000 });
    return parseJavaMajor(stderr + stdout);
  } catch {
    return undefined;
  }
}

export interface JavaInfo {
  path: string;
  major: number;
}

export async function findJava(): Promise<{ found?: JavaInfo; tried: string[] }> {
  const tried: string[] = [];
  for (const candidate of candidates()) {
    if (candidate !== 'java' && !existsSync(candidate)) continue;
    const major = await javaMajor(candidate);
    tried.push(`${candidate} → ${major === undefined ? 'no responde' : `Java ${major}`}`);
    if (major !== undefined && major >= MIN_JAVA_MAJOR)
      return { found: { path: candidate, major }, tried };
  }
  return { tried };
}
