import { describe, expect, it } from 'vitest';
import { isHardcoreLogin, isLocalHost, motdToPlainText } from '../src/bot/safety.js';

describe('isLocalHost', () => {
  it.each(['localhost', '127.0.0.1', '127.0.1.1', '::1', 'LOCALHOST'])('%s es local', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(['192.168.1.10', 'mc.hypixel.net', '0.0.0.0', '128.0.0.1'])('%s NO es local', (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});

describe('motdToPlainText', () => {
  it('acepta texto plano y quita códigos de color', () => {
    expect(motdToPlainText('§b[minecraft-agent]§r Servidor de pruebas')).toBe(
      '[minecraft-agent] Servidor de pruebas',
    );
  });

  it('aplana componentes de chat anidados', () => {
    const description = {
      text: '',
      extra: [{ text: '[minecraft-agent]' }, { text: ' Servidor', extra: [' de pruebas'] }],
    };
    expect(motdToPlainText(description)).toBe('[minecraft-agent] Servidor de pruebas');
  });

  it('un mundo abierto a LAN no tiene la marca', () => {
    expect(motdToPlainText('Benja - Miami extremo')).not.toContain('[minecraft-agent]');
  });

  it('tolera valores raros sin explotar', () => {
    expect(motdToPlainText(undefined)).toBe('');
    expect(motdToPlainText(42)).toBe('');
  });
});

describe('isHardcoreLogin', () => {
  it('detecta isHardcore en la raíz del paquete (formato 26.1)', () => {
    expect(isHardcoreLogin({ isHardcore: true, worldState: { gamemode: 'survival' } })).toBe(true);
  });

  it('detecta isHardcore dentro de worldState', () => {
    expect(isHardcoreLogin({ worldState: { isHardcore: true } })).toBe(true);
  });

  it('mundo normal o paquete inválido → false', () => {
    expect(isHardcoreLogin({ isHardcore: false, worldState: {} })).toBe(false);
    expect(isHardcoreLogin(null)).toBe(false);
    expect(isHardcoreLogin('login')).toBe(false);
  });
});
