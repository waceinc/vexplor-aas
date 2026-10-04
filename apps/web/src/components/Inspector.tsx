/**
 * 속성 편집.
 *
 * 값 수정은 Part 2의 `$value` PATCH 한 길로만 나간다.
 * A안(파일이 원본)에서 이 편집은 곧 파일에 남는 편집이다 — 되돌릴 수 없는 실수가 되지 않도록
 * 저장 전까지는 화면 상태만 바꾸고, 저장 결과는 서버에서 다시 읽어 확인한다.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Policy } from '../api.js';
import type { TreeNode } from '../model.js';
import { checkSemanticId, EDITABLE_VALUE_TYPES } from '../model.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

interface Props {
  node?: TreeNode;
  /**
   * 선택 해제 — 편집기를 닫고 요약·「무엇으로 이루어졌나」·수집 화면으로 돌아간다.
   * 🔴 이게 없어서 트리를 한 번 고르면 설비 추가 화면으로 **돌아올 방법이 없었다**(실측).
   */
  onClose?: () => void;
  /** 이 요소까지의 길(상위 이름들) — "어디의 요소인지"가 제목만으로는 안 보인다 */
  trail?: readonly string[];
  busy: boolean;
  onSave: (node: TreeNode, value: unknown) => void;
  /** 이 노드 아래에 요소를 만들 수 있으면 준다 */
  onAddChild?: (node: TreeNode) => void;
  /** 이름(idShort) 바꾸기. 리스트 자식은 주지 않는다 */
  onRename?: (node: TreeNode, name: string) => void;
  /** File·Blob 요소에 실제 파일을 붙인다 (매뉴얼 PDF·도면) */
  onUploadAttachment?: (node: TreeNode, file: File) => void;
  onDownloadAttachment?: (node: TreeNode, filename: string) => void;
  onDeleteAttachment?: (node: TreeNode) => void;
  onDelete?: (node: TreeNode) => void;
  /** 바로 아래에 사본 — 같은 구조를 여러 벌 채울 때 */
  onDuplicate?: (node: TreeNode) => void;
  /** valueType처럼 $value로는 못 바꾸는 속성을 고친다 — 요소 통째 교체 */
  onChangeValueType?: (node: TreeNode, valueType: string) => void;
  /** 서브모델 변경 이력을 연다 — 실수를 되돌리는 길 */
  onShowHistory?: (node: TreeNode) => void;
  /**
   * 값 한꺼번에 저장 — 서브모델을 고르면 안의 값(Property·MLP·Range)을 표로 입력한다.
   * 요소를 하나씩 눌러 40번 저장하는 것은 사람이 할 일이 아니다(초보자 여정 후속 제안).
   * 한 번의 PATCH로 저장한다 — 줄마다 쓰면 revision이 어긋나 두 번째부터 409가 난다.
   */
  onBulkSaveValues?: (node: TreeNode, content: Record<string, unknown>) => void;
  /** 이 요소가 다른 파일의 것이면 그 파일 이름 — 어디를 고치는 중인지 알려야 한다 */
  linkedFileName?: string;
  /** semanticId 검사에 쓴다 (M4 축소판) */
  policy?: Policy;
  conceptIds?: ReadonlySet<string>;
  onSaveSemanticId?: (node: TreeNode, semanticId: string) => void;
  /** AssetInformation 저장 — assetKind·globalAssetId */
  onSaveAssetInformation?: (info: Record<string, unknown>) => void;
  /** 용어(CD) 정의 저장 — 통째로 바뀐 CD를 넘긴다 */
  onSaveConcept?: (concept: Record<string, unknown>) => void;
  /**
   * 대표 사진 올리기 — 뼈대의 임시 그림을 실제 장비 사진으로 바꾸는 자리.
   * 🔴 안내문은 "AssetInformation에서 바꿀 수 있다"고 해 왔는데 정작 올리는 단추가
   *    없었다(초보자 여정 실측, 2026-08-26). 서버 API는 처음부터 있었다.
   */
  onUploadThumbnail?: (file: File) => void;
  /** 번역기 — 사전에 없으면 한국어 그대로 (i18n.ts) */
  t: (text: string) => string;
}

