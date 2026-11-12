import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { spanishName } from '../bot/names.js';
import { gotoGoal } from './abort.js';
import { GoalPlaceNear } from './goals.js';
import { findSupportOffset, isReplaceable, overlapsPlayer, placeAgainst } from './placement.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const { goals } = pathfinderPkg;

/** No caminar más lejos que esto para poner un bloque. */
const MAX_DISTANCE = 64;

const input = z.object({
  blocks: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('IDs de bloque que sirven; usa el primero que tenga en el inventario'),
  x: z.number().int(),
  y: z.number().int().min(-64).max(319),
  z: z.number().int(),
  label: z.string().optional().describe('Nombre para mostrar en el chat'),
});

export const placeBlockTool: Tool<typeof input> = {
  name: 'place_block',
  description:
    'Pone un bloque del inventario en la posición (x, y, z). Camina hasta tenerla al alcance ' +
    '(radio máximo 64). Falla con explicación si no tiene el bloque, si el lugar está ocupado, ' +
    'si hay alguien parado ahí o si no hay ningún bloque al lado donde apoyarlo.',
  input,
  timeoutMs: 45_000,
  run: place,
};

async function place(ctx: ToolContext, args: z.infer<typeof input>): Promise<ToolResult> {
  const { bot, signal } = ctx;
  const label = args.label ?? spanishName(args.blocks[0] ?? '');
  const target = new Vec3(args.x, args.y, args.z);
  const where = `${args.x}, ${args.y}, ${args.z}`;

  const unknown = args.blocks.filter((name) => !bot.registry.blocksByName[name]);
  if (unknown.length > 0)
    return { ok: false, message: `No conozco el bloque: ${unknown.join(', ')}.` };

  const item = bot.inventory.items().find((i) => args.blocks.includes(i.name));
  if (!item) return { ok: false, message: `No tengo ${label} para poner.` };

  if (bot.entity.position.distanceTo(target) > MAX_DISTANCE) {
    return { ok: false, message: `(${where}) está muy lejos (más de ${MAX_DISTANCE} bloques).` };
  }
  const current = bot.blockAt(target);
  if (!current)
    return { ok: false, message: `No conozco esa zona (${where}): está fuera de mi vista.` };
  if (!isReplaceable(current)) {
    return { ok: false, message: `Ya hay ${spanishName(current.name)} en (${where}).` };
  }

  // El servidor no deja poner un bloque donde hay alguien (el bot se aparta solo; los demás no).
  const someone = Object.values(bot.players).find(
    (p) => p.username !== bot.username && p.entity && overlapsPlayer(target, p.entity.position),
  );
  if (someone)
    return {
      ok: false,
      message: `No puedo ponerlo ahí: ${someone.username} está parado en ese lugar.`,
    };

  const isSolidAt = (x: number, y: number, z: number): boolean =>
    bot.blockAt(new Vec3(x, y, z))?.boundingBox === 'block';
  const offset = findSupportOffset(target, isSolidAt);
  if (!offset) {
    return {
      ok: false,
      message: `No hay dónde apoyarlo en (${where}): en Minecraft un bloque necesita otro bloque al lado.`,
    };
  }

  await gotoGoal(bot, new GoalPlaceNear(target), signal, 30_000);
  // El cuerpo del bot mide 0,6: aunque esté en la celda de al lado, su borde puede invadir la
  // celda objetivo y el servidor rechazaría el bloque. Centrarse en su propia celda lo evita.
  if (overlapsPlayer(target, bot.entity.position)) {
    const { x, y, z } = bot.entity.position.floored();
    await gotoGoal(bot, new goals.GoalBlock(x, y, z), signal, 5_000);
  }
  const reference = bot.blockAt(target.offset(...offset));
  if (!reference) throw new Error('el bloque de apoyo desapareció');
  const face = new Vec3(-offset[0], -offset[1], -offset[2]);
  await placeAgainst(bot, item.name, reference, face, signal);

  return {
    ok: true,
    message: `Listo: puse ${label} en (${where}).`,
    data: { block: item.name, x: args.x, y: args.y, z: args.z },
  };
}
