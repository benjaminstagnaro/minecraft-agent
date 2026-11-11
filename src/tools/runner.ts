import type { Bot } from 'mineflayer';
import { z } from 'zod';
import { createLogger, type Logger } from '../logger.js';
import { abortReason, isAbortError } from './abort.js';
import type { Tool, ToolResult } from './types.js';

interface RunningAction {
  tool: Tool;
  controller: AbortController;
  done: Promise<ToolResult>;
}

/**
 * Ejecuta las herramientas de a una:
 *  - valida los parámetros con zod antes de mover un dedo,
 *  - aplica el tiempo máximo de cada herramienta,
 *  - permite cancelar ("@bot para" o una orden nueva),
 *  - convierte cualquier error en un resultado legible (nunca revienta el bot),
 *  - y deja todo en el log: qué se pidió, qué herramienta, resultado y duración.
 */
export class ActionRunner {
  private current: RunningAction | undefined;
  private readonly log: Logger = createLogger('acciones');

  constructor(
    private readonly bot: Bot,
    private readonly say: (message: string) => void,
  ) {}

  /** Nombre de la herramienta en curso, si hay una. */
  get busyWith(): string | undefined {
    return this.current?.tool.name;
  }

  run<I extends z.ZodType>(tool: Tool<I>, rawInput: unknown): Promise<ToolResult> {
    // Ojo con la concurrencia: el puesto de "acción en curso" se toma de forma SINCRÓNICA,
    // antes de cualquier await. Si no, dos órdenes seguidas podrían no verse entre sí y
    // correr a la vez peleándose el pathfinder (lo detectó un test).
    const previous = this.current;
    const controller = new AbortController();
    const done = this.execute(tool, rawInput, controller, previous);
    this.current = { tool, controller, done };

    return done.then((result) => {
      if (this.current?.done === done) this.current = undefined;
      return result;
    });
  }

  private async execute<I extends z.ZodType>(
    tool: Tool<I>,
    rawInput: unknown,
    controller: AbortController,
    previous: RunningAction | undefined,
  ): Promise<ToolResult> {
    // Una orden nueva reemplaza a la anterior: esperar a que suelte todo antes de empezar.
    if (previous) {
      previous.controller.abort('reemplazada por una orden nueva');
      await previous.done;
    }
    if (controller.signal.aborted) {
      return { ok: false, message: `Detenido: ${abortReason(controller.signal)}.` };
    }

    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const message = `Parámetros inválidos para ${tool.name}: ${z.prettifyError(parsed.error)}`;
      this.log.warn(message);
      return { ok: false, message };
    }

    const timer = setTimeout(
      () => controller.abort(`se acabó el tiempo máximo (${tool.timeoutMs / 1000} s)`),
      tool.timeoutMs,
    );
    const startedAt = Date.now();
    const toolLog = createLogger(`tool:${tool.name}`);
    this.log.info(`▶ ${tool.name}`, parsed.data);

    let result: ToolResult;
    try {
      result = await tool.run(
        { bot: this.bot, log: toolLog, signal: controller.signal, say: this.say },
        parsed.data,
      );
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        result = { ok: false, message: `Detenido: ${abortReason(controller.signal)}.` };
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        toolLog.error('Error inesperado', error);
        result = { ok: false, message: `No pude terminar: ${detail}` };
      }
    } finally {
      clearTimeout(timer);
      // Que no quede nada andando: ni caminando, ni picando, ni con teclas apretadas.
      this.bot.pathfinder.setGoal(null);
      this.bot.stopDigging();
      this.bot.clearControlStates();
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.log[result.ok ? 'info' : 'warn'](
      `${result.ok ? '✔' : '✖'} ${tool.name} (${seconds} s): ${result.message}`,
    );
    return result;
  }

  /** Cancela la acción en curso (si hay) y espera a que termine de soltar todo. */
  async cancel(reason = 'cancelado por el jugador'): Promise<boolean> {
    const current = this.current;
    if (!current) return false;
    current.controller.abort(reason);
    await current.done;
    return true;
  }
}
