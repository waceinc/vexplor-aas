/**
 * MQTT 3.1.1 bytes — the packets the collector (subscribe and receive), the integration publisher (QoS 0/1 publish with
 * PUBACK, will message) and the test broker need. Shared by all three, so the client and the broker cannot disagree on
 * a bit layout.
 */
import { tr } from '@aas/core';

/** Remaining length (variable-length integer) */
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

/** Takes a complete packet off the front of the buffer — undefined if not fully received yet */
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

/** Decodes a PUBLISH body */
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

export interface PublishOptions {
  qos?: 0 | 1;
  retain?: boolean;
  /** Required for QoS 1 (1..65535) */
  packetId?: number;
  dup?: boolean;
}

/**
 * Builds a PUBLISH. The old positional form `publishPacket(topic, payload, retain)` still works — the collector tests
 * and the test broker used it before QoS 1 existed.
 * Important: QoS 1 without a packet id is a protocol error the broker answers by dropping the connection, so it throws here.
 */
export function publishPacket(topic: string, payload: Buffer, options: boolean | PublishOptions = false): Buffer {
  const { qos = 0, retain = false, packetId, dup = false } = typeof options === 'boolean' ? { retain: options } : options;
  const flags = 0x30 | ((dup ? 1 : 0) << 3) | (qos << 1) | (retain ? 1 : 0);
  if (qos === 0) return packet(flags, Buffer.concat([utf8(topic), payload]));
  if (packetId === undefined || !Number.isInteger(packetId) || packetId < 1 || packetId > 0xffff) {
    throw new Error(tr('QoS 1 메시지에는 1~65535 사이의 패킷 번호가 필요합니다.'));
  }
  return packet(flags, Buffer.concat([utf8(topic), Buffer.from([packetId >> 8, packetId & 0xff]), payload]));
}

/** PUBACK for a QoS 1 PUBLISH */
export function pubackPacket(packetId: number): Buffer {
  return Buffer.from([0x40, 2, packetId >> 8, packetId & 0xff]);
}

/** The packet id a PUBACK acknowledges */
export function readPuback(received: Packet): number {
  if (received.body.length < 2) throw new Error(tr('잘못된 MQTT PUBACK'));
  return received.body.readUInt16BE(0);
}

export interface WillMessage {
  topic: string;
  payload: Buffer;
  retain: boolean;
  qos: 0 | 1;
}

export interface ConnectOptions {
  clientId: string;
  /** Seconds; 0 disables keepalive */
  keepAlive: number;
  username?: string;
  password?: string;
  will?: WillMessage;
  /** Default true — the publisher keeps no session state, so a persistent session would only queue stale messages */
  cleanSession?: boolean;
}

/** CONNECT (MQTT 3.1.1, protocol level 4) */
export function connectPacket(options: ConnectOptions): Buffer {
  const { clientId, keepAlive, username, password, will, cleanSession = true } = options;
  let flags = cleanSession ? 0x02 : 0;
  if (will) flags |= 0x04 | (will.qos << 3) | (will.retain ? 0x20 : 0);
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const header = Buffer.concat([utf8('MQTT'), Buffer.from([4, flags, keepAlive >> 8, keepAlive & 0xff])]);
  const parts = [utf8(clientId)];
  if (will) parts.push(utf8(will.topic), binary(will.payload));
  if (username) parts.push(utf8(username));
  if (password) parts.push(utf8(password));
  return packet(0x10, Buffer.concat([header, ...parts]));
}

export interface ConnectRequest {
  clientId: string;
  keepAlive: number;
  cleanSession: boolean;
  username?: string;
  password?: string;
  will?: WillMessage;
}

/** Decodes a CONNECT body — the test broker needs the credentials and the will */
export function readConnect(body: Buffer): ConnectRequest {
  const nameLength = body.readUInt16BE(0);
  const flags = body[2 + nameLength + 1]!;
  const keepAlive = body.readUInt16BE(2 + nameLength + 2);
  let offset = 2 + nameLength + 4;
  const field = (): Buffer => {
    const length = body.readUInt16BE(offset);
    const value = body.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return value;
  };
  const clientId = field().toString('utf8');
  const request: ConnectRequest = { clientId, keepAlive, cleanSession: (flags & 0x02) !== 0 };
  if (flags & 0x04) {
    const topic = field().toString('utf8');
    const payload = Buffer.from(field());
    request.will = { topic, payload, retain: (flags & 0x20) !== 0, qos: ((flags >> 3) & 1) as 0 | 1 };
  }
  if (flags & 0x80) request.username = field().toString('utf8');
  if (flags & 0x40) request.password = field().toString('utf8');
  return request;
}

/** Two-byte length prefixed bytes (will payload, password in the binary form) */
function binary(bytes: Buffer): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(bytes.length, 0);
  return Buffer.concat([head, bytes]);
}

/**
 * Whether a topic filter (`plant/+/temp`, `plant/#`) matches a topic name. MQTT 3.1.1 §4.7: `+` is one level, `#` the
 * rest including the parent level itself; topics starting with `$` are not matched by a leading wildcard.
 */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  if (topic.startsWith('$') && (filter.startsWith('+') || filter.startsWith('#'))) return false;
  const want = filter.split('/');
  const have = topic.split('/');
  for (let i = 0; i < want.length; i++) {
    const level = want[i]!;
    if (level === '#') return i === want.length - 1;
    if (i >= have.length) return false;
    if (level !== '+' && level !== have[i]) return false;
  }
  return want.length === have.length;
}
