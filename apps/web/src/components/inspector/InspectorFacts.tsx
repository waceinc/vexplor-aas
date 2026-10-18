/**
 * Edit pane header — close · history · other-file marker · path · title · property list (kind · valueType · semanticId · location …).
 * Extracted from components/Inspector.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
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
   * What to show differs by kind. AAS · AssetInformation · ConceptDescription are not value-edit targets,
   * but **they must be checkable on screen** — findings point here (KOSMO-AAS-*, KOSMO-CD-*).
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
    // For submodels following a standard template, this IRI reveals which template and which version
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
        <p className="linked-banner"><T k={'<b>{0}</b> 파일의 요소입니다 — 저장하면 <b>그 파일이</b> 바뀝니다. 지적(위반)은 그 파일을 열었을 때 보입니다.'} v={[linkedFileName]} /></p>
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
                // Important: if not chosen on add, it was locked to xs:string with no way to change it (real-use validation).
                //    Changing it replaces the whole element — the type cannot be changed through the $value path
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
