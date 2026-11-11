// Lanzador de Vitest.
//
// ¿Por qué existe? En Windows, VS Code a veces abre la terminal en "c:\..." (letra de
// unidad en minúscula). Vitest entonces carga su propio módulo dos veces (como "c:\" y
// "C:\") y todos los tests fallan con "Cannot read properties of undefined (reading
// 'config')". Arrancar Vitest desde la ruta con la letra en mayúscula lo evita.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/^[a-z]:/, (drive) =>
  drive.toUpperCase(),
);
const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

const result = spawnSync(process.execPath, [vitestBin, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
