/**
 * The collection pane says "receiving" when fresh values arrive without this server reading them — a remote collector
 * (VEXPLOR Edge) sends them (2.7.0). Before, it said "not collected yet" while values were coming in.
 */
import { describe, expect, it } from 'vitest';
import { connectionStatus, latestValues } from '../src/components/collection/status.js';

const now = Date.parse('2026-10-18T01:00:00.000Z');
const value = (receivedAt: string) => ({ interfaceName: 'OPCUA', propertyName: 'MotorSpeed', observedAt: receivedAt, receivedAt, valueNumber: 1 });

describe('connectionStatus with values from a remote collector', () => {
  it('fresh values → receiving', () => {
    const latest = latestValues([value('2026-10-18T00:59:00.000Z')]);
    expect(connectionStatus('OPCUA', undefined, undefined, 'pkg_1', latest, now)).toEqual({ kind: 'ok', label: '받는 중' });
  });

  it('old values or values of another interface → not collected yet', () => {
    expect(connectionStatus('OPCUA', undefined, undefined, 'pkg_1', latestValues([value('2026-10-18T00:30:00.000Z')]), now).kind).toBe('idle');
    const other = latestValues([{ ...value('2026-10-18T00:59:00.000Z'), interfaceName: 'Modbus' }]);
    expect(connectionStatus('OPCUA', undefined, undefined, 'pkg_1', other, now).kind).toBe('idle');
  });
});
