/**
 * MQTT 3.1.1 publisher — QoS 0 and QoS 1 (resolves on PUBACK), will message, keepalive. No dependency: the wire format
 * is the same hand-written code the collector's reader and the test broker share (mqtt-wire.ts).
 *
 * Used by the integration MQTT sink (docs/design/integration-v1.md §5.5): one publisher per subscription, success of a
 * delivery = the broker's PUBACK.
 *
 * Important: no reconnect inside the client, by design. A publisher whose connection broke rejects every pending and
 *    later publish at once (`connected` turns false); its owner drops it and calls `MqttPublisher.connect` again on the
 *    next delivery. The delivery retry schedule is the backoff — a second, hidden backoff inside the client would
 *    make "when will it try again" unanswerable, and a silent resend after a reconnect would duplicate messages the
 *    dispatcher already counts as failed.
 * Important: the connection target can be pinned (`lookup`) — the egress check resolves the host once, and the socket
 *    must go to exactly that address, not to whatever DNS answers a moment later (DNS rebinding).
 */
import { Socket, type LookupFunction } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { fill, tr } from '@aas/core';
import { connectPacket, publishPacket, readPuback, takePacket, type WillMessage } from './mqtt-wire.js';

export interface MqttPublisherOptions {
  /** mqtt://host:port or mqtts://host:port — no userinfo (credentials go in username/password) */
  url: string;
  username?: string;
  password?: string;
  /** Default: `vexplor-aas-pub-` + random */
  clientId?: string;
  /** Seconds, default 30 */
  keepAliveSec?: number;
  will?: WillMessage;
  /** Default 5000 */
  connectTimeoutMs?: number;
  /** Default 10000 — a QoS 1 publish without PUBACK within this time is rejected */
  ackTimeoutMs?: number;
  /** Pinned address resolution from the egress check */
  lookup?: LookupFunction;
  /** TLS server name (SNI and certificate check) when connecting to a pinned address */
  servername?: string;
}

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_PACKET_ID = 0xffff;

export class MqttPublisher {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly inFlight = new Map<number, Pending>();
  private nextId = 1;
  private ping?: NodeJS.Timeout;
  private open = true;
  /** Why the connection ended — the message of every later rejection */
  private reason = '';

  private constructor(
    private readonly socket: Socket,
    private readonly ackTimeoutMs: number,
  ) {}

  /** True until the connection breaks or `close()` is called */
  get connected(): boolean {
    return this.open;
  }

