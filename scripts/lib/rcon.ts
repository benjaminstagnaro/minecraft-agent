import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { RCON_PORT, SERVER_PROPERTIES } from './paths.js';
import { readProperty } from './properties.js';

/**
 * Cliente RCON mínimo (protocolo de consola remota de Minecraft/Source).
 * Sirve para mandarle comandos al servidor de pruebas desde scripts:
 * `op`, `tp`, `time set day`, `stop`, etc.
 *
 * Paquete: [largo int32 LE][id int32 LE][tipo int32 LE][payload UTF-8][0x00][0x00]
 * donde "largo" cuenta todo lo que viene después de él.
 */

export const PacketType = { RESPONSE: 0, COMMAND: 2, LOGIN: 3 } as const;

export interface RconPacket {
  id: number;
  type: number;
  payload: string;
}

export function encodePacket(packet: RconPacket): Buffer {
  const payload = Buffer.from(packet.payload, 'utf8');
  const buffer = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  buffer.writeInt32LE(4 + 4 + payload.length + 2, 0);
  buffer.writeInt32LE(packet.id, 4);
  buffer.writeInt32LE(packet.type, 8);
  payload.copy(buffer, 12);
  // Los dos bytes finales ya son 0x00 por Buffer.alloc.
  return buffer;
}

/** Separa los paquetes completos de un buffer. Devuelve también lo que sobró (incompleto). */
export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);
    if (buffer.length - offset - 4 < length) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const payload = buffer.toString('utf8', offset + 12, offset + 4 + length - 2);
    packets.push({ id, type, payload });
    offset += 4 + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

/** Lee puerto y contraseña RCON desde server/server.properties. */
export function readRconOptions(): RconOptions {
  if (!existsSync(SERVER_PROPERTIES)) {
    throw new Error('No existe server/server.properties. Corre: npm run server:setup');
  }
  const properties = readFileSync(SERVER_PROPERTIES, 'utf8');
  const password = readProperty(properties, 'rcon.password');
  if (!password) throw new Error('RCON no está configurado. Corre: npm run server:setup');
  const port = Number(readProperty(properties, 'rcon.port') ?? RCON_PORT);
  return { host: '127.0.0.1', port, password };
}

/** Abre una conexión, se autentica, ejecuta un comando y devuelve la respuesta. */
export function rconCommand(options: RconOptions, command: string): Promise<string> {
  const { host, port, password, timeoutMs = 5000 } = options;
  const LOGIN_ID = 1;
  const COMMAND_ID = 2;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let pending: Buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error: Error | null, result?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? '');
    };

    socket.setTimeout(timeoutMs, () => finish(new Error(`RCON sin respuesta en ${timeoutMs} ms`)));
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => {
      socket.write(encodePacket({ id: LOGIN_ID, type: PacketType.LOGIN, payload: password }));
    });

    socket.on('data', (chunk) => {
      const { packets, rest } = decodePackets(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const packet of packets) {
        if (packet.id === -1) {
          finish(new Error('RCON: contraseña incorrecta'));
          return;
        }
        if (packet.id === LOGIN_ID && packet.type === PacketType.COMMAND) {
          // Login aceptado (el servidor responde al login con tipo 2): ahora el comando.
          socket.write(
            encodePacket({ id: COMMAND_ID, type: PacketType.COMMAND, payload: command }),
          );
        } else if (packet.id === COMMAND_ID) {
          finish(null, packet.payload);
          return;
        }
      }
    });
  });
}
