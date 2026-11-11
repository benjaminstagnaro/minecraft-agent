import { describe, expect, it } from 'vitest';
import { parseJavaMajor } from '../scripts/lib/java.js';
import { mergeProperties, readProperty } from '../scripts/lib/properties.js';
import { decodePackets, encodePacket, PacketType } from '../scripts/lib/rcon.js';

describe('parseJavaMajor', () => {
  it('entiende el formato moderno y el antiguo 1.x', () => {
    expect(parseJavaMajor('openjdk version "25.0.1" 2025-10-21 LTS')).toBe(25);
    expect(parseJavaMajor('java version "1.8.0_451"')).toBe(8);
    expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21);
    expect(parseJavaMajor('basura')).toBeUndefined();
  });
});

describe('server.properties', () => {
  const existing = '#Minecraft server properties\ndifficulty=hard\nonline-mode=true\nmotd=Hola\n';

  it('aplica las claves obligatorias y respeta lo que el usuario cambió', () => {
    const merged = mergeProperties(
      existing,
      { 'online-mode': 'false', motd: '[minecraft-agent] pruebas' },
      { difficulty: 'peaceful', 'level-name': 'mundo-agente' },
    );
    expect(readProperty(merged, 'online-mode')).toBe('false');
    expect(readProperty(merged, 'motd')).toBe('[minecraft-agent] pruebas');
    // difficulty ya existía: es un default, no se pisa.
    expect(readProperty(merged, 'difficulty')).toBe('hard');
    expect(readProperty(merged, 'level-name')).toBe('mundo-agente');
    expect(merged.startsWith('#Minecraft server properties')).toBe(true);
  });

  it('crea el archivo desde cero', () => {
    const merged = mergeProperties('', { 'server-ip': '127.0.0.1' }, { gamemode: 'survival' });
    expect(merged).toBe('server-ip=127.0.0.1\ngamemode=survival\n');
  });
});

describe('RCON', () => {
  it('codifica y decodifica un paquete (ida y vuelta)', () => {
    const packet = { id: 7, type: PacketType.COMMAND, payload: 'time set día' };
    const { packets, rest } = decodePackets(encodePacket(packet));
    expect(packets).toEqual([packet]);
    expect(rest.length).toBe(0);
  });

  it('maneja paquetes partidos y varios juntos', () => {
    const a = encodePacket({ id: 1, type: PacketType.RESPONSE, payload: 'uno' });
    const b = encodePacket({ id: 2, type: PacketType.RESPONSE, payload: 'dos' });
    const joined = Buffer.concat([a, b]);

    const partial = decodePackets(joined.subarray(0, a.length + 3));
    expect(partial.packets.map((p) => p.payload)).toEqual(['uno']);
    expect(partial.rest.length).toBe(3);

    const all = decodePackets(Buffer.concat([partial.rest, joined.subarray(a.length + 3)]));
    expect(all.packets.map((p) => p.payload)).toEqual(['dos']);
  });
});
