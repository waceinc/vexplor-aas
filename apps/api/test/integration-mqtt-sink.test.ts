/**
 * MQTT sink (design §5.5; platform 7.6, CMMS SHOULD MQTT).
 *
 * The client here is a fake with the `MqttPublisher` surface — the wire, PUBACK and broker behaviour are WP2's tests
 * (`packages/fieldbus/test/mqtt-publisher.test.ts`). This file pins what the sink publishes where, and how failures
 * flow into the delivery retry schedule.
 * The last block runs the sink with the real composed client (WP2's MqttPublisher) against the test broker.
 */
import { EVENT_TYPES } from '@aas/core';
import { MqttTestBroker } from '@aas/fieldbus';
import { describe, expect, it } from 'vitest';

import { toCloudEvent, cloudEventBody } from '../src/integration/cloudevents.js';
import { integrationComposition } from '../src/integration/compose.js';
import { Dispatcher } from '../src/integration/dispatcher.js';
import { pinnedLookup } from '../src/integration/egress.js';
import { MqttSink, type MqttConnect, type MqttSinkClient, type MqttSinkConnectOptions } from '../src/integration/mqtt-sink.js';
import { clock, memoryStore, sampleRow, testServices } from './helpers/integration-scenarios.js';

interface Published {
  topic: string;
  payload: string;
  qos: 0 | 1;
  retain: boolean;
}

function fakeBroker(options: { failConnect?: string; failPublish?: string } = {}) {
  const published: Published[] = [];
  const connects: MqttSinkConnectOptions[] = [];
  let closed = 0;
  const connect: MqttConnect = async (connectOptions) => {
    connects.push(connectOptions);
    if (options.failConnect) throw new Error(options.failConnect);
    const client: MqttSinkClient & { connected: boolean } = {
      connected: true,
      async publish(topic, payload, publishOptions) {
        if (options.failPublish && topic.includes('/events/')) throw new Error(options.failPublish);
        // Resolves only after the broker "acknowledged" — the sink must await it
        await new Promise((resolve) => setTimeout(resolve, 1));
        published.push({ topic, payload: payload.toString(), ...publishOptions });
      },
      async close() {
        closed++;
        client.connected = false;
      },
    };
    return client;
  };
  return { published, connects, connect, closedCount: () => closed };
}

const target = (patch: Partial<Parameters<MqttSink['deliver']>[0]> = {}) => ({
  subscriptionId: 'sub_1',
  url: 'mqtts://broker.example.com:8883',
  username: 'plant',
  password: 'secret',
  lookup: pinnedLookup('93.184.216.40'),
  servername: 'broker.example.com',
  ...patch,
});

const ctx = { instanceId: '9f2c4e1a7b3d' };

describe('MqttSink', () => {
  it('publishes the CloudEvent at QoS 1 to {prefix}/events/{short type}, after an online status', async () => {
    const broker = fakeBroker();
    const sink = new MqttSink(broker.connect, () => '9f2c4e1a7b3d', () => '2026-10-14T00:00:00.000Z');
    const event = toCloudEvent(sampleRow(EVENT_TYPES.equipmentAlarmRaised), ctx);
    await sink.deliver(target(), event, cloudEventBody(event));
    expect(broker.published).toEqual([
      { topic: 'vexplor/aas/9f2c4e1a7b3d/status', payload: '{"online":true,"since":"2026-10-14T00:00:00.000Z"}', qos: 1, retain: true },
      { topic: 'vexplor/aas/9f2c4e1a7b3d/events/equipment.alarm.raised.v1', payload: cloudEventBody(event).toString(), qos: 1, retain: false },
    ]);
    expect(broker.connects[0]).toMatchObject({
      url: 'mqtts://broker.example.com:8883',
      username: 'plant',
      password: 'secret',
      servername: 'broker.example.com',
      will: { topic: 'vexplor/aas/9f2c4e1a7b3d/status', retain: true, qos: 1 },
    });
    expect(broker.connects[0]!.will!.payload.toString()).toBe('{"online":false}');
  });

  it('retainState: the current state is also retained per asset (late subscribers see it at once)', async () => {
    const broker = fakeBroker();
    const sink = new MqttSink(broker.connect, () => 'x');
    const event = toCloudEvent(sampleRow(EVENT_TYPES.equipmentStateChanged), ctx);
    await sink.deliver(target({ topicPrefix: 'plant/aas', retainState: true }), event, cloudEventBody(event));
    const retained = broker.published.find((entry) => entry.topic.endsWith('/state'))!;
    expect(retained.topic).toBe(`plant/aas/equipment/${Buffer.from('https://example.com/ids/asset/press-03').toString('base64url')}/state`);
    expect(retained).toMatchObject({ qos: 1, retain: true });
    expect(JSON.parse(retained.payload)).toEqual({ state: 'alarm', since: event.time, eventId: event.id });
  });

  it('reuses the connection; reconnects when credentials change; offline status on close', async () => {
    const broker = fakeBroker();
    const sink = new MqttSink(broker.connect, () => 'x');
    const event = toCloudEvent(sampleRow(EVENT_TYPES.equipmentAlarmRaised), ctx);
    await sink.deliver(target(), event, cloudEventBody(event));
    await sink.deliver(target(), event, cloudEventBody(event));
    expect(broker.connects).toHaveLength(1);
    await sink.deliver(target({ password: 'rotated' }), event, cloudEventBody(event));
    expect(broker.connects).toHaveLength(2);
    await sink.close();
    expect(broker.published.at(-1)).toMatchObject({ topic: 'vexplor/aas/x/status', payload: '{"online":false}', retain: true });
    expect(broker.closedCount()).toBe(2);
  });

  it('a failed publish rejects and drops the connection (the next delivery connects again)', async () => {
    const broker = fakeBroker({ failPublish: 'ack timeout' });
    const sink = new MqttSink(broker.connect, () => 'x');
    const event = toCloudEvent(sampleRow(EVENT_TYPES.equipmentAlarmRaised), ctx);
    await expect(sink.deliver(target(), event, cloudEventBody(event))).rejects.toThrow('ack timeout');
    await expect(sink.deliver(target(), event, cloudEventBody(event))).rejects.toThrow('ack timeout');
    expect(broker.connects).toHaveLength(2);
  });
});

