import { describe, expect, it } from 'vitest';
import { GoalDigFrom, GoalWithinReach, withinReach } from '../src/tools/goals.js';

const feet = { x: 0, y: 64, z: 0 };

describe('withinReach (alcance de la mano, sin exigir línea de visión)', () => {
  it('alcanza un tronco al lado, desde el suelo hasta ~4 bloques de alto', () => {
    expect(withinReach(feet, { x: 1, y: 64, z: 0 })).toBe(true); // a los pies
    expect(withinReach(feet, { x: 1, y: 67, z: 0 })).toBe(true); // 3 más arriba
    expect(withinReach(feet, { x: 1, y: 68, z: 0 })).toBe(true); // 4 más arriba
  });

  it('no alcanza bloques muy altos o muy lejos', () => {
    expect(withinReach(feet, { x: 1, y: 70, z: 0 })).toBe(false); // 6 más arriba
    expect(withinReach(feet, { x: 5, y: 64, z: 0 })).toBe(false); // 5 bloques de distancia
  });

  it('a 3 bloques del tronco ya está al alcance (aunque haya hojas en medio)', () => {
    expect(withinReach(feet, { x: 1, y: 64, z: 3 })).toBe(true);
  });
});

describe('GoalWithinReach', () => {
  const goal = new GoalWithinReach({ x: 1, y: 64, z: 3 });

  it('isEnd coincide con withinReach', () => {
    expect(goal.isEnd({ x: 0, y: 64, z: 0 })).toBe(true);
    expect(goal.isEnd({ x: 0, y: 64, z: -5 })).toBe(false);
  });

  it('la heurística es 0 al alcance y crece al alejarse', () => {
    expect(goal.heuristic({ x: 1, y: 64, z: 2 })).toBe(0);
    const near = goal.heuristic({ x: 1, y: 64, z: -3 });
    const far = goal.heuristic({ x: 1, y: 64, z: -10 });
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });
});

describe('GoalDigFrom (picar siempre desde un costado)', () => {
  const goal = new GoalDigFrom({ x: 0, y: 70, z: 0 });

  it('no sirve pararse encima del bloque (misma columna, más arriba)', () => {
    expect(goal.isEnd({ x: 0, y: 71, z: 0 })).toBe(false);
  });

  it('sí sirve estar al lado o abajo en otra columna', () => {
    expect(goal.isEnd({ x: 1, y: 70, z: 0 })).toBe(true);
    expect(goal.isEnd({ x: 1, y: 67, z: 1 })).toBe(true);
  });
});
