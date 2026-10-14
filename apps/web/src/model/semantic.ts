/**
 * 모델 — semanticId 그 자리 검증(IRDI · IRI · 정책).
 * src/model.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 model.ts 로 쓴다.
 */


/**
 * semanticId 형식 검사 — M4 축소판(§2에서 eCl@ss 검색 UI 대신 직접 입력 + 검증으로 결정).
 *
 * 판정 근거는 실측 규칙이다.
 *  - KOSMO는 semanticId로 **IRDI(0173-/0112/) 또는 자체 IRI**만 인정한다(02_Validator_대응규칙 §110)
 *  - eCl@ss 말미 `-00` 코드는 CDP에 존재하지 않는다(AAS_OPC UA.md L9) — 재검증 대상
 *  - 형식이 맞아도 대응 CD가 없으면 KOSMO-SME-3으로 걸린다
 *
 * 린터가 어차피 잡아 주지만, **입력하는 순간 알려 주는 편이 되돌리기 싸다.**
 */
export interface SemanticIdNote {
  level: 'ok' | 'warning' | 'error';
  message: string;
}

/** eCl@ss IRDI — 예: 0173-1#02-AAA123#001 */
const ECLASS_IRDI = String.raw`0173-\d+#\d{2}-[A-Z0-9]+#\d{3}`;

/** IEC CDD IRDI — 예: 0112/2///61987#ABA231#009 */
const IEC_CDD_IRDI = String.raw`0112\/\d+\/\/\/[0-9_A-Za-z]+#[A-Z]{3}\d+#\d{3}`;

const ONE_IRDI = `(?:${ECLASS_IRDI}|${IEC_CDD_IRDI})`;

/**
 * 표준 사전 IRDI — **둘을 `/`로 이은 복합형도 표준이다**(사용자 2026-09-14 제기, 실측으로 확인).
 *
 * IDTA 템플릿이 리스트 항목(SMC)에 「속성 IRDI / 클래스 IRDI」를 이어 붙인다 —
 * 예: `0173-1#02-ABI500#003/0173-1#01-AHF579#003`(HandoverDocumentation의 Document.
 * 앞은 속성 `#02`, 뒤는 클래스 `#01`).
 *
 * 🔴 근거: 골든 파일 4종이 **모두** 이 형태를 6건씩 쓰고(Documents·DocumentIds·
 * DocumentClassifications·DocumentVersions… 항목), 같은 id의 CD도 함께 들어 있다.
 * 그중 `01-롤포밍기-공34.aasx`는 **KOSMO Validator 전 항목 Passed**다. 서버 린터도
 * 접두(`0173-`/`0112/`)만 보므로 통과시킨다 — 화면만 "형식이 표준과 다르다"고 경고해
 * 멀쩡한 표준 값에 경고를 띄우고 있었다.
 */
const IRDI_RE = new RegExp(`^${ONE_IRDI}(?:\\/${ONE_IRDI})?$`);

/** 복합형인가 — 안내 문구를 다르게 준다 */
const COMPOUND_IRDI_RE = new RegExp(`^${ONE_IRDI}\\/${ONE_IRDI}$`);

export function checkSemanticId(
  value: string,
  policy: { iriBase: string; irdiPrefixes: string[] },
  hasConceptDescription: boolean,
  /** 서브모델의 semanticId는 템플릿 IRI다 — 화이트리스트(SM-3)는 같지만 CD를 요구하지 않는다 */
  scope: 'element' | 'submodel' = 'element',
  /**
   * 번역기 — 안 주면 한국어 그대로.
   * 🔴 정책값이 섞인 문장이 있어 밖에서 `t(message)`로는 못 옮긴다(허용 목록 안내의 접두 목록).
   *    그래서 만드는 자리에서 옮긴다.
   */
  t: (text: string) => string = (text) => text,
): SemanticIdNote[] {
  const trimmed = value.trim();
  if (trimmed === '') {
    return [
      {
        level: 'error',
        message: t('semanticId가 없으면 {rule} 위반입니다.').replace(
          '{rule}',
          scope === 'submodel' ? 'KOSMO-SM-3' : 'KOSMO-SME-3',
        ),
      },
    ];
  }

  const notes: SemanticIdNote[] = [];
  const isIrdiPrefix = policy.irdiPrefixes.some((prefix) => trimmed.startsWith(prefix));

  if (isIrdiPrefix) {
    if (IRDI_RE.test(trimmed)) {
      notes.push({
        level: 'ok',
        message: COMPOUND_IRDI_RE.test(trimmed)
          ? t('표준 사전 IRDI 복합형입니다 — 「속성/클래스」를 이은 형식으로, IDTA 템플릿이 리스트 항목에 씁니다.')
          : t('표준 사전 IRDI 형식입니다.'),
      });
    } else {
      notes.push({
        level: 'warning',
        message: t('IRDI 접두는 맞지만 형식이 표준과 다릅니다. 사전에서 코드를 다시 확인하십시오.'),
      });
    }
    if (/-00(#|$)/.test(trimmed)) {
      notes.push({
        level: 'warning',
        message: t('eCl@ss 말미 -00 코드는 CDP에 존재하지 않습니다. 리프 클래스까지 전개해 재확인하십시오.'),
      });
    }
  } else if (trimmed.startsWith(`${policy.iriBase}/`)) {
    notes.push({ level: 'ok', message: t('자체 IRI 규약에 맞습니다.') });
  } else if (trimmed.startsWith('https://admin-shell.io/')) {
    notes.push({
      level: 'warning',
      message: t('IDTA 공식 IRI입니다. KOSMO Validator는 이를 거부합니다(규정 충돌 ①).'),
    });
  } else {
    notes.push({
      level: 'error',
      message: t('허용 목록 밖입니다. IRDI({prefixes}) 또는 {base}/... 형식이어야 합니다.')
        .replace('{prefixes}', policy.irdiPrefixes.join(' / '))
        .replace('{base}', policy.iriBase),
    });
  }

  if (!hasConceptDescription && scope === 'element') {
    notes.push({
      level: 'warning',
      message: t('이 id를 가진 ConceptDescription이 파일에 없습니다. 「자동 고치기」가 규약대로 만들어 줍니다.'),
    });
  }
  return notes;
}
