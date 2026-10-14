/**
 * MQTT publisher (QoS 0/1) and the test broker's QoS 1, wildcard, retained and will support (design §5.5, test plan 7.6).
 *
 * Important: every assertion goes over a real local socket (127.0.0.1) — a fake transport would not show that the bytes
 *    the publisher writes are the bytes a broker accepts.
 */
import { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectPacket,
  MqttPublisher,
  MqttTestBroker,
  packet,
  parseBrokerUrl,
  publishPacket,
  readConnect,
  readPublish,
  takePacket,
  topicMatches,
  utf8,
} from '../src/index.js';

/** Minimal subscriber written against the wire helpers — records every PUBLISH it receives */
class Subscriber {
  readonly messages: { topic: string; payload: string; retain: boolean; qos: number }[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private constructor(private readonly socket: Socket) {}

  static async connect(port: number, filters: { filter: string; qos: 0 | 1 }[]): Promise<Subscriber> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = new Socket().connect(port, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const subscriber = new Subscriber(socket);
    await new Promise<void>((resolve) => {
      socket.on('data', (chunk: Buffer) => {
        subscriber.buffer = Buffer.concat([subscriber.buffer, chunk]);
        for (let next = takePacket(subscriber.buffer); next; next = takePacket(subscriber.buffer)) {
          subscriber.buffer = next.rest;
          if (next.packet.type === 2) {
            const body = Buffer.concat(filters.map((f) => Buffer.concat([utf8(f.filter), Buffer.from([f.qos])])));
            socket.write(packet(0x82, Buffer.concat([Buffer.from([0, 1]), body])));
          } else if (next.packet.type === 9) resolve();
          else if (next.packet.type === 3) {
            const message = readPublish(next.packet);
            subscriber.messages.push({ topic: message.topic, payload: message.payload.toString('utf8'), retain: message.retain, qos: message.qos });
            if (message.qos === 1 && message.packetId !== undefined) socket.write(Buffer.from([0x40, 2, message.packetId >> 8, message.packetId & 0xff]));
          }
        }
      });
      socket.write(connectPacket({ clientId: `sub-${Math.random()}`, keepAlive: 0 }));
    });
    return subscriber;
  }

  async waitFor(count: number, ms = 2000): Promise<void> {
    const until = Date.now() + ms;
    while (this.messages.length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  close(): void {
    this.socket.destroy();
  }
}

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MQTT wire', () => {
  it('QoS 1 PUBLISH carries the packet id and the flag bits; the old positional retain form still works', () => {
    const qos1 = publishPacket('a/b', Buffer.from('x'), { qos: 1, retain: true, packetId: 0x1234, dup: true });
    expect(qos1[0]).toBe(0x30 | 0x08 | 0x02 | 0x01);
    const parsed = readPublish(takePacket(qos1)!.packet);
    expect(parsed).toMatchObject({ topic: 'a/b', qos: 1, packetId: 0x1234, retain: true });
    expect(parsed.payload.toString()).toBe('x');
    expect(publishPacket('t', Buffer.from('v'), true)[0]).toBe(0x31);
    expect(() => publishPacket('t', Buffer.from('v'), { qos: 1 })).toThrow();
  });

  it('CONNECT round-trips client id, keepalive, will and credentials', () => {
    const bytes = connectPacket({
      clientId: 'c1',
      keepAlive: 30,
      username: 'u',
      password: 'p',
      will: { topic: 'w/t', payload: Buffer.from('{"online":false}'), retain: true, qos: 1 },
    });
    const request = readConnect(takePacket(bytes)!.packet.body);
    expect(request).toMatchObject({ clientId: 'c1', keepAlive: 30, cleanSession: true, username: 'u', password: 'p' });
    expect(request.will).toMatchObject({ topic: 'w/t', retain: true, qos: 1 });
    expect(request.will!.payload.toString()).toBe('{"online":false}');
  });

  it('topic filters: + is one level, # the rest (parent included), $ topics are not matched by leading wildcards', () => {
    expect(topicMatches('plant/+/temp', 'plant/m1/temp')).toBe(true);
    expect(topicMatches('plant/+/temp', 'plant/m1/x/temp')).toBe(false);
    expect(topicMatches('plant/#', 'plant/m1/temp')).toBe(true);
    expect(topicMatches('plant/#', 'plant')).toBe(true);
    expect(topicMatches('plant/#', 'other/m1')).toBe(false);
    expect(topicMatches('#', '$SYS/x')).toBe(false);
    expect(topicMatches('plant/m1', 'plant/m1/temp')).toBe(false);
  });

  it('broker URLs: default ports, TLS, and userinfo refused', () => {
    expect(parseBrokerUrl('mqtt://10.0.0.5')).toEqual({ host: '10.0.0.5', port: 1883, tls: false });
    expect(parseBrokerUrl('mqtts://broker.local:9999')).toEqual({ host: 'broker.local', port: 9999, tls: true });
    expect(() => parseBrokerUrl('mqtt://user:pw@host')).toThrow();
    expect(() => parseBrokerUrl('http://host')).toThrow();
  });
});

describe('MQTT publisher against the test broker', () => {
  let broker: MqttTestBroker | undefined;
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0)) await step();
    await broker?.close();
    broker = undefined;
  });

  it('QoS 1 publish resolves only after PUBACK and a wildcard subscriber receives it', async () => {
    broker = new MqttTestBroker();
    const port = await broker.listen();
    const subscriber = await Subscriber.connect(port, [{ filter: 'vexplor/aas/+/events/#', qos: 1 }]);
    cleanup.push(() => subscriber.close());
    const publisher = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}` });
    cleanup.push(() => publisher.close());

    await publisher.publish('vexplor/aas/abc/events/equipment.state.changed.v1', Buffer.from('{"id":"e1"}'), { qos: 1, retain: false });
    // The broker saw it as QoS 1 before the promise resolved
    expect(broker.received.at(-1)).toMatchObject({ topic: 'vexplor/aas/abc/events/equipment.state.changed.v1', qos: 1 });
    await subscriber.waitFor(1);
    expect(subscriber.messages[0]).toMatchObject({ topic: 'vexplor/aas/abc/events/equipment.state.changed.v1', payload: '{"id":"e1"}', qos: 1 });
  });

  it('QoS 1 publish is rejected when no PUBACK arrives within the ack timeout', async () => {
    broker = new MqttTestBroker();
    broker.withholdPuback = true;
    const port = await broker.listen();
    const publisher = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}`, ackTimeoutMs: 150 });
    cleanup.push(() => publisher.close());
    await expect(publisher.publish('t', Buffer.from('x'), { qos: 1, retain: false })).rejects.toThrow(/PUBACK/);
    // QoS 0 does not wait for an ack, so it still resolves
    await expect(publisher.publish('t', Buffer.from('x'), { qos: 0, retain: false })).resolves.toBeUndefined();
  });

  it('retained state reaches a late subscriber; a zero-length retained publish clears it', async () => {
    broker = new MqttTestBroker();
    const port = await broker.listen();
    const publisher = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}` });
    cleanup.push(() => publisher.close());
    await publisher.publish('p/equipment/X/state', Buffer.from('{"state":"run"}'), { qos: 1, retain: true });

    const late = await Subscriber.connect(port, [{ filter: 'p/equipment/+/state', qos: 1 }]);
    cleanup.push(() => late.close());
    await late.waitFor(1);
    expect(late.messages[0]).toMatchObject({ payload: '{"state":"run"}', retain: true });

    await publisher.publish('p/equipment/X/state', Buffer.alloc(0), { qos: 1, retain: true });
    expect(broker.retainedOf('p/equipment/X/state')).toBeUndefined();
    const later = await Subscriber.connect(port, [{ filter: 'p/#', qos: 0 }]);
    cleanup.push(() => later.close());
    await tick(100);
    expect(later.messages).toEqual([]);
  });

  it('the will is published on an abrupt close but not after a clean close', async () => {
    broker = new MqttTestBroker();
    const port = await broker.listen();
    const watcher = await Subscriber.connect(port, [{ filter: 'p/status', qos: 0 }]);
    cleanup.push(() => watcher.close());
    const will = { topic: 'p/status', payload: Buffer.from('{"online":false}'), retain: true, qos: 1 as const };

    const clean = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}`, will });
    await clean.close();
    await tick(100);
    expect(watcher.messages).toEqual([]);

    const abrupt = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}`, will });
    cleanup.push(() => abrupt.close());
    broker.dropClients(); // drops the watcher too, so check the retained will instead
    await tick(100);
    expect(broker.retainedOf('p/status')?.toString()).toBe('{"online":false}');
  });

  it('wrong credentials are refused with the broker code; a broken connection rejects at once and a new connect works', async () => {
    broker = new MqttTestBroker({ username: 'aas', password: 'secret' });
    const port = await broker.listen();
    await expect(MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}`, username: 'aas', password: 'wrong' })).rejects.toThrow(/4/);

    const first = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}`, username: 'aas', password: 'secret', ackTimeoutMs: 5000 });
    cleanup.push(() => first.close());
    broker.withholdPuback = true;
    const pending = first.publish('t', Buffer.from('x'), { qos: 1, retain: false });
    await tick(50);
    broker.dropClients();
    // The in-flight publish fails with the connection, not after the 5 s ack timeout
    await expect(pending).rejects.toThrow();
    expect(first.connected).toBe(false);
    await expect(first.publish('t', Buffer.from('x'), { qos: 1, retain: false })).rejects.toThrow();

    broker.withholdPuback = false;
    const second = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}`, username: 'aas', password: 'secret' });
    cleanup.push(() => second.close());
    await expect(second.publish('t', Buffer.from('y'), { qos: 1, retain: false })).resolves.toBeUndefined();
  });

  it('packet ids are distinct for concurrent QoS 1 publishes', async () => {
    broker = new MqttTestBroker();
    const port = await broker.listen();
    const publisher = await MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}` });
    cleanup.push(() => publisher.close());
    await Promise.all(Array.from({ length: 20 }, (_, i) => publisher.publish(`t/${i}`, Buffer.from(String(i)), { qos: 1, retain: false })));
    const ids = broker.received.filter((m) => m.qos === 1).map((m) => m.packetId);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('a connection refused by the OS is reported, not hung', async () => {
    broker = new MqttTestBroker();
    const port = await broker.listen();
    await broker.close();
    broker = undefined;
    await expect(MqttPublisher.connect({ url: `mqtt://127.0.0.1:${port}`, connectTimeoutMs: 2000 })).rejects.toThrow();
  });
});
