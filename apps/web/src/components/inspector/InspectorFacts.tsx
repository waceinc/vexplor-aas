/**
 * 편집 칸 머리 — 닫기 · 이력 · 다른 파일 표시 · 길 · 제목 · 속성 목록(종류 · valueType · semanticId · 위치 …).
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { Fragment } from 'react';
import { tr } from '../../i18n.js';
import type { TreeNode } from '../../model.js';
import { T } from '../T.js';
import { VALUE_TYPE_HINTS } from './helpers.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  trail?: readonly string[];
  linkedFileName?: string;
  onClose?: () => void;
  onShowHistory?: (node: TreeNode) => void;
  onChangeValueType?: (node: TreeNode, valueType: string) => void;
  t: (text: string) => string;
}

export function InspectorFacts({ node, busy, trail, linkedFileName, onClose, onShowHistory, onChangeValueType, t }: Props): React.JSX.Element {
  const raw = node.node;
  /**
   * 종류마다 볼 것이 다르다. AAS·AssetInformation·ConceptDescription은 값 편집 대상이 아니지만,
   * **화면에서 확인은 되어야 한다** — 지적이 이 자리를 가리키기 때문이다(KOSMO-AAS-*, KOSMO-CD-*).
   */
  const extra: [string, string][] = [];
  if (node.modelType === 'AssetAdministrationShell') {
    extra.push(['id', String(raw['id'] ?? '')]);
    const admin = raw['administration'] as { version?: string; revision?: string } | undefined;
    if (admin) extra.push(['administration', `${admin.version ?? '?'} / ${admin.revision ?? '?'}`]);
  }
  if (node.modelType === 'AssetInformation') {
    extra.push(['assetKind', String(raw['assetKind'] ?? tr('없음'))]);
    extra.push(['globalAssetId', String(raw['globalAssetId'] ?? tr('없음'))]);
    const thumb = raw['defaultThumbnail'] as { path?: string } | undefined;
    extra.push(['defaultThumbnail', thumb?.path ?? tr('없음')]);
  }
  if (node.modelType === 'ConceptDescription') {
    extra.push(['id', String(raw['id'] ?? '')]);
    const spec = (raw['embeddedDataSpecifications'] as { dataSpecificationContent?: Record<string, unknown> }[] | undefined)?.[0];
    const content = spec?.dataSpecificationContent;
    if (content) {
      extra.push(['dataType', String(content['dataType'] ?? tr('없음'))]);
      const definition = content['definition'] as { language: string; text: string }[] | undefined;
      const english = definition?.find((entry) => entry.language === 'en');
      extra.push(['definition (en)', english?.text ?? tr('없음')]);
    }
  }
  if (node.modelType === 'Submodel') {
    extra.push(['id', String(raw['id'] ?? '')]);
    extra.push(['kind', String(raw['kind'] ?? tr('없음'))]);
    // 표준 템플릿을 따르는 서브모델은 여기 IRI로 어느 템플릿·몇 판인지가 드러난다
    const admin = raw['administration'] as { version?: string; revision?: string } | undefined;
    extra.push(['administration', admin ? `${admin.version ?? '?'} / ${admin.revision ?? '?'}` : tr('없음')]);
  }

  return (
    <>
      {onClose && (
        <button className="link inspector-close" onClick={onClose} title={t('선택 해제 (Esc)')}>
          {t('닫기 ✕')}
        </button>
      )}
      {onShowHistory && node.modelType === 'Submodel' && (
        <button
          className="link inspector-history"
          onClick={() => onShowHistory(node)}
          title={t('변경 이력을 보고 실수를 되돌립니다')}
        >
          {t('이력·되돌리기')}
        </button>
      )}
      {linkedFileName && (
        <p className="linked-banner"><T k={'🔗 <b>{0}</b> 파일의 요소입니다 — 저장하면 <b>그 파일이</b> 바뀝니다. 지적(위반)은 그 파일을 열었을 때 보입니다.'} v={[linkedFileName]} /></p>
      )}
      {trail && trail.length > 0 && (
        <div className="trail">
          {trail.map((name, index) => (
            <span key={index}>
              {name}
              {index < trail.length - 1 && <span className="sep"> › </span>}
            </span>
          ))}
        </div>
      )}
      <h2>{node.label}</h2>
      <dl>
        <dt>{t('종류')}</dt>
        <dd>{node.modelType}</dd>
        {raw['valueType'] !== undefined && (
          <>
            <dt>valueType</dt>
            <dd>
              {onChangeValueType && node.idShortPath !== undefined ? (
                // 🔴 추가할 때 안 정하면 xs:string으로 박히는데 바꿀 길이 없었다(실사용 검증).
                //    바꾸면 요소를 통째로 교체한다 — $value 경로로는 타입을 못 바꾼다
                <select
                  aria-label="valueType"
                  value={String(raw['valueType'])}
                  disabled={busy}
                  onChange={(event) => onChangeValueType(node, event.target.value)}
                >
                  {[...new Set(['xs:string', 'xs:boolean', 'xs:int', 'xs:double', 'xs:date',
                    'xs:dateTime', 'xs:anyURI', String(raw['valueType'])])].map((valueType) => (
                    <option key={valueType} value={valueType}>
                      {valueType}
                      {VALUE_TYPE_HINTS[valueType] ? ` — ${t(VALUE_TYPE_HINTS[valueType])}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                String(raw['valueType'])
              )}
            </dd>
          </>
        )}
        {node.idShortPath !== undefined && (
          <>
            <dt>semanticId</dt>
            <dd className="mono">
              {(() => {
                const reference = raw['semanticId'] as { keys?: { value: string }[] } | undefined;
                return reference?.keys?.[0]?.value ?? tr('없음');
              })()}
            </dd>
          </>
        )}
        {node.idShortPath && (
          <>
            <dt>idShortPath</dt>
            <dd className="mono">{node.idShortPath}</dd>
          </>
        )}
        {extra.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd className="mono">{value}</dd>
          </Fragment>
        ))}
        <dt>{t('위치')}</dt>
        <dd className="mono">{node.pointer}</dd>
      </dl>
    </>
  );
}
