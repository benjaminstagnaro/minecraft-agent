import type { Bot } from 'mineflayer';
import type { z } from 'zod';
import type { Logger } from '../logger.js';

/**
 * Una herramienta = una acción real que el bot sabe hacer (picar, craftear, poner un bloque...).
 *
 * Se diseñan pensando en la etapa 3, cuando Claude las usará con *tool use*:
 *  - `name` y `description` son lo que verá el modelo.
 *  - `input` (zod) valida los parámetros y luego se convierte a JSON Schema.
 *  - `run` SIEMPRE termina: respeta `signal` (cancelación / tiempo máximo) y devuelve un
 *    resultado claro, también cuando falla. Nunca deja al bot colgado.
 */
export interface Tool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: Input;
  /** Tiempo máximo antes de cancelarla automáticamente. */
  timeoutMs: number;
  run(ctx: ToolContext, input: z.infer<Input>): Promise<ToolResult>;
}

export interface ToolContext {
  bot: Bot;
  log: Logger;
  /** Se activa con "@bot para", con una orden nueva o al vencer el tiempo máximo. */
  signal: AbortSignal;
  /** Para avisos de progreso en el chat (con moderación). */
  say: (message: string) => void;
}

export interface ToolResult {
  ok: boolean;
  /** Frase para el jugador (y, en la etapa 3, para Claude). */
  message: string;
  /** Datos estructurados opcionales (ej: cuántos bloques juntó). */
  data?: Record<string, unknown>;
}
