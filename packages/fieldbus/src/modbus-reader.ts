/**
 * Modbus collection adapter — takes one AID interface and reads it as the collector's (@aas/collector) ProtocolReader.
 * Resolves each property's address and data type via modbus-target.ts, and keeps one connection open per device (host:port).
 * Items that cannot be read are returned with a reason — one failing item does not stop the rest from being read.
 */
import type { AidInterface, ProtocolReader, ReadResult } from '@aas/collector';
import { ModbusTcpClient } from './modbus-client.js';
import { decodeRegisters, modbusTarget } from './modbus-target.js';

export interface ModbusReaderOptions {
  timeoutMs?: number;
  /** Inspects the address before connecting (e.g. SSRF blocking in the trial edition). Throws to block */
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
      // If the connection failed, drop it so the next read retries
      client.catch(() => this.clients.delete(key));
      this.clients.set(key, client);
    }
    return client;
  }
}
