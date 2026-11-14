import type { Bot } from 'mineflayer';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { abortable, AbortError, wait } from '../src/tools/abort.js';
import { summarizeInventory } from '../src/tools/getStatus.js';
import { ActionRunner } from '../src/tools/runner.js';
import type { Tool } from '../src/tools/types.js';

/** Bot de mentira con lo que el ejecutor toca al terminar cada acción. */
function fakeBot() {
  const setGoal = vi.fn();
  const stopDigging = vi.fn();
  const bot = {
    pathfinder: { setGoal },
    stopDigging,
    clearControlStates: vi.fn(),
  } as unknown as Bot;
  return { bot, setGoal, stopDigging };
}

/** Herramienta que espera `ms` (cancelable) y devuelve ok. */
function slowTool(timeoutMs = 5_000): Tool<z.ZodObject<{ ms: z.ZodNumber }>> {
  return {
    name: 'lenta',
    description: 'espera',
    input: z.object({ ms: z.number().int().positive() }),
    timeoutMs,
    async run({ signal }, { ms }) {
      await wait(ms, signal);
      return { ok: true, message: `esperé ${ms}` };
    },
  };
}

describe('ActionRunner', () => {
  it('ejecuta la herramienta y deja el bot quieto al terminar', async () => {
    const { bot, setGoal, stopDigging } = fakeBot();
    const runner = new ActionRunner(bot, () => undefined);
    const result = await runner.run(slowTool(), { ms: 10 });
    expect(result).toEqual({ ok: true, message: 'esperé 10' });
    expect(setGoal).toHaveBeenCalledWith(null);
    expect(stopDigging).toHaveBeenCalled();
    expect(runner.busyWith).toBeUndefined();
  });

  it('rechaza parámetros inválidos sin ejecutar nada', async () => {
    const runner = new ActionRunner(fakeBot().bot, () => undefined);
    const result = await runner.run(slowTool(), { ms: -5 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Parámetros inválidos para lenta/);
  });

  it('corta la acción al vencer su tiempo máximo', async () => {
    const runner = new ActionRunner(fakeBot().bot, () => undefined);
    const result = await runner.run(slowTool(50), { ms: 10_000 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/tiempo máximo/);
  });

  it('"para" cancela la acción en curso', async () => {
    const runner = new ActionRunner(fakeBot().bot, () => undefined);
    const running = runner.run(slowTool(), { ms: 10_000 });
    expect(runner.busyWith).toBe('lenta');
    expect(await runner.cancel('cancelado por el jugador')).toBe(true);
    expect((await running).message).toBe('Detenido: cancelado por el jugador.');
    expect(await runner.cancel()).toBe(false); // ya no hay nada que cancelar
  });

  it('una orden nueva reemplaza a la anterior', async () => {
    const runner = new ActionRunner(fakeBot().bot, () => undefined);
    const first = runner.run(slowTool(), { ms: 10_000 });
    const second = runner.run(slowTool(), { ms: 10 });
    expect((await first).message).toMatch(/reemplazada por una orden nueva/);
    expect((await second).ok).toBe(true);
  });

  it('un error inesperado se convierte en un resultado legible', async () => {
    const runner = new ActionRunner(fakeBot().bot, () => undefined);
    const broken: Tool<z.ZodObject<Record<string, never>>> = {
      name: 'rota',
      description: 'falla',
      input: z.object({}),
      timeoutMs: 1_000,
      run: () => Promise.reject(new Error('se cayó algo')),
    };
    expect(await runner.run(broken, {})).toEqual({
      ok: false,
      message: 'No pude terminar: se cayó algo',
    });
  });
});

describe('abortable', () => {
  it('devuelve el resultado si nadie cancela', async () => {
    await expect(abortable(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });

  it('al cancelar lanza AbortError y detiene la operación real', async () => {
    const controller = new AbortController();
    const onStop = vi.fn();
    const pending = abortable(new Promise(() => undefined), controller.signal, { onStop });
    controller.abort('cancelado por el jugador');
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(onStop).toHaveBeenCalled();
  });

  it('falla con un mensaje claro si se pasa del tiempo', async () => {
    const pending = abortable(new Promise(() => undefined), new AbortController().signal, {
      timeoutMs: 20,
      what: 'llegar al árbol',
    });
    await expect(pending).rejects.toThrow('llegar al árbol tardó más de 0.02 s');
  });
});

describe('summarizeInventory', () => {
  it('suma stacks iguales y ordena de mayor a menor', () => {
    const summary = summarizeInventory([
      { name: 'oak_log', displayName: 'Oak Log', count: 64 },
      { name: 'stick', displayName: 'Stick', count: 4 },
      { name: 'oak_log', displayName: 'Oak Log', count: 6 },
    ]);
    expect(summary).toEqual([
      { name: 'oak_log', displayName: 'Oak Log', count: 70 },
      { name: 'stick', displayName: 'Stick', count: 4 },
    ]);
  });
});