interface LangText {
  language: string;
  text: string;
}

/**
 * 이름을 바꿀 수 있는 자리인가.
 * Submodel과 일반 요소는 되고, **리스트 자식은 안 된다**(순서로 가리키는 자리다).
 * AAS·AssetInformation·ConceptDescription은 이 화면의 편집 대상이 아니다.
 */
function renameable(node: TreeNode): boolean {
  if (node.modelType === 'Submodel') return true;
  if (node.idShortPath === undefined) return false;
  const last = node.idShortPath.split('.').at(-1) ?? '';
  return !last.endsWith(']');
}

/** File.value(`file:///aasx/suppl/매뉴얼.pdf`)에서 사람이 읽을 파일명만 꺼낸다 */
function attachedName(raw: Record<string, unknown>): string | undefined {
  const value = typeof raw['value'] === 'string' ? (raw['value'] as string) : undefined;
  if (!value) return undefined;
  const path = value.replace(/^file:\/\//i, '');
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name || path;
}

/** IEC 61360 dataType — 규격 열거값 중 산출물에서 쓰인 것들 */
const IEC61360_DATA_TYPES = [
  'STRING',
  'STRING_TRANSLATABLE',
  'INTEGER_MEASURE',
  'INTEGER_COUNT',
  'INTEGER_CURRENCY',
  'REAL_MEASURE',
  'REAL_COUNT',
  'REAL_CURRENCY',
  'BOOLEAN',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'IRI',
  'IRDI',
  'RATIONAL',
  'RATIONAL_MEASURE',
  'FILE',
  'BLOB',
  'HTML',
] as const;

interface ConceptForm {
  preferredNameEn: string;
  definitionEn: string;
  definitionKo: string;
  dataType: string;
  unit: string;
}
const EMPTY_CONCEPT: ConceptForm = { preferredNameEn: '', definitionEn: '', definitionKo: '', dataType: '', unit: '' };

const IEC61360_SPEC = 'http://admin-shell.io/DataSpecificationTemplates/DataSpecificationIEC61360/3/0';

function iec61360Content(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const specs = raw['embeddedDataSpecifications'] as
    | { dataSpecificationContent?: Record<string, unknown> }[]
    | undefined;
  return specs?.[0]?.dataSpecificationContent;
}

function langText(list: unknown, language: string): string {
  if (!Array.isArray(list)) return '';
  const hit = (list as { language?: string; text?: string }[]).find((e) => e.language === language);
  return hit?.text ?? '';
}

function readConcept(raw: Record<string, unknown>): ConceptForm {
  const content = iec61360Content(raw);
  if (!content) return EMPTY_CONCEPT;
  return {
    preferredNameEn: langText(content['preferredName'], 'en'),
    definitionEn: langText(content['definition'], 'en'),
    definitionKo: langText(content['definition'], 'ko'),
    dataType: String(content['dataType'] ?? ''),
    unit: String(content['unit'] ?? ''),
  };
}

/** 폼 값을 CD에 되쓴다. 손대지 않은 언어·필드는 그대로 두고, 빈 값은 키를 지운다(빈 문자열을 남기지 않는다) */
function writeConcept(raw: Record<string, unknown>, form: ConceptForm): Record<string, unknown> {
  const next = structuredClone(raw) as Record<string, unknown>;
  let specs = next['embeddedDataSpecifications'] as
    | { dataSpecification?: unknown; dataSpecificationContent?: Record<string, unknown> }[]
    | undefined;
  if (!Array.isArray(specs) || specs.length === 0) {
    specs = [
      {
        dataSpecification: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: IEC61360_SPEC }] },
        dataSpecificationContent: { modelType: 'DataSpecificationIec61360' },
      },
    ];
    next['embeddedDataSpecifications'] = specs;
  }
  const content = (specs[0]!.dataSpecificationContent ??= { modelType: 'DataSpecificationIec61360' });
  const setLang = (key: string, language: string, text: string): void => {
    const list = (Array.isArray(content[key]) ? content[key] : []) as { language: string; text: string }[];
    const rest = list.filter((e) => e.language !== language);
    const trimmed = text.trim();
    const merged = trimmed === '' ? rest : [...rest, { language, text: trimmed }];
    // en을 앞에 — 표준 도구·문서 자료가 첫 항목을 대표로 읽는다
    merged.sort((a, b) => (a.language === 'en' ? -1 : b.language === 'en' ? 1 : 0));
    if (merged.length === 0) delete content[key];
    else content[key] = merged;
  };
  setLang('preferredName', 'en', form.preferredNameEn);
  setLang('definition', 'en', form.definitionEn);
  setLang('definition', 'ko', form.definitionKo);
  if (form.dataType === '') delete content['dataType'];
  else content['dataType'] = form.dataType;
  if (form.unit.trim() === '') delete content['unit'];
  else content['unit'] = form.unit.trim();
  return next;
}

