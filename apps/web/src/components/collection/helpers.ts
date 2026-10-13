/**
 * 수집 칸 — 공정 화면의 설비 줄 · 내려받기 · 값 표시 · 실패 사유 줄이기.
 * components/Collection.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석·판정은 옮기기 전 글자 그대로다.
 */
import type { CollectedValueView } from '../../api.js';
import { tr } from '../../i18n.js';


export interface EquipmentRow {
  name: string;
  /** 공정 › 그룹 경로 */
  group: string;
  bulkCount: number;
  /** 파일이 열려 있지 않으면(예정) 없다 */
  packageId?: string;
  /** 수집 연결(AID)이 붙어 있는가 */
  connected: boolean;
}

/** 브라우저에 파일 하나를 건넨다 (DocAssets와 같은 방식) */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function displayValue(value: CollectedValueView): string {
  if (value.valueText !== undefined && value.valueText !== '') return value.valueText;
  if (value.valueNumber !== undefined) return String(value.valueNumber);
  return tr('(빈 값)');
}


/**
 * 수집 보고 한 인터페이스분 — 「값 대기」 칸까지 본다.
 *
 * 🔴 서버(`CollectReport`)는 실패(`failures`)와 **아직 값이 안 들어온 것**(`pending`)을 가른다.
 *    빈 목록일 땐 `pending`을 아예 싣지 않으므로 없어도 0으로 읽힌다 — 예전 서버에 붙어도 어긋나지 않는다.
 */
/** 실패 사유를 한 토막으로 — `BadNodeIdUnknown (0x80340000)` → `BadNodeIdUnknown` */
export function shortReason(reason: string): string {
  const head = reason.split(/[\s(:]/)[0] ?? reason;
  return head.length > 0 && head.length <= 40 ? head : reason.slice(0, 40);
}
