import { describe, expect, it } from 'vitest';
import { extractMention, normalize, parseCommand } from '../src/bot/commands.js';

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
});
