/**
 * MQTT 3.1.1 바이트 — 구독해서 받기에 필요한 패킷만(CONNECT · SUBSCRIBE · PUBACK · PINGREQ · DISCONNECT 를 만들고,
 * CONNACK · SUBACK · PUBLISH · PINGRESP 를 읽는다). 클라이언트와 시험 브로커가 함께 쓴다.
 */
import { tr } from '@aas/core';

/** 남은 길이(가변 길이 정수) */
export function encodeLength(length: number): Buffer {
  const bytes: number[] = [];
  let rest = length;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

export function utf8(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export function packet(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), encodeLength(body.length), body]);
}

export interface Packet {
  type: number;
  flags: number;
  body: Buffer;
}

/** 버퍼 앞에서 온전한 패킷을 떼어 낸다 — 덜 왔으면 undefined */
export function takePacket(buffer: Buffer): { packet: Packet; rest: Buffer } | undefined {
  if (buffer.length < 2) return undefined;
  let length = 0;
  let multiplier = 1;
  let index = 1;
  for (;;) {
    if (index >= buffer.length) return undefined;
    const byte = buffer[index]!;
    length += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    index += 1;
    if ((byte & 0x80) === 0) break;
    if (index > 4) throw new Error(tr('잘못된 MQTT 길이'));
  }
  if (buffer.length < index + length) return undefined;
  return {
    packet: { type: buffer[0]! >> 4, flags: buffer[0]! & 0x0f, body: buffer.subarray(index, index + length) },
    rest: buffer.subarray(index + length),
  };
}

/** PUBLISH 본문을 푼다 */
export function readPublish(packet: Packet): { topic: string; payload: Buffer; qos: number; packetId?: number; retain: boolean } {
  const topicLength = packet.body.readUInt16BE(0);
  const topic = packet.body.subarray(2, 2 + topicLength).toString('utf8');
  const qos = (packet.flags >> 1) & 3;
  let offset = 2 + topicLength;
  let packetId: number | undefined;
  if (qos > 0) {
    packetId = packet.body.readUInt16BE(offset);
    offset += 2;
  }
  return { topic, payload: packet.body.subarray(offset), qos, ...(packetId !== undefined ? { packetId } : {}), retain: (packet.flags & 1) === 1 };
}

export function publishPacket(topic: string, payload: Buffer, retain = false): Buffer {
  return packet(0x30 | (retain ? 1 : 0), Buffer.concat([utf8(topic), payload]));
}
