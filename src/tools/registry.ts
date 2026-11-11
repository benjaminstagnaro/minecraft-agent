import { collectBlockTool } from './collectBlock.js';
import { craftItemTool } from './craftItem.js';
import { getStatusTool } from './getStatus.js';
import type { Tool } from './types.js';

/**
 * Todas las herramientas del bot. En la etapa 3 esta lista se le entrega a Claude
 * (nombre + descripción + JSON Schema de los parámetros).
 */
export const TOOLS = [
  getStatusTool,
  collectBlockTool,
  craftItemTool,
] as const satisfies readonly Tool[];
