/**
 * 가이던스 부속 자료(.docx) — 서브모델마다 UML 그림 + 구성요소 표(또는 「표 생략」 이유와 사람이 채울 자리).
 * components/DocAssets.tsx 의 「문서로 받기」에서 떼어 냈다(2026-10-13 컴포넌트화) — 순서·문구는 그대로다.
 * 🔴 가이던스 문장은 도구가 쓰지 않는다. 파일에 있는 사실만 담는다.
 */
import { api } from '../../api.js';
import { brandLogoBytes } from '../../brand.js';
import { buildDocx, type DocxBlock } from '../../docx.js';
import { fill, tr } from '../../i18n.js';
import type { Submodel } from '../../model.js';
import { fitToA4, svgToPngBlob, toDocxTable } from './exportHelpers.js';

export async function buildGuidanceDocx(packageId: string, submodels: Submodel[], assetName: string): Promise<Uint8Array> {
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

  return buildDocx(blocks, { title: fill(tr('{0} 가이던스 부속 자료'), { 0: assetName }) });
}