  static async connect(options: MqttPublisherOptions): Promise<MqttPublisher> {
    const parsed = parseBrokerUrl(options.url);
    const timeoutMs = options.connectTimeoutMs ?? 5000;
    const keepAlive = options.keepAliveSec ?? 30;
    const socket = await openSocket(parsed, options, timeoutMs);
    const publisher = new MqttPublisher(socket, options.ackTimeoutMs ?? 10_000);
    try {
      await publisher.handshake(
        {
          clientId: options.clientId ?? `vexplor-aas-pub-${Math.random().toString(16).slice(2, 10)}`,
          keepAlive,
          ...(options.username ? { username: options.username } : {}),
          ...(options.password ? { password: options.password } : {}),
          ...(options.will ? { will: options.will } : {}),
        },
        timeoutMs,
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
    if (keepAlive > 0) {
      // PINGREQ at half the keepalive — the broker drops a client that stays silent for 1.5 × keepAlive
      publisher.ping = setInterval(() => {
        if (publisher.open) publisher.socket.write(Buffer.from([0xc0, 0x00]));
      }, (keepAlive / 2) * 1000);
      publisher.ping.unref();
    }
    return publisher;
  }

  /**
   * Publishes one message. QoS 0 resolves once the bytes are handed to the socket; QoS 1 resolves on the broker's PUBACK
   * and rejects on ack timeout or a broken connection (the caller retries — there is no resend here).
   */
  publish(topic: string, payload: Buffer, options: { qos: 0 | 1; retain: boolean }): Promise<void> {
    if (!this.open) return Promise.reject(new Error(this.reason || tr('MQTT 연결이 닫혀 있습니다.')));
    if (options.qos === 0) {
      return new Promise((resolve, reject) => {
        this.socket.write(publishPacket(topic, payload, { qos: 0, retain: options.retain }), (error) => (error ? reject(error) : resolve()));
      });
    }
    const packetId = this.allocateId();
    if (packetId === undefined) return Promise.reject(new Error(tr('응답을 기다리는 MQTT 메시지가 너무 많습니다.')));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(packetId);
        reject(new Error(fill(tr('MQTT 브로커가 {0}ms 안에 수신 확인(PUBACK)을 보내지 않았습니다.'), { 0: this.ackTimeoutMs })));
      }, this.ackTimeoutMs);
      this.inFlight.set(packetId, { resolve, reject, timer });
      this.socket.write(publishPacket(topic, payload, { qos: 1, retain: options.retain, packetId }));
    });
  }

  /** Sends DISCONNECT (so the broker does not publish the will) and rejects pending publishes with 'closed' */
  async close(): Promise<void> {
    if (!this.open) {
      this.socket.destroy();
      return;
    }
    this.shutdown(tr('MQTT 연결을 닫았습니다.'));
    await new Promise<void>((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.end(Buffer.from([0xe0, 0x00]), () => resolve());
      setTimeout(resolve, 1000).unref();
    });
    this.socket.destroy();
  }

  /** Next free packet id, wrapping 65535 → 1 and skipping ids still waiting for their PUBACK */
  private allocateId(): number | undefined {
    for (let tries = 0; tries < MAX_PACKET_ID; tries++) {
      const id = this.nextId;
      this.nextId = id >= MAX_PACKET_ID ? 1 : id + 1;
      if (!this.inFlight.has(id)) return id;
    }
    return undefined;
  }

  private shutdown(reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.reason = reason;
    if (this.ping) clearInterval(this.ping);
    for (const [id, pending] of this.inFlight) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.inFlight.delete(id);
    }
  }

  private handshake(options: Parameters<typeof connectPacket>[0], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.shutdown(error.message);
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(() => finish(new Error(tr('MQTT 연결 응답이 없습니다(시간 초과).'))), timeoutMs);
      this.socket.on('error', (error) => {
        this.shutdown(error.message);
        finish(error);
      });
      this.socket.on('close', () => {
        this.shutdown(this.reason || tr('MQTT 브로커와의 연결이 끊겼습니다.'));
        finish(new Error(tr('MQTT 브로커와의 연결이 끊겼습니다.')));
      });
      this.socket.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (let next = takePacket(this.buffer); next; next = takePacket(this.buffer)) {
          this.buffer = next.rest;
          const { type, body } = next.packet;
          if (type === 2) {
            // CONNACK — non-zero means refused (1-5: protocol version, client id, server, username/password, authorization)
            if (body[1] !== 0) finish(new Error(fill(tr('MQTT 브로커가 연결을 거절했습니다(코드 {0}).'), { 0: String(body[1]) })));
            else finish();
          } else if (type === 4) {
            const id = readPuback(next.packet);
            const pending = this.inFlight.get(id);
            if (pending) {
              clearTimeout(pending.timer);
              this.inFlight.delete(id);
              pending.resolve();
            }
          }
          // PINGRESP (13) and anything else: nothing to do — this client never subscribes
        }
      });
      this.socket.write(connectPacket(options));
    });
  }
}

interface BrokerAddress {
  host: string;
  port: number;
  tls: boolean;
}

/** mqtt(s)://host:port → address. Userinfo is refused: credentials must not travel inside a URL that gets logged */
export function parseBrokerUrl(url: string): BrokerAddress {
  const match = /^(mqtts?):\/\//i.exec(url);
  if (!match) throw new Error(fill(tr('MQTT 주소는 mqtt:// 또는 mqtts:// 로 시작해야 합니다: {0}'), { 0: url }));
  const tls = match[1]!.toLowerCase() === 'mqtts';
  const parsed = new URL(url.replace(/^mqtt(s?):/i, 'http$1:'));
  if (parsed.username || parsed.password) throw new Error(tr('MQTT 주소에 사용자 정보를 넣지 마십시오. 사용자 이름과 비밀번호는 따로 줍니다.'));
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  return { host, port: parsed.port ? Number(parsed.port) : tls ? 8883 : 1883, tls };
}

function openSocket(address: BrokerAddress, options: MqttPublisherOptions, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let socket: Socket;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(fill(tr('MQTT 브로커에 붙지 못했습니다(시간 초과): {0}:{1}'), { 0: address.host, 1: address.port })));
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    };
    const lookup = options.lookup ? { lookup: options.lookup } : {};
    socket = address.tls
      ? tlsConnect({ host: address.host, port: address.port, servername: options.servername ?? address.host, ...lookup }, done)
      : new Socket().connect({ host: address.host, port: address.port, ...lookup }, done);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
