// @vitest-environment jsdom
/**
 * 편집기(Inspector)가 **언제 입력을 버리는가**.
 *
 * 🔴 이 파일이 지키는 것은 규칙 하나다: **내용이 달라졌을 때만 버린다.**
 *    화면이 트리를 다시 만들기만 해도 버리면, 사람이 타자 치는 중에 배경 응답 하나만
 *    늦게 와도 값이 사라진다. 트리는 `shells·submodels·concepts·hierarchy·linked` 중
 *    하나만 바뀌어도 통째로 새로 만들어지고, 그것들은 파일을 열 때 여러 번에 나눠
 *    들어온다 — 즉 **흔한 일**이다(2026-10-02, 테스트가 간헐적으로 떨어져 잡았다).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Inspector } from '../src/components/Inspector.js';
import type { TreeNode } from '../src/model.js';

afterEach(cleanup);

/** 값 하나짜리 Property 노드. `value`를 주면 그 값으로 만든다 */
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

describe('편집기는 내용이 달라졌을 때만 입력을 버린다', () => {
  it('🔴 트리만 다시 만들어진 경우 — 입력하던 값을 지키다', () => {
    const { rerender } = render(<Inspector {...common} node={propertyNode()} />);

    const input = screen.getByLabelText('값') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '사람이-치던-값' } });
    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('사람이-치던-값');

    // 내용은 똑같고 **객체만 새로** — 트리를 다시 만들었을 때 일어나는 일 그대로다
    rerender(<Inspector {...common} node={propertyNode()} />);

    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('사람이-치던-값');
  });

  it('내용이 실제로 바뀌면 새 내용을 보인다 — 저장·되돌리기·이력 복원', () => {
    const { rerender } = render(<Inspector {...common} node={propertyNode()} />);

    fireEvent.change(screen.getByLabelText('값'), { target: { value: '치던-값' } });
    // 서버에서 다른 값이 돌아왔다(되돌리기 등) — 이때는 보여 주는 것이 맞다
    rerender(<Inspector {...common} node={propertyNode('되돌린-값')} />);

    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('되돌린-값');
  });

  it('다른 요소를 고르면 버린다 — 남의 값이 남아 있으면 안 된다', () => {
    const { rerender } = render(<Inspector {...common} node={propertyNode()} />);
    fireEvent.change(screen.getByLabelText('값'), { target: { value: '치던-값' } });

    // 🔴 내용이 **우연히 같은** 다른 요소라도 버려야 한다 — 그래서 지문에 pointer가 들어간다
    const other = propertyNode();
    (other as { pointer: string }).pointer = '/submodels/0/submodelElements/9';
    rerender(<Inspector {...common} node={other} />);

    expect((screen.getByLabelText('값') as HTMLInputElement).value).toBe('EXM-RFL-2026-00127');
  });
});
