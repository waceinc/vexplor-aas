/**
 * Test MQTT broker — used for tests and virtual equipment (instead of a real broker). Supports what the collector and the
 * integration publisher need: QoS 0 and QoS 1 (PUBACK), `+` / `#` wildcard subscriptions, retained messages (a
 * zero-length retained publish deletes the retained message) and will messages on an abrupt disconnect.
 * If a username/password is configured, clients connecting with different credentials are rejected (code 4).
 *
 * Important: not a full broker — no persistent sessions, no QoS 2, no redelivery of unacknowledged QoS 1 messages to
 *    subscribers. Behaviour that existed before QoS 1 (exact-topic QoS 0 forwarding, retained replay on subscribe) is kept.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { packet, pubackPacket, publishPacket, readConnect, readPublish, takePacket, topicMatches, type WillMessage } from './mqtt-wire.js';

interface Client {
  /** filter -> granted QoS */
  filters: Map<string, 0 | 1>;
  will?: WillMessage;
  /** Set by DISCONNECT — a clean close must not publish the will */
  clean: boolean;
  nextPacketId: number;
}

/** One message as the broker saw it — lets tests assert what arrived without a subscriber */
export interface BrokerMessage {
  topic: string;
  payload: Buffer;
  qos: number;
  retain: boolean;
  packetId?: number;
}

export class MqttTestBroker {
  private server?: Server;
  private readonly clients = new Map<Socket, Client>();
  private readonly retained = new Map<string, Buffer>();
  /** Every PUBLISH received from a client, in order */
  readonly received: BrokerMessage[] = [];
  /** When true, QoS 1 publishes get no PUBACK — lets tests exercise the publisher's ack timeout */
  withholdPuback = false;

  constructor(private readonly credentials?: { username: string; password: string }) {}

  listen(port = 0): Promise<number> {
    this.server = createServer((socket) => {
      this.clients.set(socket, { filters: new Map(), clean: false, nextPacketId: 1 });
      const gone = (): void => {
        const client = this.clients.get(socket);
        this.clients.delete(socket);
        // Will message: only when the connection ended without DISCONNECT (MQTT 3.1.1 §3.1.2.5)
        if (client?.will && !client.clean) this.deliver(client.will.topic, client.will.payload, client.will.qos, client.will.retain);
      };
      socket.on('close', gone);
      socket.on('error', () => socket.destroy());
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

  /** Publishes as if sent by a device */
  publish(topic: string, payload: string, retain = false): void {
    this.deliver(topic, Buffer.from(payload, 'utf8'), 0, retain);
  }

  /** The retained message of a topic, if any */
  retainedOf(topic: string): Buffer | undefined {
    return this.retained.get(topic);
  }

  /** Drops every client connection without a DISCONNECT — what a broker crash looks like to clients */
  dropClients(): void {
    for (const socket of this.clients.keys()) socket.destroy();
  }

  async close(): Promise<void> {
    for (const socket of this.clients.keys()) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private deliver(topic: string, body: Buffer, qos: number, retain: boolean): void {
    if (retain) {
      if (body.length === 0) this.retained.delete(topic);
      else this.retained.set(topic, Buffer.from(body));
    }
    for (const [socket, client] of this.clients) {
      if (socket.destroyed) continue;
      const granted = this.grantedFor(client, topic);
      if (granted === undefined) continue;
      // Forwarded messages carry retain=false (MQTT 3.1.1 §3.3.1.3: retain is only set when replaying on subscribe)
      socket.write(this.outgoing(client, topic, body, Math.min(qos, granted) as 0 | 1, false));
    }
  }

  /** Highest QoS among the client's filters that match the topic; undefined = not subscribed */
  private grantedFor(client: Client, topic: string): 0 | 1 | undefined {
    let best: 0 | 1 | undefined;
    for (const [filter, qos] of client.filters) {
      if (topicMatches(filter, topic) && (best === undefined || qos > best)) best = qos;
    }
    return best;
  }

  private outgoing(client: Client, topic: string, body: Buffer, qos: 0 | 1, retain: boolean): Buffer {
    if (qos === 0) return publishPacket(topic, body, retain);
    const packetId = client.nextPacketId;
    client.nextPacketId = packetId >= 0xffff ? 1 : packetId + 1;
    return publishPacket(topic, body, { qos, retain, packetId });
  }

  private handle(socket: Socket, type: number, body: Buffer, raw: Parameters<typeof readPublish>[0]): void {
    const client = this.clients.get(socket);
    if (!client) return;
    if (type === 1) {
      const request = readConnect(body);
      const ok = !this.credentials || (this.credentials.username === (request.username ?? '') && this.credentials.password === (request.password ?? ''));
      socket.write(Buffer.from([0x20, 2, 0, ok ? 0 : 4]));
      if (!ok) {
        client.clean = true; // a refused connection never had a session, so no will either
        socket.end();
        return;
      }
      if (request.will) client.will = request.will;
    } else if (type === 8) {
      const id = body.readUInt16BE(0);
      let offset = 2;
      const granted: number[] = [];
      const added: string[] = [];
      while (offset < body.length) {
        const length = body.readUInt16BE(offset);
        const filter = body.subarray(offset + 2, offset + 2 + length).toString('utf8');
        const requested = (body[offset + 2 + length] ?? 0) & 3;
        offset += 2 + length + 1;
        const qos = (requested >= 1 ? 1 : 0) as 0 | 1;
        client.filters.set(filter, qos);
        added.push(filter);
        granted.push(qos);
      }
      socket.write(packet(0x90, Buffer.from([id >> 8, id & 0xff, ...granted])));
      // Retained replay for the filters of this SUBSCRIBE only, each topic once
      for (const [topic, kept] of this.retained) {
        const filter = added.find((candidate) => topicMatches(candidate, topic));
        if (filter !== undefined) socket.write(this.outgoing(client, topic, kept, client.filters.get(filter)!, true));
      }
    } else if (type === 3) {
      const message = readPublish(raw);
      this.received.push({
        topic: message.topic,
        payload: Buffer.from(message.payload),
        qos: message.qos,
        retain: message.retain,
        ...(message.packetId === undefined ? {} : { packetId: message.packetId }),
      });
      if (message.qos === 1 && message.packetId !== undefined && !this.withholdPuback) socket.write(pubackPacket(message.packetId));
      this.deliver(message.topic, message.payload, message.qos, message.retain);
    } else if (type === 12) {
      socket.write(Buffer.from([0xd0, 0x00]));
    } else if (type === 14) {
      client.clean = true;
      socket.end();
    }
  }
}
