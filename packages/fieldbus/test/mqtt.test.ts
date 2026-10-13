/**
 * MQTT — 시험 브로커에 붙어 구독하고, 마지막으로 받은 값을 수집기로 읽는다.
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

describe('MQTT 주소 · 본문', () => {
  it('토픽은 href 그대로(앞 / 하나는 뗀다), 절대 주소면 경로', () => {
    expect(topicOf('plant/m1/temp')).toBe('plant/m1/temp');
    expect(topicOf('/plant/m1/temp')).toBe('plant/m1/temp');
    expect(topicOf('mqtt://broker:1883/plant/m1/temp')).toBe('plant/m1/temp');
  });
  it('본문 — 숫자 · 참거짓 · {"value": …} · 글자', () => {
    expect(payloadValue(Buffer.from('12.5'))).toBe(12.5);
    expect(payloadValue(Buffer.from('true'))).toBe(true);
    expect(payloadValue(Buffer.from('{"value":"RUN","ts":1}'))).toBe('RUN');
    expect(payloadValue(Buffer.from('가동'))).toBe('가동');
  });
});

describe('MQTT 수집 — 시험 브로커', () => {
  let broker: MqttTestBroker | undefined;
  let reader: MqttReader | undefined;
  afterEach(async () => {
    await reader?.close();
    await broker?.close();
  });

  it('보관 메시지와 새로 온 값을 읽고, 아직 안 온 토픽은 실패가 아니라 값 대기다', async () => {
    broker = new MqttTestBroker();
    const port = await broker.listen();
    broker.publish('plant/m1/temp', '21.5', true); // 붙기 전에 보관된 값
    const descriptor = descriptorFor(port);
    reader = await MqttReader.connect(descriptor, { settleMs: 200 });
    broker.publish('plant/m1/status', '{"value":"RUN"}');
    const samples: ValueSample[] = [];
    const sink = { append: async (batch: readonly ValueSample[]) => void samples.push(...batch) };
    const report = await collectOnce(descriptor, reader, sink, { packageId: 'p1' });
    expect(Object.fromEntries(samples.map((s) => [s.propertyName, s.valueNumber ?? s.valueText]))).toEqual({ Temperature: 21.5, Status: 'RUN' });
    expect(report.pending?.map((p) => p.propertyName)).toEqual(['Pressure']);
    expect(report.failures).toEqual([]);

    // 값이 바뀌면 다음 수집이 새 값을 읽는다
    broker.publish('plant/m1/temp', '22');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await reader.read(['plant/m1/temp']))[0]!.value).toBe(22);
  });

  it('사용자 · 암호가 틀리면 브로커가 거절한 사유를 낸다', async () => {
    broker = new MqttTestBroker({ username: 'aas', password: 'secret' });
    const port = await broker.listen();
    await expect(MqttReader.connect(descriptorFor(port, 'aas:wrong@'), { timeoutMs: 1000 })).rejects.toThrow(/거절.*4/);
    reader = await MqttReader.connect(descriptorFor(port, 'aas:secret@'), { settleMs: 50 });
    expect((await reader.read(['plant/m1/temp']))[0]!.pending).toBe(true);
  });
});
