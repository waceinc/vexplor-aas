/**
 * 값 한꺼번에 입력 — 서브모델을 고르면 안의 값(Property · MLP · Range)을 표로 입력하고 한 번에 저장한다.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 * 입력 중인 값은 이 부품의 상태다. 다른 요소로 옮기거나 저장으로 내용이 바뀌면 Inspector 가 key 를 바꿔
 * 새로 그리므로 처음 값으로 돌아간다(예전 「지문이 바뀌면 초기화」 효과와 같은 결과).
 */
import { useState } from 'react';
import { fill, tr } from '../../i18n.js';
import type { TreeNode } from '../../model.js';
import { T } from '../T.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  onBulkSaveValues: (node: TreeNode, content: Record<string, unknown>) => void;
  t: (text: string) => string;
}

export function BulkValues({ node, busy, onBulkSaveValues, t }: Props): React.JSX.Element | null {
  /** 값 표의 편집분 — idShortPath → 새 값. 저장 때 서브모델 JSON에 한꺼번에 얹는다 */
  const [bulk, setBulk] = useState<Record<string, string>>({});
  // 잎 값들을 모은다 — Property(글), MLP(첫 언어), Range(min~max)
  const rows: { path: string; label: string; kind: string; current: string }[] = [];
  const collect = (children: readonly TreeNode[], prefix: string): void => {
    for (const child of children) {
      const label = prefix ? `${prefix} › ${child.label}` : child.label;
      const rawChild = child.node as Record<string, unknown>;
      if (child.modelType === 'Property' && child.idShortPath) {
        rows.push({
          path: child.idShortPath,
          label,
          kind: 'Property',
          current: String(rawChild['value'] ?? ''),
        });
      } else if (child.modelType === 'MultiLanguageProperty' && child.idShortPath) {
        const list = (rawChild['value'] as { language: string; text: string }[]) ?? [];
        rows.push({
          path: child.idShortPath,
          label: `${label} (${list[0]?.language ?? 'ko'})`,
          kind: 'MLP',
          current: list[0]?.text ?? '',
        });
      } else if (child.modelType === 'Range' && child.idShortPath) {
        rows.push({
          path: child.idShortPath,
          label: `${label} (min~max)`,
          kind: 'Range',
          current: `${String(rawChild['min'] ?? '')}~${String(rawChild['max'] ?? '')}`,
        });
      }
      collect(child.children, label);
    }
  };
  collect(node.children, '');
  if (rows.length === 0) return null;
  const dirty = Object.keys(bulk).length;
  return (
    <div className="bulk-values">
      <p className="pick-title"><T k={'값 한꺼번에 입력 ({0}개)'} v={[rows.length]} /></p>
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path}>
              <td className="bulk-label" title={row.path}>{row.label}</td>
              <td>
                <input
                  value={bulk[row.path] ?? row.current}
                  placeholder={row.kind === 'Range' ? t('예: -10~60') : ''}
                  onChange={(event) =>
                    setBulk((current) => ({ ...current, [row.path]: event.target.value }))
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="primary"
        disabled={busy || dirty === 0}
        title={t('표에서 고친 값을 한 번에 반영합니다 — 요소마다 누르지 않아도 됩니다')}
        onClick={() => {
          // 서브모델 JSON을 복제해 바뀐 값만 얹는다 — 한 번의 PATCH로 저장된다
          const content = JSON.parse(JSON.stringify(node.node)) as Record<string, unknown>;
          const apply = (holder: Record<string, unknown>, path: string, value: string): void => {
            const segments = path.split('.');
            let cursor: Record<string, unknown> | undefined = holder;
            for (let index = 0; index < segments.length; index += 1) {
              const list = (cursor?.['submodelElements'] ?? cursor?.['value'] ??
                cursor?.['statements']) as Record<string, unknown>[] | undefined;
              cursor = list?.find((element) => element['idShort'] === segments[index]);
              if (!cursor) return;
            }
            if (cursor['modelType'] === 'MultiLanguageProperty') {
              const list = (cursor['value'] as { language: string; text: string }[]) ?? [];
              if (list.length > 0) list[0]!.text = value;
              else cursor['value'] = [{ language: 'ko', text: value }];
            } else if (cursor['modelType'] === 'Range') {
              const [min, max] = value.split('~');
              cursor['min'] = (min ?? '').trim();
              cursor['max'] = (max ?? '').trim();
            } else {
              cursor['value'] = value;
            }
          };
          for (const [path, value] of Object.entries(bulk)) apply(content, path, value);
          onBulkSaveValues(node, content);
          setBulk({});
        }}
      >
        {dirty > 0 ? fill(tr('바뀐 {0}개 저장'), { 0: dirty }) : tr('저장')}
      </button>
    </div>
  );
}
