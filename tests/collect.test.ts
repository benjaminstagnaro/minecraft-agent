import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { ALL_LOGS, resolveBlockGroup } from '../src/bot/names.js';
import {
  isLogName,
  connectedBlocks,
  isNaturalLog,
  neighbors26,
  pickNextTarget,
  positionsInColumn,
  type BlockInfo,
  type BlockLookup,
} from '../src/tools/collectBlock.js';

/** Mundo de mentira: un mapa "x,y,z" → bloque. Lo demás es aire. */
function world(blocks: Record<string, BlockInfo>): BlockLookup {
  return (x, y, z) => blocks[`${x},${y},${z}`] ?? { name: 'air', properties: {} };
}
const log = { name: 'oak_log', properties: { axis: 'y' } };
const naturalLeaves = { name: 'oak_leaves', properties: { persistent: false, distance: 1 } };
const placedLeaves = { name: 'oak_leaves', properties: { persistent: true, distance: 7 } };

describe('isNaturalLog: no talar construcciones', () => {
  it('un árbol natural (troncos + copa de hojas naturales) se puede talar', () => {
    const tree = world({
      '0,64,0': log,
      '0,65,0': log,
      '0,66,0': log,
      '0,67,0': log,
      '1,67,0': naturalLeaves,
      '0,68,0': naturalLeaves,
    });
    // Desde el tronco de abajo: sube por la columna y encuentra la copa.
    expect(isNaturalLog(0, 64, 0, tree)).toBe(true);
    expect(isNaturalLog(0, 66, 0, tree)).toBe(true);
  });

  it('un pilar de troncos sin hojas (ej: la esquina de una casa) NO se tala', () => {
    const house = world({ '0,64,0': log, '0,65,0': log, '0,66,0': log });
    expect(isNaturalLog(0, 64, 0, house)).toBe(false);
  });

  it('troncos con hojas puestas por un jugador (persistent=true) NO se talan', () => {
    const decoration = world({ '0,64,0': log, '0,65,0': log, '0,66,0': placedLeaves });
    expect(isNaturalLog(0, 64, 0, decoration)).toBe(false);
  });

  it('hojas naturales demasiado lejos de la copa no cuentan', () => {
    const farLeaves = world({ '0,64,0': log, '5,64,0': naturalLeaves });
    expect(isNaturalLog(0, 64, 0, farLeaves)).toBe(false);
  });

  it('positionsInColumn agrupa los troncos de un mismo árbol (misma x, z)', () => {
    const at = (x: number, y: number, z: number) => ({ x, z, toString: () => `${x},${y},${z}` });
    const candidates = [at(0, 64, 0), at(0, 65, 0), at(3, 64, 0), at(0, 66, 0)];
    expect(positionsInColumn(0, 0, candidates)).toEqual(['0,64,0', '0,65,0', '0,66,0']);
  });

  it('connectedBlocks encuentra el resto del árbol (incluye ramas en diagonal) y no salta al vecino', () => {
    // Árbol A: columna en (0, 64..67, 0) con una rama diagonal en (1, 68, 1).
    // Árbol B: columna en (4, 64..66, 0), separado por 3 bloques de aire.
    const logs = new Set([
      '0,64,0',
      '0,65,0',
      '0,66,0',
      '0,67,0',
      '1,68,1',
      '4,64,0',
      '4,65,0',
      '4,66,0',
    ]);
    const isLog = (x: number, y: number, z: number) => logs.has(`${x},${y},${z}`);
    // Acabamos de talar (0, 64, 0): lo que queda conectado es el árbol A sin ese tronco.
    logs.delete('0,64,0');
    const rest = connectedBlocks(neighbors26(0, 64, 0), isLog);
    expect([...rest].sort()).toEqual(['0,65,0', '0,66,0', '0,67,0', '1,68,1']);
  });

  it('pickNextTarget termina el árbol actual (de abajo hacia arriba) antes de ir al más cercano', () => {
    const here = new Vec3(2, 64, 0);
    const block = (x: number, y: number, z: number) => ({ position: new Vec3(x, y, z) });
    const treeA = [block(0, 67, 0), block(0, 65, 0)];
    const treeBNear = block(3, 64, 0); // más cerca que los troncos altos del árbol A
    const current = new Set(['0,65,0', '0,67,0']);
    expect(pickNextTarget([...treeA, treeBNear], here, current)?.position.y).toBe(65);
    // Sin árbol actual: el más cercano.
    expect(pickNextTarget([...treeA, treeBNear], here, new Set())).toBe(treeBNear);
  });

  it('reconoce troncos y descarta los descortezados', () => {
    expect(isLogName('birch_log')).toBe(true);
    expect(isLogName('stripped_oak_log')).toBe(false);
    expect(isLogName('oak_planks')).toBe(false);
  });
});

describe('resolveBlockGroup: español → bloques', () => {
  const known = (name: string) => ['oak_log', 'dirt', 'sand', 'cobblestone'].includes(name);

  it('"troncos" son todos los tipos de tronco', () => {
    expect(resolveBlockGroup('troncos', known)?.blocks).toEqual(ALL_LOGS);
    expect(resolveBlockGroup('tronco', known)?.blocks).toEqual(ALL_LOGS);
  });

  it('acepta una especie concreta, en singular o plural', () => {
    expect(resolveBlockGroup('troncos de roble', known)?.blocks).toEqual(['oak_log']);
    expect(resolveBlockGroup('tronco de roble', known)?.blocks).toEqual(['oak_log']);
  });

  it('"tierra" incluye el bloque de pasto (al picarlo suelta tierra)', () => {
    expect(resolveBlockGroup('tierra', known)?.blocks).toEqual(['dirt', 'grass_block']);
  });

  it('acepta IDs oficiales que existan', () => {
    expect(resolveBlockGroup('cobblestone', known)).toEqual({
      label: 'cobblestone',
      blocks: ['cobblestone'],
    });
    expect(resolveBlockGroup('minecraft:sand', known)?.blocks).toEqual(['sand']);
  });

  it('devuelve undefined si no sabe qué es', () => {
    expect(resolveBlockGroup('unicornios', known)).toBeUndefined();
  });
});
