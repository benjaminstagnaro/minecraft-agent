import type { Bot } from 'mineflayer';
import prismarineRegistry from 'prismarine-registry';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import {
  BRUSH_PENALTY,
  brushPenalty,
  createMovements,
  HARMFUL_PASSABLE_BLOCKS,
  harmfulBlockIds,
} from '../src/bot/pathing.js';

// Registro real de la versión del servidor de pruebas.
const registry = prismarineRegistry('26.1.2');

// Bot mínimo: Movements solo necesita el registro y poco más para construirse.
const fakeBot = {
  registry,
  version: '26.1.2',
  supportFeature: () => false,
  inventory: { items: () => [] },
  blockAt: () => null,
} as unknown as Bot;

describe('bloques dañinos atravesables', () => {
  it('todos existen en 26.1.2 y no tienen colisión (por eso el pathfinder los cruzaba)', () => {
    for (const name of HARMFUL_PASSABLE_BLOCKS) {
      expect(registry.blocksByName[name]?.boundingBox, name).toBe('empty');
    }
    expect(harmfulBlockIds(registry)).toHaveLength(HARMFUL_PASSABLE_BLOCKS.length);
  });

  it('ignora nombres que no existen en versiones antiguas', () => {
    const oldRegistry = { blocksByName: { wither_rose: { id: 7 } } } as unknown as Bot['registry'];
    expect(harmfulBlockIds(oldRegistry)).toEqual([7]);
  });
});

describe('brushPenalty (no rozar arbustos)', () => {
  const BUSH = registry.blocksByName.sweet_berry_bush!.id;
  const STONE = registry.blocksByName.stone!.id;
  const harmful = new Set(harmfulBlockIds(registry));
  const worldWith = (blocks: Record<string, number>) => (p: Vec3) =>
    blocks[`${p.x},${p.y},${p.z}`] ?? undefined;

  it('penaliza casillas con un arbusto al lado (también en diagonal)', () => {
    const at = new Vec3(0, 64, 0);
    expect(brushPenalty(at, worldWith({ '1,64,0': BUSH }), harmful)).toBe(BRUSH_PENALTY);
    expect(brushPenalty(at, worldWith({ '-1,64,1': BUSH }), harmful)).toBe(BRUSH_PENALTY);
  });

  it('no penaliza si al lado solo hay bloques inofensivos o nada', () => {
    const at = new Vec3(0, 64, 0);
    expect(brushPenalty(at, worldWith({ '1,64,0': STONE }), harmful)).toBe(0);
    expect(brushPenalty(at, worldWith({}), harmful)).toBe(0);
    // Un arbusto a 2 bloques no se roza.
    expect(brushPenalty(at, worldWith({ '2,64,0': BUSH }), harmful)).toBe(0);
  });
});

describe('createMovements', () => {
  const movements = createMovements(fakeBot);

  it('esquiva las bayas y demás bloques dañinos', () => {
    expect(movements.blocksToAvoid.has(registry.blocksByName.sweet_berry_bush!.id)).toBe(true);
    for (const id of harmfulBlockIds(registry)) expect(movements.blocksToAvoid.has(id)).toBe(true);
  });

  it('mantiene los que el pathfinder ya evitaba (fuego, lava)', () => {
    expect(movements.blocksToAvoid.has(registry.blocksByName.fire!.id)).toBe(true);
    expect(movements.blocksToAvoid.has(registry.blocksByName.lava!.id)).toBe(true);
  });

  it('no rompe bloques, pero corre y hace parkour', () => {
    expect(movements.canDig).toBe(false);
    expect(movements.allowSprinting).toBe(true);
    expect(movements.allowParkour).toBe(true);
  });
});
