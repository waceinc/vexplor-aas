/**
 * Modbus 수집 어댑터 — AID 인터페이스 하나를 받아 수집기(@aas/collector)의 ProtocolReader 로 읽는다.
 * 속성마다 주소·자료형을 modbus-target.ts 로 풀고, 장치(호스트:포트)마다 연결 하나를 열어 둔다.
 * 읽지 못한 항목은 사유와 함께 돌려준다 — 한 항목이 실패해도 나머지는 읽는다.
 */
import type { AidInterface, ProtocolReader, ReadResult } from '@aas/collector';
import { ModbusTcpClient } from './modbus-client.js';
import { decodeRegisters, modbusTarget } from './modbus-target.js';

export interface ModbusReaderOptions {
  timeoutMs?: number;
  /** 붙기 전에 주소를 본다(체험판 SSRF 차단 등). 막을 때는 던진다 */
  guard?: (url: string) => void;
}

export class ModbusReader implements ProtocolReader {
  private readonly clients = new Map<string, Promise<ModbusTcpClient>>();

  private constructor(
    private readonly descriptor: AidInterface,
    private readonly options: ModbusReaderOptions,
  ) {}

  get base(): string {
    return this.descriptor.base ?? '';
  }

  static async connect(descriptor: AidInterface, options: ModbusReaderOptions = {}): Promise<ModbusReader> {
    return new ModbusReader(descriptor, options);
  }

  async read(sources: readonly string[]): Promise<ReadResult[]> {
    const results: ReadResult[] = [];
    for (const source of sources) {
      const property = this.descriptor.properties.find((item) => item.href === source);
      try {
        const target = modbusTarget(this.descriptor.base, source, property?.formFields ?? {});
        const client = await this.client(target.host, target.port);
        const raw = await client.read(target.unitId, target.entity, target.address, target.quantity);
        const bits = target.entity === 'Coil' || target.entity === 'DiscreteInput';
        const value = bits ? (raw.length === 1 ? raw[0] === 1 : raw.join('')) : decodeRegisters(raw, target);
        results.push({ source, value, quality: 'Good' });
      } catch (error) {
        results.push({ source, value: undefined, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map(async (pending) => (await pending.catch(() => undefined))?.close()));
  }

  private client(host: string, port: number): Promise<ModbusTcpClient> {
    const key = `${host}:${port}`;
    let client = this.clients.get(key);
    if (!client) {
      this.options.guard?.(`modbus+tcp://${host}:${port}`);
      client = ModbusTcpClient.connect(host, port, this.options.timeoutMs);
      // 붙지 못했으면 다음 읽기에서 다시 시도하게 지운다
      client.catch(() => this.clients.delete(key));
      this.clients.set(key, client);
    }
    return client;
  }
}
