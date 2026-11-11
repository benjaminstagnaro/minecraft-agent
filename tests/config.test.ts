import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('usa valores por defecto seguros', () => {
    const config = parseConfig({});
    expect(config.server).toEqual({ host: '127.0.0.1', port: 25565, version: '26.1.2' });
    expect(config.bot.name).toBe('Agente');
    expect(config.safety.allowRemoteServer).toBe(false);
  });

  it('trata variables vacías como no definidas', () => {
    expect(parseConfig({ MC_HOST: '', MC_PORT: '  ' }).server.host).toBe('127.0.0.1');
  });

  it('convierte puerto y booleanos', () => {
    const config = parseConfig({ MC_PORT: '25570', ALLOW_REMOTE_SERVER: 'true' });
    expect(config.server.port).toBe(25570);
    expect(config.safety.allowRemoteServer).toBe(true);
  });

  it('rechaza nombres de bot inválidos con un mensaje claro', () => {
    expect(() => parseConfig({ BOT_NAME: 'nombre con espacios' })).toThrow(ConfigError);
    expect(() => parseConfig({ BOT_NAME: 'ab' })).toThrow(/BOT_NAME/);
  });

  it('rechaza puertos fuera de rango', () => {
    expect(() => parseConfig({ MC_PORT: '70000' })).toThrow(/MC_PORT/);
  });
});
