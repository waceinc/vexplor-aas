/**
 * Document assets — figures and tables to **paste** into the guidance.
 *
 * Basis: KTL rules §13.
 *  - Caution 3 — **attach a UML diagram** to every submodel
 *  - Caution 5 — write a **component detail table** only for equipment-specific submodels
 *
 * Important: the tool **does not write guidance sentences.** It only extracts facts present in the file.
 * Important: it does not edit the document directly either — there was an incident where a program regenerating tables
 *    damaged 19 of them and they had to be restored from backup (02_Validator_대응규칙 §4.3). We stay out of that role.
 *
 * Making pasting actually work is the whole point of this screen.
 *  - Figures go to the clipboard **as PNG**. Hangul (HWP) does not accept SVG properly
 *  - Tables go to the clipboard **as HTML**. Only then do they paste as tables into Word, Hangul, and Excel
 */
import { useEffect, useRef, useState } from 'react';
import { api, type DocPlan, type SubmodelInfo, type TableRow } from '../api.js';
import { svgToPngBlob, download } from './docAssets/exportHelpers.js';
import { buildGuidanceDocx } from './docAssets/guidanceDoc.js';
import type { Submodel } from '../model.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

interface Props {
  packageId: string;
  submodels: Submodel[];
  /** Equipment name — used in the document title and file name */
  assetName: string;
  onClose: () => void;
}

export function DocAssets({ packageId, submodels, assetName, onClose }: Props): React.JSX.Element {
  const [target, setTarget] = useState<string>(''); // '' = full structure diagram
  const [svg, setSvg] = useState<string>('');
  const [note, setNote] = useState<string>();
  const [plan, setPlan] = useState<DocPlan>();
  const [rows, setRows] = useState<TableRow[]>();
  const [info, setInfo] = useState<SubmodelInfo>();
  /** Table HTML built by the server — what is shown on screen and what is pasted into the document must be the same */
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

  // Table — the rules require a table **only for equipment-specific submodels**. For a standard template, info comes back
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
      // Important: it must go in as HTML to paste into Word, Hangul, and Excel **as a table**. Pasting plain text is useless
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
      // Clipboard permission may be missing or blocked by the browser — in that case hand it over as a file
      setError(tr('복사가 막혔습니다. 「PNG 내려받기」를 쓰십시오.'));
    }
  };

  /**
   * Download the full document — **a real .docx**.
   *
   * Important: it was first built as an HTML-based `.doc`, but Word **did not apply the page setup**
   *    (measured: figures went in at 17 cm wide but page setup was empty. If the page opens as Letter
   *    the body width is 16.5 cm and figures overflow). Hangul (HWP) opens it even more unpredictably.
   *    .docx pins paper, margins, and figure size in EMU, so both open it the same way.
   */
  const buildDocument = async (): Promise<void> => {
    setBuilding(true);
    setNote(undefined);
    setError(undefined);
    try {
      const bytes = await buildGuidanceDocx(packageId, submodels, assetName);
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
        {/* All submodels in one document — open it and copy only the parts you need */}
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

      {/* Shown on a white background as-is — it must look the same as when pasted into a document */}
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
              {/* Show the server-built table as-is — it needs a white background to match how it looks pasted into a document */}
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
