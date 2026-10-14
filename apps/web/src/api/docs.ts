/**
 * API 클라이언트 — 문서용 자료 — UML 그림 · 구성요소 표
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { DocPlan, TableRow, SmtTable, SubmodelInfo } from './types.js';
import { withAuth, request, toError, filenameOf, saveBlob } from './http.js';

export const docsApi = {
  /**
   * 첨부 올리기 — File·Blob 요소가 가리키는 **실제 파일**(매뉴얼 PDF·도면 등).
   *
   * 서버가 패키지 안에 파트를 만들고 `File.value`까지 함께 고친다. 브라우저는 바이트만 올린다.
   * 🔴 파일명은 질의 인자로 준다 — 본문은 파일 바이트 그대로여야 하기 때문이다.
   */
  /**
   * 가이던스에 붙일 UML 다이어그램(SVG 문자열).
   * `submodel`을 주지 않으면 AAS 전체 구성도.
   */
  diagram: async (packageId: string, submodel?: string): Promise<string> => {
    const query = submodel ? `?submodel=${encodeURIComponent(submodel)}` : '';
    const response = await fetch(`/packages/${packageId}/diagram.svg${query}`, withAuth());
    if (!response.ok) throw await toError(response);
    return await response.text();
  },
  /** 서브모델별로 표를 만들지 정보를 적을지 (규정 §13 주의사항 5) */
  docPlan: (packageId: string): Promise<{ result: DocPlan[] }> =>
    request(`/packages/${packageId}/doc-plan`),
  /** 상세 정보 테이블(화면용). 표 대상이 아니면 info가 온다 */
  table: (
    packageId: string,
    submodel: string,
  ): Promise<{
    plan: DocPlan;
    rows?: TableRow[];
    tables?: SmtTable[];
    info?: SubmodelInfo;
    tableCount?: number;
  }> =>
    request(`/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}`),
  /** 붙여넣기용 HTML 표. `from`은 표 번호 시작값(문서 전체에서 이어져야 한다) */
  tableHtml: async (packageId: string, submodel: string, from?: number): Promise<string> => {
    const response = await fetch(
      `/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}&format=html` +
        (from === undefined ? '' : `&from=${from}`),
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    return await response.text();
  },
  downloadTableCsv: async (packageId: string, submodel: string): Promise<void> => {
    const response = await fetch(
      `/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}&format=csv`,
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? `${submodel}.csv`);
  },
};
