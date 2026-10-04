/**
 * 문서용 자료 — 가이던스에 **붙여넣을** 그림과 표.
 *
 * 근거: KTL 규정 §13.
 *  - 주의사항 3 — 모든 서브모델에 **UML Diagram 첨부**
 *  - 주의사항 5 — 장비 특화 서브모델에 한해 **구성요소 상세 정보 테이블** 작성
 *
 * 🔴 가이던스 **문장은 도구가 쓰지 않는다.** 파일에 있는 사실만 뽑아 준다.
 * 🔴 문서를 직접 고치지도 않는다 — 표를 프로그램이 재생성하다 19건이 손상돼
 *    백업에서 복구한 사고가 있다(02_Validator_대응규칙 §4.3). 우리는 그 자리에 들어가지 않는다.
 *
 * 붙여넣기가 실제로 되게 하는 것이 이 화면의 전부다.
 *  - 그림은 **PNG로** 클립보드에 넣는다. 한글(HWP)은 SVG를 제대로 못 받는다
 *  - 표는 **HTML로** 클립보드에 넣는다. 그래야 워드·한글·엑셀에 표 모양 그대로 붙는다
 */
import { useEffect, useRef, useState } from 'react';
import { api, type DocPlan, type SmtTable, type SubmodelInfo, type TableRow } from '../api.js';
import { buildDocx, type DocxBlock, type DocxCell, type DocxTable } from '../docx.js';
import { brandLogoBytes } from '../brand.js';
import type { Submodel } from '../model.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

interface Props {
  packageId: string;
  submodels: Submodel[];
  /** 장비명 — 문서 제목과 파일명에 쓴다 */
  assetName: string;
  onClose: () => void;
}

/**
 * A4 세로 한 쪽에 들어가는 크기(여백 2cm 기준).
 * 🔴 그림이 이보다 크면 워드가 종이 밖으로 밀어낸다 — 문서에 못 쓴다.
 */
const A4_CONTENT_MM = { width: 170, height: 247 };

/**
 * SVG의 원래 크기를 읽어 A4 안에 들어갈 크기를 구한다.
 *
 * 🔴 워드에 넣을 때는 **px 속성**이 있어야 한다. CSS `style`만 주면 워드가 무시하고
 *    그림의 원래 픽셀 크기를 그대로 쓴다(2배로 그린 PNG면 종이의 2배가 된다).
 *    그래서 cm와 px를 함께 돌려주고, `<img width height>` 속성으로도 박는다.
 */
function fitToA4(svg: string): { widthCm: number; heightCm: number; widthPx: number; heightPx: number } {
  const width = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  const height = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  const fallback = { widthCm: 17, heightCm: 0, widthPx: 643, heightPx: 0 };
  if (width <= 0 || height <= 0) return fallback;

  // SVG 좌표는 px(96dpi)다 → mm
  const widthMm = (width / 96) * 25.4;
  const heightMm = (height / 96) * 25.4;
  const scale = Math.min(1, A4_CONTENT_MM.width / widthMm, A4_CONTENT_MM.height / heightMm);
  const finalWidthMm = widthMm * scale;
  const finalHeightMm = heightMm * scale;
  return {
    widthCm: finalWidthMm / 10,
    heightCm: finalHeightMm / 10,
    widthPx: Math.round((finalWidthMm / 25.4) * 96),
    heightPx: Math.round((finalHeightMm / 25.4) * 96),
  };
}