/** 추가 폼과 같은 말 — 두 화면이 다른 설명을 하면 안 된다 */
const VALUE_TYPE_HINTS: Record<string, string> = {
  'xs:string': tr('글자'),
  'xs:boolean': tr('참/거짓'),
  'xs:int': tr('정수'),
  'xs:double': tr('소수'),
  'xs:date': tr('날짜'),
  'xs:dateTime': tr('날짜+시각'),
  'xs:anyURI': tr('주소 (URL·IRI)'),
};

export function Inspector({
  node,
  onClose,
  onChangeValueType,
  onShowHistory,
  onBulkSaveValues,
  linkedFileName,
  onUploadThumbnail,
  trail,
  busy,
  onSave,
  onAddChild,
  onDelete,
  onDuplicate,
  policy,
  conceptIds,
  onSaveSemanticId,
  onSaveAssetInformation,
  onSaveConcept,
  onRename,
  onUploadAttachment,
  onDownloadAttachment,
  onDeleteAttachment,
  t,
}: Props): React.JSX.Element {
  const [text, setText] = useState('');
  const [langs, setLangs] = useState<LangText[]>([]);
  const [range, setRange] = useState<{ min: string; max: string }>({ min: '', max: '' });
  const [semantic, setSemantic] = useState('');
  const [name, setName] = useState('');
  /** 값 표의 편집분 — idShortPath → 새 값. 저장 때 서브모델 JSON에 한꺼번에 얹는다 */
  const [bulk, setBulk] = useState<Record<string, string>>({});
  const [asset, setAsset] = useState<{ assetKind: string; globalAssetId: string }>({
    assetKind: '',
    globalAssetId: '',
  });
  const [concept, setConcept] = useState<ConceptForm>(EMPTY_CONCEPT);

  /**
   * 「지금 무엇을 보고 있나」의 **지문**.
   *
   * 🔴 아래 초기화를 `[node]`(객체 동일성)에 걸어 두었더니, 화면이 트리를 **다시 만들기만 해도**
   *    입력하던 값이 지워졌다. 트리는 `shells·submodels·concepts·hierarchy·linked` 중 하나만
   *    바뀌어도 통째로 새로 만들어지고, 그것들은 파일을 열 때 **여러 번에 나눠** 들어온다.
   *    사람이 그 사이에 타자를 치고 있으면 그대로 날아간다 — 테스트가 부하에서 간헐적으로
   *    떨어지던 것이 이 현상이었다(2026-10-02에 원인을 잡았다).
   *
   * 그래서 **내용이 실제로 달라졌을 때만** 초기화한다. 저장·되돌리기·이력 복원은 내용이
   * 바뀌므로 그대로 초기화되고, 트리만 새로 만들어진 경우는 건드리지 않는다.
   * 지문 계산은 객체가 바뀔 때만 한다 — 매 렌더 직렬화하면 그것대로 낭비다.
   */
  const signature = useMemo(
    () => `${node?.pointer ?? ''} :: ${JSON.stringify(node?.node ?? null)}`,
    [node],
  );

  useEffect(() => {
    if (!node) return;
    const raw = node.node;
    setText(typeof raw.value === 'string' ? raw.value : '');
    setLangs(Array.isArray(raw.value) ? (raw.value as LangText[]) : []);
    setRange({ min: String(raw['min'] ?? ''), max: String(raw['max'] ?? '') });
    const reference = raw['semanticId'] as { keys?: { value: string }[] } | undefined;
    setSemantic(reference?.keys?.[0]?.value ?? '');
    setName(String(raw['idShort'] ?? ''));
    setBulk({}); // 다른 노드로 옮기면 표 편집분은 버린다 — 저장 전 값이라 잃는 것이 없다
    setAsset({
      assetKind: String(raw['assetKind'] ?? 'Type'),
      globalAssetId: String(raw['globalAssetId'] ?? ''),
    });
    setConcept(readConcept(raw));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 지문이 곧 node의 내용이다(위 설명)
  }, [signature]);

  if (!node) return <div className="inspector empty" />;

  const raw = node.node;
  const editable = node.idShortPath !== undefined && EDITABLE_VALUE_TYPES.has(node.modelType);

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
    <div className="inspector">
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

      {editable && node.modelType === 'MultiLanguageProperty' && (
        <div className="editor">
          {langs.map((entry, index) => (
            <div className="lang-row" key={index}>
              <input
                value={entry.language}
                aria-label={t('언어')}
                onChange={(event) =>
                  setLangs(langs.map((l, i) => (i === index ? { ...l, language: event.target.value } : l)))
                }
              />
              <input
                value={entry.text}
                aria-label={t('내용')}
                onChange={(event) =>
                  setLangs(langs.map((l, i) => (i === index ? { ...l, text: event.target.value } : l)))
                }
              />
              {/* 언어를 뺄 길이 없어 빈 줄을 저장하던 사례 — 빈 text는 PKG-LANG 규칙에 걸린다 */}
              <button
                className="link"
                title={t('이 언어 줄을 뺍니다')}
                aria-label={fill(tr('{0} 줄 빼기'), { 0: entry.language || tr('언어') })}
                onClick={() => setLangs(langs.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            title={t('언어 줄을 하나 더 만듭니다 — 같은 뜻을 ko·en으로 나란히 적습니다')}
            onClick={() => setLangs([...langs, { language: 'ko', text: '' }])}
          >
            {t('언어 추가')}
          </button>
          <button
            className="primary"
            disabled={busy}
            title={t('이 요소의 언어별 글을 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶')}
            onClick={() => onSave(node, langs)}
          >
            {t('저장')}
          </button>
        </div>
      )}

      {editable && node.modelType === 'Range' && (
        <div className="editor">
          <input
            value={range.min}
            aria-label={t('최소')}
            onChange={(event) => setRange({ ...range, min: event.target.value })}
          />
          <input
            value={range.max}
            aria-label={t('최대')}
            onChange={(event) => setRange({ ...range, max: event.target.value })}
          />
          <button
            className="primary"
            disabled={busy}
            title={t('최소·최대를 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶')}
            onClick={() => onSave(node, range)}
          >
            {t('저장')}
          </button>
        </div>
      )}

      {editable && !['MultiLanguageProperty', 'Range'].includes(node.modelType) && (
        <div className="editor">
          <textarea
            value={text}
            aria-label={t('값')}
            rows={3}
            onChange={(event) => setText(event.target.value)}
          />
          <button
            className="primary"
            disabled={busy}
            title={t('이 요소의 값을 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶')}
            onClick={() => onSave(node, text)}
          >
            {t('저장')}
          </button>
        </div>
      )}

      {/* AssetInformation은 아래에 편집칸이 있으므로 "편집 대상이 아니다"라고 하면 안 된다 */}
      {!editable &&
        node.modelType !== 'ConceptDescriptionGroup' &&
        node.modelType !== 'AssetInformation' && (
          <p className="hint">
            {node.modelType === 'ConceptDescription' ? (
              <>
                <T k={'<b>용어 정의</b>입니다 — 서브모델 요소가 쓰는 이름의 뜻풀이이고, 요소의 {0}가 여기를 가리킵니다. 표준 사전(ECLASS·IEC CDD)에서 온 것은 그대로 두고, 도구가 만든 것은 아래에서 뜻풀이를 채우십시오 — 문서용 자료의 「정의」 열에 그대로 실립니다.'} v={[<span className="mono">semanticId</span>]} /></>
            ) : (
              <><T k={'여기서는 <b>{0}</b>의 내용을 확인합니다. 값은 아래 요소(Property 등)에 있습니다 — 트리에서 펼쳐 고르십시오.'} v={[node.modelType]} /></>
            )}
          </p>
        )}

      {node.modelType === 'Submodel' && onBulkSaveValues && (
        (() => {
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
        })()
      )}

      {node.modelType === 'AssetInformation' && onSaveAssetInformation && (
        <div className="editor">
          {/* KOSMO-AAS-6은 Type을, AAS-5는 globalAssetId를 요구한다. 「자동 고치기」 말고 직접 고칠 길 */}
          <label className="stack">
            assetKind
            <select
              value={asset.assetKind}
              aria-label="assetKind"
              onChange={(event) => setAsset({ ...asset, assetKind: event.target.value })}
            >
              {['Type', 'Instance', 'NotApplicable'].map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          {asset.assetKind !== 'Type' && (
            <p className="note warning">{t('본 사업 산출물은 형식(Type) 단위입니다(KOSMO-AAS-6).')}</p>
          )}
          <label className="stack">
            globalAssetId
            <input
              value={asset.globalAssetId}
              aria-label="globalAssetId"
              className="mono"
              onChange={(event) => setAsset({ ...asset, globalAssetId: event.target.value })}
            />
          </label>
          {onUploadThumbnail && (
            <label className="stack">
              {t('대표 사진 (defaultThumbnail)')}
              <span className="note">
                {String((raw['defaultThumbnail'] as { path?: string } | undefined)?.path ?? tr('없음'))}
                {(raw['defaultThumbnail'] as { path?: string } | undefined)?.path ===
                  '/thumbnail.png' && tr(' — 임시 그림입니다. 실제 장비 사진으로 바꾸십시오')}
              </span>
              <input
                type="file"
                accept="image/*"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUploadThumbnail(file);
                  event.target.value = '';
                }}
              />
            </label>
          )}
          <button
            className="primary"
            disabled={busy}
            title={t('자산 정보(종류·globalAssetId)를 반영합니다 — 묶음에서 설비를 가리키는 주소가 이것입니다')}
            onClick={() => {
              // 스프레드로 원본을 얹으면 **지운 값이 되살아난다.** 키를 지워야 지워진다
              const next = { ...raw } as Record<string, unknown>;
              next['assetKind'] = asset.assetKind;
              if (asset.globalAssetId.trim() === '') delete next['globalAssetId'];
              else next['globalAssetId'] = asset.globalAssetId.trim();
              onSaveAssetInformation(next);
            }}
          >
            {t('저장')}
          </button>
        </div>
      )}

      {node.modelType === 'ConceptDescription' && onSaveConcept && (
        <div className="editor">
          {/*
            🔴 「자동 고치기」가 만든 CD는 definition에 idShort를 그대로 넣는다(KOSMO-CD-3을 넘기는
               자리 채움). 그 문장이 문서용 자료의 「정의」 열에 실리므로 사람이 채워야 한다 —
               그런데 고칠 자리가 없어 CD를 지우고 다시 만드는 사람이 있었다(전문가 시연 실측).
          */}
          {concept.definitionEn.trim() !== '' &&
            concept.definitionEn.trim() === String(raw['idShort'] ?? '').trim() && (
              <p className="note warning">
                {t('정의가 idShort와 같습니다 — 도구가 임시로 채운 것입니다. 뜻풀이를 적어 주십시오.')}
              </p>
            )}
          <label className="stack">
            preferredName (en)
            <input
              value={concept.preferredNameEn}
              aria-label="preferredName (en)"
              onChange={(event) => setConcept({ ...concept, preferredNameEn: event.target.value })}
            />
          </label>
          <label className="stack">
            {t('definition (en) — KOSMO-CD-3 필수')}
            <textarea
              value={concept.definitionEn}
              aria-label="definition (en)"
              rows={2}
              onChange={(event) => setConcept({ ...concept, definitionEn: event.target.value })}
            />
          </label>
          <label className="stack">
            {t('definition (ko) — 문서용, 비워도 됨')}
            <textarea
              value={concept.definitionKo}
              aria-label="definition (ko)"
              rows={2}
              onChange={(event) => setConcept({ ...concept, definitionKo: event.target.value })}
            />
          </label>
          <div className="row">
            <label className="stack">
              dataType
              <select
                value={concept.dataType}
                aria-label="dataType"
                onChange={(event) => setConcept({ ...concept, dataType: event.target.value })}
              >
                <option value="">{t('(없음)')}</option>
                {IEC61360_DATA_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              unit
              <input
                value={concept.unit}
                aria-label="unit"
                placeholder={t('예: mm · kg · °C')}
                onChange={(event) => setConcept({ ...concept, unit: event.target.value })}
              />
            </label>
          </div>
          <button
            className="primary"
            disabled={busy || concept.definitionEn.trim() === ''}
            title={concept.definitionEn.trim() === '' ? t('영문 정의가 비면 KOSMO-CD-3 위반입니다') : undefined}
            onClick={() => onSaveConcept(writeConcept(raw, concept))}
          >
            {t('저장')}
          </button>
        </div>
      )}

      {/*
        이름(idShort) 바꾸기.
        🔴 리스트(SubmodelElementList) 자식은 뺀다 — 그 자리는 순서로 가리키고,
        이름을 붙이면 표준 제약(AASd-120) 위반이 된다. 경로 마지막이 `[n]`이면 리스트 자식이다.
      */}
      {onRename && renameable(node) && (
        <div className="editor rename">
          <label className="stack">
            {t('이름 (idShort)')}
            <input
              value={name}
              aria-label={t('이름')}
              className="mono"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {name.trim() !== '' && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name.trim()) && (
            <p className="note warning">
              {t('영문으로 시작하고 영문·숫자·밑줄만 쓰는 편이 안전합니다(표준 권고).')}
            </p>
          )}
          <button
            disabled={busy || name.trim() === '' || name.trim() === String(raw['idShort'] ?? '')}
            title={t('idShort를 바꿉니다 — 이 이름을 가리키던 다른 요소의 참조는 따라오지 않습니다')}
            onClick={() => onRename(node, name.trim())}
          >
            {t('이름 바꾸기')}
          </button>
        </div>
      )}

      {/*
        첨부 — File·Blob이 가리키는 실제 파일.
        HandoverDocumentation의 매뉴얼 PDF가 제출물의 실체라, 값(경로)만 고쳐서는 안 되고
        **파일 자체를 넣을 수 있어야** 한다.
      */}
      {(node.modelType === 'File' || node.modelType === 'Blob') &&
        node.idShortPath !== undefined &&
        onUploadAttachment && (
          <div className="editor attachment">
            <h3>{t('첨부 파일')}</h3>
            {attachedName(raw) ? (
              <p className="note ok"><T k={'붙어 있음: {0}'} v={[attachedName(raw)]} /></p>
            ) : (
              <p className="note">{t('아직 파일이 붙어 있지 않습니다.')}</p>
            )}
            <label className="stack">
              {t('파일 고르기')}
              <input
                type="file"
                aria-label={tr('첨부 파일')}
                disabled={busy}
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  // 같은 파일을 다시 골라도 onChange가 나게 값을 비운다
                  event.target.value = '';
                  if (chosen) onUploadAttachment(node, chosen);
                }}
              />
            </label>
            <div className="row-buttons">
              {attachedName(raw) && onDownloadAttachment && (
                <button
                  disabled={busy}
                  title={t('이 요소에 담긴 파일을 내려받습니다')}
                  onClick={() => onDownloadAttachment(node, attachedName(raw)!)}
                >
                  {t('내려받기')}
                </button>
              )}
              {attachedName(raw) && onDeleteAttachment && (
                <button
                  className="danger"
                  disabled={busy}
                  title={t('담긴 파일을 파일 안에서 뺍니다 — 되돌리려면 헤더의 ↶')}
                  onClick={() => onDeleteAttachment(node)}
                >
                  {t('첨부 지우기')}
                </button>
              )}
            </div>
          </div>
        )}

      {onSaveSemanticId && policy && (node.idShortPath !== undefined || node.modelType === 'Submodel') && (
        <div className="editor semantic">
          {/* M4 축소판 — 사전 검색 UI 대신 직접 입력 + 그 자리 검증(§2 결정) */}
          <label className="stack">
            {node.modelType === 'Submodel'
              ? t('semanticId (표준 템플릿 IRI 또는 IRDI)')
              : t('semanticId (IRDI 또는 자체 IRI)')}
            <input
              value={semantic}
              aria-label="semanticId"
              className="mono"
              onChange={(event) => setSemantic(event.target.value)}
              placeholder="0112/2///61987#ABA231#009"
            />
          </label>
          {checkSemanticId(
            semantic,
            policy,
            conceptIds?.has(semantic.trim()) ?? false,
            node.modelType === 'Submodel' ? 'submodel' : 'element',
            t,
          ).map(
            (note, index) => (
              <p key={index} className={`note ${note.level}`}>
                {note.message}
              </p>
            ),
          )}
          <button
            disabled={busy || semantic.trim() === ''}
            title={t('semanticId를 반영합니다 — 뜻을 가리키는 주소라 Validator가 가장 먼저 봅니다')}
            onClick={() => onSaveSemanticId(node, semantic.trim())}
          >
            {t('semanticId 저장')}
          </button>
        </div>
      )}

      {/* 순서 바꾸기는 여기 없다 — 왼쪽 트리에서 끌어서 놓는다(우클릭 메뉴·Alt+↑↓도). 버튼 이름만으로
          무엇인지 모르겠다는 지적(2026-09-04)에 따라 남는 것도 하는 일을 그대로 적는다 */}
      <div className="row-buttons actions">
        {onAddChild && (
          <button disabled={busy} title={t('이 안에 새 요소를 만듭니다')} onClick={() => onAddChild(node)}>
            {t('요소 추가')}
          </button>
        )}
        {onDuplicate && (
          <button disabled={busy} title={t('안의 요소와 값까지 그대로 하나 더 — 두 번째 인증 마크·문서·연락처를 넣을 때 (이름 끝에 _2)')} onClick={() => onDuplicate(node)}>
            {t('사본 만들기')}
          </button>
        )}
        {onDelete && (
          <button className="danger" disabled={busy} title={t('잘못 지웠으면 「↶ 되돌리기」')} onClick={() => onDelete(node)}>
            {t('삭제')}
          </button>
        )}
        {onDelete && node.idShortPath !== undefined && (
          <span className="hint">{t('순서는 왼쪽 트리에서 끌어서 바꿉니다 (또는 우클릭 · Alt+↑↓)')}</span>
        )}
      </div>
    </div>
  );
}
