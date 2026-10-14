/**
 * MQTT — connects to a test broker, subscribes, and reads the last received value via the collector.
 */
import { collectOnce, type AidInterface, type ValueSample } from '@aas/collector';
import { afterEach, describe, expect, it } from 'vitest';
import { MqttReader, MqttTestBroker, payloadValue, topicOf } from '../src/index.js';

const descriptorFor = (port: number, auth = ''): AidInterface => ({
  name: 'InterfaceTemplateForMQTT',
  protocol: 'MQTT',
  base: `mqtt://${auth}127.0.0.1:${port}`,
  properties: [
    { name: 'Temperature', href: 'plant/m1/temp', observable: true, formFields: { mqv_controlPacket: 'subscribe' } },
    { name: 'Status', href: '/plant/m1/status', observable: true, formFields: {} },
    { name: 'Pressure', href: 'plant/m1/pressure', observable: true, formFields: {} },
  ],
});

describe('MQTT address · payload', () => {
  it('topic is the href as is (one leading / stripped); for an absolute address, the path', () => {
    expect(topicOf('plant/m1/temp')).toBe('plant/m1/temp');
    expect(topicOf('/plant/m1/temp')).toBe('plant/m1/temp');
    expect(topicOf('mqtt://broker:1883/plant/m1/temp')).toBe('plant/m1/temp');
  });
  it('payload — number · boolean · {"value": …} · text', () => {
    expect(payloadValue(Buffer.from('12.5'))).toBe(12.5);
    expect(payloadValue(Buffer.from('true'))).toBe(true);
    expect(payloadValue(Buffer.from('{"value":"RUN","ts":1}'))).toBe('RUN');
    expect(payloadValue(Buffer.from('가동'))).toBe('가동');
  });
});

describe('MQTT collection — test broker', () => {
  let broker: MqttTestBroker | undefined;
  let reader: MqttReader | undefined;
  afterEach(async () => {
    await reader?.close();
    await broker?.close();
  });

  it('reads retained messages and new values; a topic with nothing yet is waiting for a value, not a failure', async () => {
    broker = new MqttTestBroker();
    const port = await broker.listen();
    broker.publish('plant/m1/temp', '21.5', true); // value retained before connecting
    const descriptor = descriptorFor(port);
    reader = await MqttReader.connect(descriptor, { settleMs: 200 });
    broker.publish('plant/m1/status', '{"value":"RUN"}');
    const samples: ValueSample[] = [];
    const sink = { append: async (batch: readonly ValueSample[]) => void samples.push(...batch) };
    const report = await collectOnce(descriptor, reader, sink, { packageId: 'p1' });
    expect(Object.fromEntries(samples.map((s) => [s.propertyName, s.valueNumber ?? s.valueText]))).toEqual({ Temperature: 21.5, Status: 'RUN' });
    expect(report.pending?.map((p) => p.propertyName)).toEqual(['Pressure']);
    expect(report.failures).toEqual([]);

    // When the value changes, the next collection reads the new value
    broker.publish('plant/m1/temp', '22');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await reader.read(['plant/m1/temp']))[0]!.value).toBe(22);
  });

  it('reports the reason the broker rejected a wrong username/password', async () => {
    broker = new MqttTestBroker({ username: 'aas', password: 'secret' });
    const port = await broker.listen();
    await expect(MqttReader.connect(descriptorFor(port, 'aas:wrong@'), { timeoutMs: 1000 })).rejects.toThrow(/거절.*4/);
    reader = await MqttReader.connect(descriptorFor(port, 'aas:secret@'), { settleMs: 50 });
    expect((await reader.read(['plant/m1/temp']))[0]!.pending).toBe(true);
  });
});
