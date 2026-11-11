import type { Bot } from 'mineflayer';
import type pathfinderPkg from 'mineflayer-pathfinder';

/**
 * Utilidades para que cada acción se pueda cancelar en cualquier momento.
 *
 * Mineflayer no acepta AbortSignal, así que cada operación larga (caminar, picar, esperar)
 * se "envuelve": si llega la cancelación, se detiene la operación real (pathfinder,
 * excavación) y se lanza un AbortError.
 */

type Goal = InstanceType<typeof pathfinderPkg.goals.Goal>;
type Block = NonNullable<ReturnType<Bot['blockAt']>>;

export class AbortError extends Error {
  override name = 'AbortError';
}

export function isAbortError(error: unknown): error is AbortError {
  return error instanceof AbortError;
}

/** Motivo legible de la cancelación (lo que se pasó a `controller.abort(motivo)`). */
export function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : 'cancelado';
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError(abortReason(signal));
}

/**
 * Espera una promesa, pero corta si llega la cancelación o se vence `timeoutMs`.
 * `onStop` detiene la operación real (por ejemplo, el pathfinder).
 */
export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  options: { timeoutMs?: number; onStop?: () => void; what?: string } = {},
): Promise<T> {
  throwIfAborted(signal);
  const { timeoutMs, onStop, what = 'la operación' } = options;

  let cleanup = (): void => undefined;
  const interrupted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new AbortError(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => reject(new Error(`${what} tardó más de ${timeoutMs / 1000} s`)),
            timeoutMs,
          );
    cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
  });

  try {
    return await Promise.race([promise, interrupted]);
  } catch (error) {
    onStop?.();
    // La promesa original puede rechazarse después (ej: el pathfinder al detenerlo): ignorar.
    promise.catch(() => undefined);
    throw error;
  } finally {
    cleanup();
  }
}

/** Caminar hasta un objetivo del pathfinder, cancelable. */
export function gotoGoal(
  bot: Bot,
  goal: Goal,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  return abortable(bot.pathfinder.goto(goal), signal, {
    timeoutMs,
    what: 'llegar al destino',
    onStop: () => bot.pathfinder.setGoal(null),
  });
}

/** Picar un bloque, cancelable. */
export function digBlock(
  bot: Bot,
  block: Block,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<void> {
  return abortable(bot.dig(block, true), signal, {
    timeoutMs,
    what: `picar ${block.name}`,
    onStop: () => bot.stopDigging(),
  });
}

/** Pausa cancelable. */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}
