import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { ALL_PLANKS, resolveItemGroup, spanishName } from '../src/bot/names.js';
import { describeMissing, missingIngredients } from '../src/tools/craftItem.js';
import { overlapsPlayer } from '../src/tools/placement.js';

describe('missingIngredients', () => {
  const pickaxe = [
    { name: 'oak_planks', perCraft: 3, have: 2 },
    { name: 'stick', perCraft: 2, have: 5 },
  ];

  it('calcula lo que falta para craftear N veces', () => {
    expect(missingIngredients(pickaxe, 1)).toEqual([{ name: 'oak_planks', count: 1 }]);
    expect(missingIngredients(pickaxe, 3)).toEqual([
      { name: 'oak_planks', count: 7 },
      { name: 'stick', count: 1 },
    ]);
  });

  it('vacío cuando alcanza', () => {
    expect(missingIngredients([{ name: 'oak_log', perCraft: 1, have: 3 }], 3)).toEqual([]);
  });
});

describe('describeMissing (mensajes en español)', () => {
  it('lista en español natural', () => {
    expect(describeMissing([{ name: 'stick', count: 2 }])).toBe('2 palos');
    expect(
      describeMissing([
        { name: 'oak_planks', count: 1 },
        { name: 'stick', count: 2 },
        { name: 'cobblestone', count: 3 },
      ]),
    ).toBe('1 tablones de roble, 2 palos y 3 adoquines');
  });
});

describe('spanishName', () => {
  it.each([
    ['oak_planks', 'tablones de roble'],
    ['dark_oak_planks', 'tablones de roble oscuro'],
    ['birch_log', 'troncos de abedul'],
    ['crafting_table', 'mesa de crafteo'],
    ['diamond_pickaxe', 'diamond pickaxe'], // sin traducción: legible igual
  ])('%s → %s', (id, name) => {
    expect(spanishName(id)).toBe(name);
  });
});

describe('resolveItemGroup', () => {
  const known = (name: string) => ['stick', 'oak_door'].includes(name);

  it.each([
    ['tablones', ALL_PLANKS],
    ['tablon', ALL_PLANKS],
    ['palos', ['stick']],
    ['palo', ['stick']],
    ['mesa de crafteo', ['crafting_table']],
    ['mesa', ['crafting_table']],
    ['pico de madera', ['wooden_pickaxe']],
    ['picos de madera', ['wooden_pickaxe']],
    ['antorcha', ['torch']],
  ])('"%s"', (phrase, items) => {
    expect(resolveItemGroup(phrase, known)?.items).toEqual(items);
  });

  it('acepta IDs oficiales y rechaza lo desconocido', () => {
    expect(resolveItemGroup('oak_door', known)?.items).toEqual(['oak_door']);
    expect(resolveItemGroup('nave espacial', known)).toBeUndefined();
  });
});

describe('overlapsPlayer (no poner un bloque encima del bot)', () => {
  const bot = new Vec3(10.5, 64, 10.5); // centrado en la celda (10, 64, 10)

  it('la celda donde está parado choca', () => {
    expect(overlapsPlayer(new Vec3(10, 64, 10), bot)).toBe(true);
    expect(overlapsPlayer(new Vec3(10, 65, 10), bot)).toBe(true); // a la altura de la cabeza
  });

  it('las celdas vecinas no chocan si está centrado', () => {
    expect(overlapsPlayer(new Vec3(11, 64, 10), bot)).toBe(false);
    expect(overlapsPlayer(new Vec3(12, 64, 10), bot)).toBe(false);
  });

  it('si está pegado al borde, la celda vecina sí choca', () => {
    expect(overlapsPlayer(new Vec3(11, 64, 10), new Vec3(10.9, 64, 10.5))).toBe(true);
  });
});
