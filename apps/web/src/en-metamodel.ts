/**
 * English dictionary — metamodel versions on screen: the header chip, the download window (ExportDialog) and the
 * assetKind choices (2026-10-19). Kept apart from en.ts so this feature's text is in one place; registered in i18n.ts.
 * Same contract as en.ts: the key is the Korean text itself, and `{0}` · `<b>` must appear identically in the value.
 */
export const EN_METAMODEL: Record<string, string> = {
  'AAS 메타모델 버전 — JSON이라 버전 표시가 없어 내용으로 정했습니다. 내려받을 때 다른 버전을 고를 수 있습니다':
    'AAS metamodel version — the file is JSON and carries no version, so it was worked out from the content. You can pick another version when downloading',
  'AAS 메타모델 버전 — 내려받을 때 다른 버전을 고를 수 있습니다': 'AAS metamodel version — you can pick another version when downloading',
  'AASX 내려받기 — 메타모델 버전': 'Download AASX — metamodel version',
  '공식 검증기(aas-test-engines 1.0.3)가 판정하는 버전': 'the version the official validator (aas-test-engines 1.0.3) checks',
  'KOSMO가 요구하는 버전 · IDTA 서식의 버전': 'the version KOSMO asks for and the IDTA templates use',
  '최신 버전 — 받는 쪽이 V3.2를 읽는지 먼저 확인하십시오': 'the latest version — check first that the receiving side reads V3.2',
  '이 파일의 버전: V{0}': 'Version of this file: V{0}',
  '(JSON이라 버전 표시가 없어 내용으로 정했습니다)': '(JSON carries no version, so it was worked out from the content)',
  '내보낼 버전': 'Version to write',
  '(이 파일의 버전)': '(this file’s version)',
  '이 버전으로 쓰면 무엇이 달라지는지 확인하고 있습니다…': 'Checking what writing this version would change…',
  'V{0}으로 써도 빠지거나 바뀌는 것이 없습니다.': 'Writing V{0} leaves nothing out and changes nothing.',
  'V{0}으로 쓸 수 없는 값이 {1}건 있어 내려받기를 막았습니다.': '{1} values cannot be written as V{0}, so the download is blocked.',
  '그대로 두고 내려받기 — 이 파일은 V{0} 공식 스키마를 통과하지 못합니다':
    'Download with the values as they are — this file will not pass the official V{0} schema',
  'V{0}에는 없는 칸 {1}건이 파일에서 빠집니다.': '{1} fields that V{0} does not have will be left out of the file.',
  'V{0}은 첨부 경로에 URI 형식만 받습니다 — 파일 이름 {1}건을 퍼센트 인코딩하고 패키지 안의 파일 이름도 같이 바꿉니다. 이 도구로 다시 열면 원래 이름으로 보입니다.':
    'V{0} accepts only URIs as attachment paths — {1} file names are percent-encoded, and the files inside the package are renamed with them. Reopened in this tool, they show their original names.',
  'V{0}으로 내려받기': 'Download as V{0}',
  'assetKind {0}은(는) V{1}에 없는 값입니다 — 이 버전으로 내려받으면 막힙니다. 더 높은 버전으로 내려받거나 값을 바꾸십시오.':
    'assetKind {0} does not exist in V{1} — downloading this version is blocked. Download a later version or change the value.',
};
