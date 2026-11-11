import { z } from 'zod';
import type { Tool } from './types.js';

const input = z.object({});

/** Resume el inventario: ítems iguales sumados, de mayor a menor cantidad. */
export function summarizeInventory(
  items: ReadonlyArray<{ name: string; displayName: string; count: number }>,
): { name: string; displayName: string; count: number }[] {
  const totals = new Map<string, { name: string; displayName: string; count: number }>();
  for (const item of items) {
    const current = totals.get(item.name);
    if (current) current.count += item.count;
    else totals.set(item.name, { ...item });
  }
  return [...totals.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export const getStatusTool: Tool<typeof input> = {
  name: 'get_status',
  description: 'Devuelve la posición, la vida, la comida y el inventario del bot.',
  input,
  timeoutMs: 5_000,
  run({ bot }) {
    const p = bot.entity.position;
    const inventory = summarizeInventory(bot.inventory.items());
    const listed = inventory.length
      ? inventory.map((i) => `${i.count} ${i.displayName}`).join(', ')
      : 'vacío';

    return Promise.resolve({
      ok: true,
      message:
        `Vida ${Math.round(bot.health)}/20, comida ${bot.food}/20, en ` +
        `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}). Inventario: ${listed}.`,
      data: {
        position: { x: p.x, y: p.y, z: p.z },
        health: bot.health,
        food: bot.food,
        inventory: inventory.map(({ name, count }) => ({ name, count })),
      },
    });
  },
};