/** 클립보드에 그림을 넣으려면 PNG여야 한다 — SVG를 캔버스에 그려 바꾼다(라이브러리 없이) */
async function svgToPngBlob(svg: string, scale = 2, targetWidthPx?: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(tr('그림을 읽지 못했습니다.')));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    // 문서에 들어갈 크기를 알면 그 크기의 2배로 그린다 — 화면에서 선명하고 파일도 커지지 않는다
    const factor = targetWidthPx ? (targetWidthPx * 2) / image.width : scale;
    canvas.width = Math.round(image.width * factor);
    canvas.height = Math.round(image.height * factor);
    const context = canvas.getContext('2d');
    if (!context) throw new Error(tr('캔버스를 열지 못했습니다.'));
    // 문서는 흰 종이다 — 투명 배경으로 두면 붙여넣은 뒤 글자가 안 보인다
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(tr('PNG로 바꾸지 못했습니다.')))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 표 한 장을 워드 표로. 열 너비는 A4 본문(17cm) 안에서 나눈다 */
function toDocxTable(table: SmtTable): DocxTable {
  const columns = [3.6, 7.4, 4.0, 2.0];
  const semanticLines = (cell: SmtTable['semantic']): string[] => {
    if (cell.id === '') return ['-'];
    const lines = [`${cell.idType} ${cell.id}`];
    if (cell.definition !== '') lines.push(cell.definition);
    if (cell.korean !== '') lines.push(cell.korean);
    if (cell.idtaOrigin !== '') lines.push(fill(tr('IDTA 원본: {0}'), { 0: cell.idtaOrigin }));
    return lines;
  };

  const label = (text: string): DocxCell => ({ lines: [text], bold: true, shaded: true });
  const rows: DocxCell[][] = [
    [label('idShort:'), { lines: [table.idShort], span: 3 }],
    [label('Class:'), { lines: [table.className], span: 3 }],
    [label('semanticId:'), { lines: semanticLines(table.semantic), span: 3 }],
    [label('Parent:'), { lines: [table.parent], span: 3 }],
    [label('Explanation:'), { lines: [table.explanation], span: 3 }],
    [
      label('[SME type]idShort'),
      { lines: ['semanticId = [idType]value', 'Description@en'], bold: true, shaded: true },
      { lines: ['[valueType]example'], bold: true, shaded: true },
      { lines: ['card.'], bold: true, shaded: true },
    ],
  ];
  for (const child of table.children) {
    rows.push([
      { lines: [child.label] },
      { lines: semanticLines(child.semantic) },
      { lines: [child.value] },
      { lines: [child.cardinality] },
    ]);
  }
  return { kind: 'table', rows, columns };
}

