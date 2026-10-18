// @vitest-environment jsdom
/**
 * A failed read keeps its reason on screen after a reload (2.8.0). The remote collector and the server's own automatic
 * collection store the reason with the value row; before, Modbus and MQTT rows showed only an empty value because they
 * have no quality code to fall back on.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InterfaceCard } from '../src/components/collection/InterfaceCard.js';
import { connectionStatus, latestValues } from '../src/components/collection/status.js';

const now = Date.parse('2026-10-18T01:00:00.000Z');
const at = '2026-10-18T00:59:50.000Z';
const failed = { interfaceName: 'Modbus', propertyName: 'Pressure', observedAt: at, receivedAt: at, error: 'Modbus exception 2 (illegal data address)' };
const good = { interfaceName: 'Modbus', propertyName: 'Counter', observedAt: at, receivedAt: at, valueNumber: 7 };
const descriptor = {
  name: 'Modbus',
  protocol: 'MODBUS',
  base: 'modbus+tcp://10.0.0.5:502/1',
  properties: [
    { name: 'Pressure', href: '40', observable: true },
    { name: 'Counter', href: '41', observable: true },
  ],
};

describe('a stored read failure', () => {
  it('shows "Read failed — reason" on its row, like a failure of the collection just run', () => {
    render(
      <InterfaceCard
        descriptor={descriptor}
        status={{ kind: 'ok', label: '받는 중' }}
        latest={latestValues([failed, good])}
        waitingTags={new Set()}
        failedTags={new Map()}
        nowMs={now}
        windowMs={300_000}
      />,
    );
    expect(screen.getByText(/읽기 실패/).textContent).toContain('Modbus');
    expect(screen.getByTitle('Modbus exception 2 (illegal data address)')).toBeTruthy();
    expect(screen.queryByText('(빈 값)')).toBeNull();
    // A failed row is not a value received — the header does not count it as receiving
    expect(screen.getByText('받는 중 1')).toBeTruthy();
  });

  it('a remote collector that sends only failures is connected but has bad tags — not plain "receiving"', () => {
    const status = connectionStatus('Modbus', undefined, undefined, 'pkg_1', latestValues([failed]), now);
    expect(status.kind).toBe('warn');
    expect(status.label).toBe('받는 중 · 나쁜 태그 1');
    expect(connectionStatus('Modbus', undefined, undefined, 'pkg_1', latestValues([failed, good]), now)).toEqual({ kind: 'warn', label: '받는 중 · 나쁜 태그 1' });
    expect(connectionStatus('Modbus', undefined, undefined, 'pkg_1', latestValues([good]), now)).toEqual({ kind: 'ok', label: '받는 중' });
  });
});