describe('MQTT deliveries through the dispatcher', () => {
  async function mqttWorld(broker: ReturnType<typeof fakeBroker>) {
    const time = clock();
    const store = await memoryStore(time.iso);
    const services = testServices({ resolve: { 'broker.example.com': ['93.184.216.40'] }, now: time.now });
    const box = services.secrets!;
    const sink = new MqttSink(broker.connect, () => '9f2c4e1a7b3d');
    const dispatcher = new Dispatcher({ store, instanceId: () => '9f2c4e1a7b3d', egress: services.egress, secrets: box, storeKind: 'memory', mqtt: sink, now: time.now, random: () => 0.5 });
    await dispatcher.fanOut();
    const subscription = await store.createSubscription({
      name: 'Broker', kind: 'mqtt', url: 'mqtts://broker.example.com:8883', types: ['*'], packageIds: [], enabled: true, options: {},
      secretHint: 'abcd', secrets: { keyId: box.keyId, secretSealed: box.seal('whsec_x'), credentialsSealed: box.seal('plant:pa:ss') },
    });
    await store.appendEvents([{ id: 'evt_m1', type: EVENT_TYPES.equipmentStateChanged, time: time.iso(), packageId: 'pkg_1', data: { state: 'run' } }]);
    return { store, time, dispatcher, subscription };
  }

  it('success = acknowledged publish; the sealed credentials are opened for the connect only', async () => {
    const broker = fakeBroker();
    const { store, dispatcher, subscription } = await mqttWorld(broker);
    await dispatcher.runOnce();
    expect((await store.listDeliveries(subscription.id)).items[0]).toMatchObject({ status: 'succeeded', lastAddress: '93.184.216.40' });
    expect(broker.connects[0]).toMatchObject({ username: 'plant', password: 'pa:ss', servername: 'broker.example.com' });
  });

  it('wrong credentials → error → retried on the schedule, then dead', async () => {
    const broker = fakeBroker({ failConnect: 'connection refused: not authorized' });
    const { store, dispatcher, subscription, time } = await mqttWorld(broker);
    await dispatcher.runOnce();
    const [first] = (await store.listDeliveries(subscription.id)).items;
    expect(first).toMatchObject({ status: 'pending', lastError: 'connection refused: not authorized' });
    for (let i = 0; i < 13; i++) {
      time.advance(10 * 3_600_000);
      await dispatcher.runOnce();
    }
    expect((await store.listDeliveries(subscription.id)).items[0]).toMatchObject({ status: 'dead', attempts: 12 });
  });
});

describe('with the real MQTT client (WP2 MqttPublisher) and the test broker', () => {
  async function broker() {
    const server = new MqttTestBroker({ username: 'plant', password: 'secret' });
    const port = await server.listen(0);
    return { server, port };
  }
  const connect = integrationComposition().mqttConnect!;

  it('publishes at QoS 1, keeps the state and the online status retained, goes offline on close', async () => {
    const { server, port } = await broker();
    try {
      const sink = new MqttSink(connect, () => '9f2c4e1a7b3d');
      const event = toCloudEvent(sampleRow(EVENT_TYPES.equipmentStateChanged), ctx);
      // The host name never resolves — the connection goes to the pinned address (egress)
      await sink.deliver(target({ url: `mqtt://broker.invalid:${port}`, lookup: pinnedLookup('127.0.0.1'), servername: 'broker.invalid', retainState: true }), event, cloudEventBody(event));
      const published = server.received.find((message) => message.topic.endsWith('/events/equipment.state.changed.v1'))!;
      expect(published).toMatchObject({ qos: 1, retain: false });
      expect(published.payload.toString()).toBe(cloudEventBody(event).toString());
      const stateTopic = `vexplor/aas/9f2c4e1a7b3d/equipment/${Buffer.from('https://example.com/ids/asset/press-03').toString('base64url')}/state`;
      expect(JSON.parse(server.retainedOf(stateTopic)!.toString())).toMatchObject({ state: 'alarm', eventId: event.id });
      expect(JSON.parse(server.retainedOf('vexplor/aas/9f2c4e1a7b3d/status')!.toString())).toMatchObject({ online: true });
      await sink.close();
      expect(JSON.parse(server.retainedOf('vexplor/aas/9f2c4e1a7b3d/status')!.toString())).toEqual({ online: false });
    } finally {
      await server.close();
    }
  });

  it('wrong credentials are refused — the delivery fails (and is retried by the dispatcher)', async () => {
    const { server, port } = await broker();
    try {
      const sink = new MqttSink(connect, () => 'x');
      const event = toCloudEvent(sampleRow(EVENT_TYPES.equipmentAlarmRaised), ctx);
      await expect(
        sink.deliver(target({ url: `mqtt://broker.invalid:${port}`, password: 'wrong', lookup: pinnedLookup('127.0.0.1'), servername: 'broker.invalid' }), event, cloudEventBody(event)),
      ).rejects.toThrow();
      expect(server.received.filter((message) => message.topic.includes('/events/'))).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