export function DocAssets({ packageId, submodels, assetName, onClose }: Props): React.JSX.Element {
  const [target, setTarget] = useState<string>(''); // '' = 전체 구성도
  const [svg, setSvg] = useState<string>('');
  const [note, setNote] = useState<string>();
  const [plan, setPlan] = useState<DocPlan>();
  const [rows, setRows] = useState<TableRow[]>();
  const [info, setInfo] = useState<SubmodelInfo>();
  /** 서버가 만든 표 HTML — 화면에 보이는 것과 문서에 붙는 것이 같아야 한다 */
  const [tableHtml, setTableHtml] = useState<string>('');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string>();
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(undefined);
    void api
      .diagram(packageId, target === '' ? undefined : target)
      .then((text) => alive && setSvg(text))
      .catch(() => alive && setError(tr('그림을 받지 못했습니다.')));
    return () => {
      alive = false;
    };
  }, [packageId, target]);

  // 표 — 규정은 **장비 특화 서브모델에만** 표를 요구한다. 표준 템플릿이면 info가 온다
  useEffect(() => {
    if (target === '') {
      setPlan(undefined);
      setRows(undefined);
      setInfo(undefined);
      return;
    }
    let alive = true;
    void api
      .table(packageId, target)
      .then(async (result) => {
        if (!alive) return;
        setPlan(result.plan);
        setRows(result.rows);
        setInfo(result.info);
        setTableHtml(result.plan.kind === 'table' ? await api.tableHtml(packageId, target) : '');
      })
      .catch(() => alive && setPlan(undefined));
    return () => {
      alive = false;
    };
  }, [packageId, target]);

  const copyTable = async (): Promise<void> => {
    setNote(undefined);
    setError(undefined);
    try {
      const html = await api.tableHtml(packageId, target);
      // 🔴 HTML로 넣어야 워드·한글·엑셀에 **표 모양 그대로** 붙는다. 글자만 붙으면 소용없다
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([html.replace(/<[^>]+>/g, ' ')], { type: 'text/plain' }),
        }),
      ]);
      setNote(tr('표를 복사했습니다. 문서에 붙여넣으십시오(Ctrl+V).'));
    } catch {
      setError(tr('복사가 막혔습니다. 「CSV 내려받기」를 쓰십시오.'));
    }
  };

  const name = target === '' ? tr('전체구성도') : target;

  const copyImage = async (): Promise<void> => {
    setNote(undefined);
    setError(undefined);
    try {
      const png = await svgToPngBlob(svg);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setNote(tr('그림을 복사했습니다. 문서에 붙여넣으십시오(Ctrl+V).'));
    } catch {
      // 클립보드 권한이 없거나 브라우저가 막는 경우가 있다 — 그때는 파일로 준다
      setError(tr('복사가 막혔습니다. 「PNG 내려받기」를 쓰십시오.'));
    }
  };

  /**
   * 문서 한 벌 내려받기 — **진짜 .docx**.
   *
   * 🔴 처음엔 HTML 기반 `.doc`로 만들었는데, 워드가 **용지 설정을 적용하지 않았다**
   *    (실측: 그림 폭은 17cm로 들어갔지만 page setup이 비어 있었다. 용지가 Letter로
   *    열리면 본문 폭이 16.5cm라 그림이 넘친다). 한글(HWP)은 더 제멋대로 연다.
   *    .docx는 용지·여백·그림 크기를 EMU로 못박으므로 둘 다 똑같이 연다.
   */
  const buildDocument = async (): Promise<void> => {
    setBuilding(true);
    setNote(undefined);
    setError(undefined);
    try {
      const blocks: DocxBlock[] = [
        // 회사 표시 — 남에게 건네는 문서다
        { kind: 'image', data: brandLogoBytes(), widthCm: 3.4, heightCm: 1.0, left: true },
        { kind: 'heading', level: 1, text: fill(tr('{0} — 가이던스 부속 자료'), { 0: assetName }) },
        {
          kind: 'paragraph',
          small: true,
          text:
            tr('이 문서는 AASX 파일에서 자동으로 뽑은 사실입니다. ') +
            tr('가이던스 문장(특징·활용방안·활용 시나리오)은 사람이 작성합니다. ') +
            tr('필요한 부분을 골라 가이던스 문서로 복사해 쓰십시오.'),
        },
      ];

      let figure = 0;
      let tableNumber = 0;
      for (const submodel of submodels) {
        const name = submodel.idShort ?? submodel.id;
        const result = await api.table(packageId, name);
        const diagram = await api.diagram(packageId, name);
        const size = fitToA4(diagram);
        const png = await svgToPngBlob(diagram, 2, size.widthPx);
        const bytes = new Uint8Array(await png.arrayBuffer());
        figure += 1;

        blocks.push({ kind: 'heading', level: 2, text: `${figure}. ${name}` });
        blocks.push({
          kind: 'image',
          data: bytes,
          widthCm: size.widthCm,
          heightCm: size.heightCm,
        });
        blocks.push({
          kind: 'paragraph',
          center: true,
          small: true,
          text: fill(tr('그림 {0} {1} 서브모델 UML 다이어그램'), { 0: figure, 1: name }),
        });

        if (result.plan.kind === 'table') {
          for (const table of result.tables ?? []) {
            tableNumber += 1;
            // 표 제목은 표 **위**에 온다 — 실제 가이던스와 같은 자리
            blocks.push({
              kind: 'paragraph',
              bold: true,
              text: fill(tr('표 {0} {1} - {2}'), { 0: tableNumber, 1: name, 2: table.idShort }),
            });
            blocks.push(toDocxTable(table));
          }
        } else {
          blocks.push({
            kind: 'paragraph',
            text: fill(tr('표 생략 — {0}'), { 0: result.plan.reason }),
          });
          blocks.push({
            kind: 'paragraph',
            text:
              fill(tr('외부 참조모델: {0}'), { 0: result.info?.externalTemplate || tr('(파일에 없음 — 확인해 넣으십시오)') }) +
              fill(tr(' · 참조 용어사전: {0}'), { 0: (result.info?.dictionaries ?? []).join(' · ') || '-' }) +
              fill(tr(' · 요소 수: {0}개'), { 0: result.info?.elementCount ?? 0 }),
          });
          blocks.push({ kind: 'paragraph', bold: true, text: tr('사람이 채울 자리') });
          for (const item of result.info?.toWrite ?? []) {
            blocks.push({ kind: 'bullet', text: item });
          }
        }
      }

      const bytes = buildDocx(blocks, { title: fill(tr('{0} 가이던스 부속 자료'), { 0: assetName }) });
      download(
        new Blob([bytes as unknown as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        fill(tr('{0}_가이던스_부속자료.docx'), { 0: assetName }),
      );
      setNote(tr('문서를 내려받았습니다. 워드·한글에서 열어 필요한 부분을 복사하십시오.'));
    } catch {
      setError(tr('문서를 만들지 못했습니다.'));
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="add-form doc-assets">
      <h3>{tr('문서용 자료 — 가이던스에 붙여넣기')}</h3>
      <p className="hint"><T k={'규정 §13은 <b>모든 서브모델에 UML Diagram 첨부</b>(주의사항 3)를 요구합니다. 여기서 뽑아 문서에 붙여넣으십시오. <b>문서 문장은 도구가 쓰지 않습니다</b> — 파일에 있는 사실만 그립니다.'} /></p>

      <label>
        {tr('대상')}
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">{tr('전체 구성도 (AAS + 서브모델)')}</option>
          {submodels.map((submodel) => (
            <option key={submodel.id} value={submodel.idShort ?? submodel.id}>
              {submodel.idShort ?? submodel.id}
            </option>
          ))}
        </select>
      </label>

      <div className="row-buttons">
        <button
          className="primary"
          disabled={svg === ''}
          title={tr('그림을 클립보드에 PNG로 담습니다 — 워드·한글에 Ctrl+V로 붙습니다')}
          onClick={() => void copyImage()}
        >
          {tr('그림 복사')}
        </button>
        <button
          disabled={svg === ''}
          title={tr('그림을 PNG 파일로 내려받습니다')}
          onClick={() => void svgToPngBlob(svg).then((png) => download(png, `${name}.png`))}
        >
          {tr('PNG 내려받기')}
        </button>
        <button
          disabled={svg === ''}
          title={tr('그림을 SVG로 내려받습니다 — 크기를 키워도 안 깨지지만 한글에서 안 붙는 경우가 있습니다')}
          onClick={() => download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`)}
        >
          {tr('SVG 내려받기')}
        </button>
        <button onClick={onClose}>{tr('닫기')}</button>
      </div>

      <div className="row-buttons">
        {/* 서브모델 전부를 한 문서로 — 열어서 필요한 부분만 복사하면 된다 */}
        <button
          className="primary"
          disabled={building}
          title={tr('서브모델 전부의 그림과 표를 한 .docx로 묶습니다 — A4 용지·그림 크기가 고정됩니다')}
          onClick={() => void buildDocument()}
        >
          {building ? tr('문서 만드는 중…') : tr('문서 한 벌 내려받기 (.docx)')}
        </button>
        <span className="hint"><T k={'서브모델 {0}종의 그림과 표를 한 파일에'} v={[submodels.length]} /></span>
      </div>

      {note && <p className="note ok">{note}</p>}
      {error && <p className="note error">{error}</p>}
      <p className="hint"><T k={'한글(HWP)·워드에는 <b>그림 복사</b>(PNG)가 안전합니다. SVG는 크기를 키워도 안 깨지지만 한글에서 제대로 안 붙는 경우가 있습니다.'} /></p>

      {/* 흰 바탕 그대로 보여 준다 — 문서에 붙였을 때와 같은 모습이어야 한다 */}
      <div className="diagram" ref={holder} dangerouslySetInnerHTML={{ __html: svg }} />

      {plan && (
        <div className="doc-table">
          <h4>{tr('구성요소 상세 정보 테이블')}</h4>
          <p className="hint">{plan.reason}</p>

          {rows && (
            <>
              <div className="row-buttons">
                <button
          className="primary"
          title={tr('표를 클립보드에 담습니다 — 워드·한글·엑셀에 표 모양 그대로 붙습니다')}
          onClick={() => void copyTable()}
        >
                  {tr('표 복사')}
                </button>
                <button
          title={tr('표를 CSV로 내려받습니다 — 엑셀에서 열 수 있게 BOM을 붙입니다')}
          onClick={() => void api.downloadTableCsv(packageId, target)}
        >
                  {tr('CSV 내려받기')}
                </button>
                <span className="hint"><T k={'{0}행'} v={[rows.length]} /></span>
              </div>
              {/* 서버가 만든 표를 그대로 보여 준다 — 흰 바탕이어야 문서에 붙였을 때와 같다 */}
              <div className="preview" dangerouslySetInnerHTML={{ __html: tableHtml }} />
            </>
          )}

          {info && (
            <div className="info-block">
              <p className="note warning"><T k={'이 서브모델은 <b>표를 만들지 않습니다.</b> 대신 아래 정보를 가이던스에 적습니다.'} /></p>
              <dl>
                <dt>{tr('외부 참조모델')}</dt>
                <dd>{info.externalTemplate || <i className="dim">{tr('파일에 없음 — 확인해 넣으십시오')}</i>}</dd>
                <dt>{tr('참조 용어사전')}</dt>
                <dd>
                  {info.dictionaries.length > 0 ? (
                    info.dictionaries.join(' · ')
                  ) : (
                    <i className="dim">{tr('없음')}</i>
                  )}
                </dd>
                <dt>{tr('요소 수')}</dt>
                <dd><T k={'{0}개'} v={[info.elementCount]} /></dd>
              </dl>
              <p className="hint">
                <T k={'<b>사람이 채울 자리</b> — 도구는 지어내지 않습니다:'} /></p>
              <ul className="to-write">
                {info.toWrite.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
