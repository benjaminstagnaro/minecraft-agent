import { describe, expect, it } from 'vitest';
import { parseCommand, resolveCoordinates, type Coordinate } from '../src/bot/commands.js';
import { GoalPlaceNear } from '../src/tools/goals.js';
import { findSupportOffset } from '../src/tools/placement.js';

const abs = (value: number): Coordinate => ({ relative: false, value });
const rel = (value: number): Coordinate => ({ relative: true, value });

describe('parseCommand: poner bloques', () => {
  it.each([
    ['@bot pon tierra en 10 64 -5', 'tierra', [abs(10), abs(64), abs(-5)]],
    ['@bot pon un bloque de tierra en ~2 ~ ~-1', 'tierra', [rel(2), rel(0), rel(-1)]],
    ['@bot coloca una antorcha en ~ ~1 ~', 'antorcha', [rel(0), rel(1), rel(0)]],
    ['@bot pon troncos de roble en 0 70 0', 'troncos de roble', [abs(0), abs(70), abs(0)]],
  ])('"%s"', (message, what, at) => {
    expect(parseCommand(message, 'Agente')).toEqual({ kind: 'place', what, at });
  });

  it('sin coordenadas no es un "pon" válido', () => {
    expect(parseCommand('@bot pon tierra', 'Agente')?.kind).toBe('unknown');
  });
});

describe('resolveCoordinates', () => {
  const player = { x: 10.7, y: 64, z: -3.2 }; // parado en la celda (10, 64, -4)

  it('las absolutas quedan igual', () => {
    expect(resolveCoordinates([abs(1), abs(2), abs(3)], undefined)).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('las relativas se suman a la celda del jugador', () => {
    expect(resolveCoordinates([rel(2), rel(0), rel(-1)], player)).toEqual({ x: 12, y: 64, z: -5 });
  });

  it('relativas sin saber dónde está el jugador → undefined', () => {
    expect(resolveCoordinates([rel(1), abs(64), abs(0)], undefined)).toBeUndefined();
  });
});

describe('findSupportOffset (un bloque necesita otro al lado)', () => {
  const solid = (cells: string[]) => (x: number, y: number, z: number) =>
    cells.includes(`${x},${y},${z}`);
  const target = { x: 0, y: 65, z: 0 };

  it('prefiere apoyarse en el suelo', () => {
    expect(findSupportOffset(target, solid(['0,64,0', '1,65,0']))).toEqual([0, -1, 0]);
  });

  it('si no hay suelo, usa un costado', () => {
    expect(findSupportOffset(target, solid(['0,65,-1']))).toEqual([0, 0, -1]);
  });

  it('flotando en el aire no hay apoyo', () => {
    expect(findSupportOffset(target, solid([]))).toBeUndefined();
  });
});

describe('GoalPlaceNear', () => {
  const goal = new GoalPlaceNear({ x: 0, y: 64, z: 0 });

  it('no sirve pararse justo donde va el bloque (ni con los pies ni con la cabeza)', () => {
    expect(goal.isEnd({ x: 0, y: 64, z: 0 })).toBe(false);
    expect(goal.isEnd({ x: 0, y: 63, z: 0 })).toBe(false);
  });

  it('sí sirve estar al lado', () => {
    expect(goal.isEnd({ x: 1, y: 64, z: 0 })).toBe(true);
    expect(goal.isEnd({ x: 2, y: 64, z: 2 })).toBe(true);
  });
});
