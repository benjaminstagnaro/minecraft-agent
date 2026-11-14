import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLECT_COUNT,
  extractMention,
  normalize,
  parseCommand,
} from '../src/bot/commands.js';

const BOT = 'Agente';

describe('normalize', () => {
  it('quita tildes, mayúsculas y signos', () => {
    expect(normalize('¡Sígueme!')).toBe('sigueme');
    expect(normalize('  VEN   acá ')).toBe('ven aca');
    expect(normalize('¿Ayuda?')).toBe('ayuda');
  });
});

describe('extractMention', () => {
  it('reconoce @bot y @<nombre> sin importar mayúsculas', () => {
    expect(extractMention('@bot sígueme', BOT)).toBe('sígueme');
    expect(extractMention('@Bot, ven', BOT)).toBe('ven');
    expect(extractMention('@agente para', BOT)).toBe('para');
    expect(extractMention('@bot', BOT)).toBe('');
  });

  it('ignora mensajes que no son para el bot', () => {
    expect(extractMention('hola a todos', BOT)).toBeNull();
    expect(extractMention('dile al @bot que venga', BOT)).toBeNull();
    // "@botcito" es otra persona, no el bot.
    expect(extractMention('@botcito sígueme', BOT)).toBeNull();
  });

  it('escapa caracteres especiales del nombre del bot', () => {
    expect(extractMention('@Mi_Bot ven', 'Mi_Bot')).toBe('ven');
  });
});

describe('parseCommand', () => {
  it.each([
    ['@bot sígueme', 'follow'],
    ['@bot SIGUEME!!', 'follow'],
    ['@bot sígueme por favor', 'follow'],
    ['@bot ven', 'come'],
    ['@bot ven acá', 'come'],
    ['@bot para', 'stop'],
    ['@bot detente', 'stop'],
    ['@bot ayuda', 'help'],
    ['@bot ¿ayuda?', 'help'],
    ['@bot ?', 'help'],
    ['@bot', 'help'],
  ])('"%s" → %s', (message, kind) => {
    expect(parseCommand(message, BOT)?.kind).toBe(kind);
  });

  it('devuelve unknown con el texto original si no entiende', () => {
    expect(parseCommand('@bot construye una casa', BOT)).toEqual({
      kind: 'unknown',
      text: 'construye una casa',
    });
  });

  it('devuelve null si el mensaje no es para el bot', () => {
    expect(parseCommand('sígueme', BOT)).toBeNull();
  });

  it.each(['@bot estado', '@bot inventario', '@bot ¿qué tienes?'])('"%s" → status', (message) => {
    expect(parseCommand(message, BOT)?.kind).toBe('status');
  });
});

describe('parseCommand: juntar', () => {
  it.each([
    ['@bot junta 10 troncos', 10, 'troncos'],
    ['@bot junta 10 troncos de roble', 10, 'troncos de roble'],
    ['@bot recolecta diez troncos', 10, 'troncos'],
    ['@bot tala 3 troncos por favor', 3, 'troncos'],
    ['@bot consígueme 64 tierra', 64, 'tierra'],
    ['@bot mina un carbón', 1, 'carbon'],
    ['@bot junta troncos', DEFAULT_COLLECT_COUNT, 'troncos'],
  ])('"%s" → %i × "%s"', (message, count, what) => {
    expect(parseCommand(message, BOT)).toEqual({ kind: 'collect', count, what });
  });

  it('si la primera palabra no es un número, es parte del nombre', () => {
    expect(parseCommand('@bot junta tierra roja', BOT)).toEqual({
      kind: 'collect',
      count: DEFAULT_COLLECT_COUNT,
      what: 'tierra roja',
    });
  });

  it.each([
    ['@bot craftea 4 tablones', 4, 'tablones'],
    ['@bot craftea un pico de madera', 1, 'pico de madera'],
    ['@bot hazme una mesa de crafteo', 1, 'mesa de crafteo'],
    ['@bot fabrica palos', 1, 'palos'],
  ])('"%s" → craft %i × "%s"', (message, count, what) => {
    expect(parseCommand(message, BOT)).toEqual({ kind: 'craft', count, what });
  });

  it('pasa cantidades fuera de rango tal cual (la herramienta las valida y explica)', () => {
    expect(parseCommand('@bot junta 500 troncos', BOT)).toMatchObject({ count: 500 });
  });
});

describe('parseCommand: talar el árbol que miro', () => {
  it.each([
    '@bot tala este árbol',
    '@bot corta ese arbol',
    '@bot tala aquel árbol por favor',
    '@bot tala el árbol que estoy mirando',
    '@Agente córtame este árbol!',
  ])('"%s" → chop', (message) => {
    expect(parseCommand(message, BOT)).toEqual({ kind: 'chop' });
  });

  it('"tala 3 troncos" sigue siendo juntar', () => {
    expect(parseCommand('@bot tala 3 troncos', BOT)).toEqual({
      kind: 'collect',
      count: 3,
      what: 'troncos',
    });
  });
});
