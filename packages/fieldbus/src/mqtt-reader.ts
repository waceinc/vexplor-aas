/**
 * MQTT collection adapter — subscribes to the AID property addresses (href = topic) and, on read, returns **the last value received**.
 *
 * MQTT is not request/response; devices push. So each collection cycle samples "the last value received so far",
 * and a topic that has never arrived is not a failure but pending — the collector does not fabricate values.
 * On the first read it briefly allows time for retained messages to arrive. Accepts mqtt:// and mqtts:// (TLS). Username/password go in the URL.
 * The body is read as text; if it is JSON, numbers and booleans are used as-is, and for the {"value": ...} shape the value is extracted.
 */
import { connect as tlsConnect } from 'node:tls';
import { Socket } from 'node:net';
import { fill, tr } from '@aas/core';
import type { AidInterface, ProtocolReader, ReadResult } from '@aas/collector';
import { packet, readPublish, takePacket, utf8 } from './mqtt-wire.js';

export interface MqttReaderOptions {
  timeoutMs?: number;
  /** Time to wait for retained messages before the first read */
  settleMs?: number;
  guard?: (url: string) => void;
  clientId?: string;
}

/** Property address -> topic. For an absolute address (mqtt://host/topic) the path; otherwise as-is (one leading / is stripped) */
export function topicOf(href: string): string {
  const absolute = href.match(/^mqtts?:\/\/[^/]+\/(.*)$/i);
  const topic = absolute ? absolute[1]! : href;
  return decodeURIComponent(topic.replace(/^\//, ''));
}

/** Body -> value */
export function payloadValue(payload: Buffer): unknown {
  const text = payload.toString('utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'value' in parsed) return (parsed as { value: unknown }).value;
  } catch {
    // Not JSON — use the text as-is
  }
  return text;
}

export class MqttReader implements ProtocolReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly latest = new Map<string, { payload: Buffer; at: string }>();
  private settled: Promise<void>;
  private ping?: NodeJS.Timeout;
  private error?: string;

  private constructor(
    private readonly descriptor: AidInterface,
    private readonly socket: Socket,
    settleMs: number,
  ) {
    this.settled = new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  get base(): string {
    return this.descriptor.base ?? '';
  }

  static async connect(descriptor: AidInterface, options: MqttReaderOptions = {}): Promise<MqttReader> {
    if (!descriptor.base) throw new Error(tr('EndpointMetadata.base가 없습니다.'));
    options.guard?.(descriptor.base);
    const url = new URL(descriptor.base.replace(/^mqtt(s?):/i, 'http$1:'));
    const secure = /^mqtts:/i.test(descriptor.base);
    const port = url.port ? Number(url.port) : secure ? 8883 : 1883;
    const timeoutMs = options.timeoutMs ?? 5000;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(fill(tr('MQTT 브로커에 붙지 못했습니다(시간 초과): {0}:{1}'), { 0: url.hostname, 1: port }))), timeoutMs);
      const done = (s: Socket): void => {
        clearTimeout(timer);
        s.removeAllListeners('error');
        resolve(s);
      };
      const s: Socket = secure ? tlsConnect({ host: url.hostname, port, servername: url.hostname }, () => done(s)) : new Socket().connect(port, url.hostname, () => done(s));
      s.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const reader = new MqttReader(descriptor, socket, options.settleMs ?? 400);
    await reader.handshake(url, options.clientId ?? `vexplor-aas-${Math.random().toString(16).slice(2, 10)}`, timeoutMs);
    return reader;
  }

  async read(sources: readonly string[]): Promise<ReadResult[]> {
    await this.settled;
    return sources.map((source) => {
      if (this.error) return { source, value: undefined, error: this.error };
      const message = this.latest.get(topicOf(source));
      if (!message) return { source, value: undefined, pending: true, quality: tr('아직 받은 메시지 없음') };
      return { source, value: payloadValue(message.payload), observedAt: message.at, quality: 'Good' };
    });
  }

  async close(): Promise<void> {
    if (this.ping) clearInterval(this.ping);
    if (!this.socket.destroyed) this.socket.end(Buffer.from([0xe0, 0x00]));
    this.socket.destroy();
  }

  private handshake(url: URL, clientId: string, timeoutMs: number): Promise<void> {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    const flags = 0x02 | (user ? 0x80 : 0) | (pass ? 0x40 : 0);
    const keepAlive = 60;
    const header = Buffer.concat([utf8('MQTT'), Buffer.from([4, flags, keepAlive >> 8, keepAlive & 0xff])]);
    const payload = Buffer.concat([utf8(clientId), ...(user ? [utf8(user)] : []), ...(pass ? [utf8(pass)] : [])]);
    const topics = [...new Set(this.descriptor.properties.flatMap((property) => (property.href ? [topicOf(property.href)] : [])))];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(tr('MQTT 연결 응답이 없습니다(시간 초과).'))), timeoutMs);
      const fail = (message: string): void => {
        clearTimeout(timer);
        this.error = message;
        reject(new Error(message));
      };
      this.socket.on('error', (error) => {
        this.error = error.message;
        fail(error.message);
      });
      this.socket.on('close', () => {
        this.error ??= tr('연결이 끊겼습니다.');
      });
      this.socket.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (let next = takePacket(this.buffer); next; next = takePacket(this.buffer)) {
          this.buffer = next.rest;
          const { type, body } = next.packet;
          if (type === 2) {
            // CONNACK — non-zero means refused (1-5: protocol version, client id, server, username/password, authorization)
            if (body[1] !== 0) return fail(fill(tr('MQTT 브로커가 연결을 거절했습니다(코드 {0}).'), { 0: String(body[1]) }));
            if (topics.length === 0) {
              clearTimeout(timer);
              return resolve();
            }
            const filters = Buffer.concat(topics.map((topic) => Buffer.concat([utf8(topic), Buffer.from([0])])));
            this.socket.write(packet(0x82, Buffer.concat([Buffer.from([0, 1]), filters])));
          } else if (type === 9) {
            clearTimeout(timer);
            this.ping = setInterval(() => this.socket.write(Buffer.from([0xc0, 0x00])), (keepAlive / 2) * 1000);
            this.ping.unref();
            resolve();
          } else if (type === 3) {
            const message = readPublish(next.packet);
            this.latest.set(message.topic, { payload: Buffer.from(message.payload), at: new Date().toISOString() });
            if (message.qos === 1 && message.packetId !== undefined) this.socket.write(Buffer.from([0x40, 2, message.packetId >> 8, message.packetId & 0xff]));
          }
        }
      });
      this.socket.write(packet(0x10, Buffer.concat([header, payload])));
    });
  }
}
