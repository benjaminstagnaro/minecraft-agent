import { describe, expect, it } from 'vitest';
import { stopsGaze, viewDirection } from '../src/tools/lookAt.js';

const close = (v: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x);
  expect(v.y).toBeCloseTo(y);
  expect(v.z).toBeCloseTo(z);
};

describe('viewDirection (convención de mineflayer)', () => {
  it('yaw 0 mira al norte (-z), horizontal', () => close(viewDirection(0, 0), 0, 0, -1));
  it('yaw π/2 mira al oeste (-x)', () => close(viewDirection(Math.PI / 2, 0), -1, 0, 0));
  it('pitch positivo mira hacia arriba', () => close(viewDirection(0, Math.PI / 2), 0, 1, 0));
  it('siempre es un vector unitario', () => {
    const v = viewDirection(1.234, -0.567);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1);
  });
});

describe('stopsGaze (qué detiene la mirada)', () => {
  it('un tronco la detiene', () => {
    expect(stopsGaze({ name: 'spruce_log', boundingBox: 'block' })).toBe(true);
  });

  it('las hojas se atraviesan (mirar el tronco a través de la copa)', () => {
    expect(stopsGaze({ name: 'spruce_leaves', boundingBox: 'block' })).toBe(false);
  });

  it('aire, pasto y flores se atraviesan', () => {
    expect(stopsGaze({ name: 'air', boundingBox: 'empty' })).toBe(false);
    expect(stopsGaze({ name: 'short_grass', boundingBox: 'empty' })).toBe(false);
  });

  it('una pared la detiene (no "ve" un árbol detrás de tu casa)', () => {
    expect(stopsGaze({ name: 'stone', boundingBox: 'block' })).toBe(true);
  });
});
