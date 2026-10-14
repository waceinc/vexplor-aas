/**
 * 시험용 MQTT 브로커 — 연결 · 구독 · 발행 · 보관 메시지만(QoS 0). 시험과 가상 설비에 쓴다(실브로커 대신).
 * 사용자 · 암호를 정해 두면 다르게 붙는 클라이언트를 거절한다(코드 4).
 */
import { createServer, type Server, type Socket } from 'node:net';
import { packet, publishPacket, readPublish, takePacket } from './mqtt-wire.js';

export class MqttTestBroker {
  private server?: Server;
  private readonly clients = new Map<Socket, Set<string>>();
  private readonly retained = new Map<string, Buffer>();

  constructor(private readonly credentials?: { username: string; password: string }) {}

  listen(port = 0): Promise<number> {
    this.server = createServer((socket) => {
      this.clients.set(socket, new Set());
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (let next = takePacket(buffer); next; next = takePacket(buffer)) {
          buffer = next.rest;
          this.handle(socket, next.packet.type, next.packet.body, next.packet);
        }
      });
    });
    return new Promise((resolve) => this.server!.listen(port, '127.0.0.1', () => resolve((this.server!.address() as { port: number }).port)));
  }

  /** 장치가 보낸 것처럼 발행한다 */
  publish(topic: string, payload: string, retain = false): void {
    const body = Buffer.from(payload, 'utf8');
    if (retain) this.retained.set(topic, body);
    for (const [socket, topics] of this.clients) if (topics.has(topic)) socket.write(publishPacket(topic, body));
  }

  async close(): Promise<void> {
    for (const socket of this.clients.keys()) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(socket: Socket, type: number, body: Buffer, raw: Parameters<typeof readPublish>[0]): void {
    if (type === 1) {
      const nameLength = body.readUInt16BE(0);
      let offset = 2 + nameLength + 4;
      const flags = body[2 + nameLength + 1]!;
      const read = (): string => {
        const length = body.readUInt16BE(offset);
        const text = body.subarray(offset + 2, offset + 2 + length).toString('utf8');
        offset += 2 + length;
        return text;
      };
      read(); // client id
      const username = flags & 0x80 ? read() : '';
      const password = flags & 0x40 ? read() : '';
      const ok = !this.credentials || (this.credentials.username === username && this.credentials.password === password);
      socket.write(Buffer.from([0x20, 2, 0, ok ? 0 : 4]));
      if (!ok) socket.end();
    } else if (type === 8) {
      const id = body.readUInt16BE(0);
      let offset = 2;
      const granted: number[] = [];
      while (offset < body.length) {
        const length = body.readUInt16BE(offset);
        const topic = body.subarray(offset + 2, offset + 2 + length).toString('utf8');
        offset += 2 + length + 1;
        this.clients.get(socket)?.add(topic);
        granted.push(0);
      }
      socket.write(packet(0x90, Buffer.from([id >> 8, id & 0xff, ...granted])));
      for (const topic of this.clients.get(socket) ?? []) {
        const kept = this.retained.get(topic);
        if (kept) socket.write(publishPacket(topic, kept, true));
      }
    } else if (type === 3) {
      const message = readPublish(raw);
      this.publish(message.topic, message.payload.toString('utf8'), message.retain);
    } else if (type === 12) {
      socket.write(Buffer.from([0xd0, 0x00]));
    } else if (type === 14) {
      socket.end();
    }
  }
}
