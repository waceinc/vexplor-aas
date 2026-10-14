// @vitest-environment jsdom
/**
 * **When** the editor (Inspector) discards input.
 *
 * Important: this file guards a single rule: **discard only when the content changed.**
 *    If it discarded whenever the screen merely rebuilt the tree, a single late background response
 *    while someone is typing would wipe the value. The tree is rebuilt wholesale when any one of
 *    `shells·submodels·concepts·hierarchy·linked` changes, and those arrive in several steps
 *    when a file opens, so this is **common** (2026-10-02, caught by an intermittently failing test).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Inspector } from '../src/components/Inspector.js';
import type { TreeNode } from '../src/model.js';

afterEach(cleanup);

/** Single-value Property node. When `value` is given, built with that value */
function propertyNode(value = 'EXM-RFL-2026-00127'): TreeNode {
  return {
    key: 'k',
    label: 'SerialNumber',
    modelType: 'Property',
    pointer: '/submodels/0/submodelElements/5',
    idShortPath: 'SerialNumber',
    submodelId: 'urn:x:nameplate',
    depth: 1,
    children: [],
    node: { modelType: 'Property', idShort: 'SerialNumber', valueType: 'xs:string', value },
  } as unknown as TreeNode;
}

const common = {
  busy: false,
  onSave: () => undefined,
  t: (text: string) => text,
};

describe('the editor discards input only when the content changed', () => {
  it('Important: tree merely rebuilt keeps the value being typed', () => {
    const { rerender } = render(<Inspector {...common} node={propertyNode()} />);

    const input = screen.getByLabelText('값') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '사람이-치던-값' } });
    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('사람이-치던-값');

    // same content, **new object only**: exactly what happens when the tree is rebuilt
    rerender(<Inspector {...common} node={propertyNode()} />);

    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('사람이-치던-값');
  });

  it('shows new content when it really changes (save, revert, history restore)', () => {
    const { rerender } = render(<Inspector {...common} node={propertyNode()} />);

    fireEvent.change(screen.getByLabelText('값'), { target: { value: '치던-값' } });
    // the server returned a different value (revert etc.): showing it is correct here
    rerender(<Inspector {...common} node={propertyNode('되돌린-값')} />);

    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('되돌린-값');
  });

  it('discards when another element is selected (a value from another element must not linger)', () => {
    const { rerender } = render(<Inspector {...common} node={propertyNode()} />);
    fireEvent.change(screen.getByLabelText('값'), { target: { value: '치던-값' } });

    // Important: discard even for a different element whose content **happens to match**, which is why the fingerprint includes pointer
    const other = propertyNode();
    (other as { pointer: string }).pointer = '/submodels/0/submodelElements/9';
    rerender(<Inspector {...common} node={other} />);

    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('EXM-RFL-2026-00127');
  });
});
