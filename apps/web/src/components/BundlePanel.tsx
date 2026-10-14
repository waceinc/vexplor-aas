/**
 * 레퍼런스 번들 — 공정 파일 하나를 「제출 꾸러미 한 벌」로 보는 화면.
 *
 * 평가자가 묻는 세 가지에 한 화면으로 답한다(레퍼런스번들_추진방안 §2.3).
 *  ① 무엇이 들었나 — 공정 → 설비 구성과 설비마다 파일·버전·사전 점검
 *  ② 이어지나 — 공정 KPI의 재료(운전 데이터)를 설비들이 함께 갖고 있는가 (공통 항목 매트릭스)
 *  ③ 믿을 수 있나 — 내보낼 때 파일마다 SHA256을 manifest에 박는다
 * 그리고 두 가지를 더 지킨다(2026-09-30 검증 후 보완).
 *  ④ 시연 대신 — 수집 기록(실동작 증빙)을 싣고, 번들을 다시 열어도 이어받는다
 *  ⑤ 사람이 넣은 문서 — 여기서 올린 Use-Case·가이던스·참고 자료는 번들을 열었다 다시 내보내도 남는다
 *
 * 🔴 도구가 문서를 쓰지 않는다. 동의어도 추측하지 않는다 — semanticId가 같은데 이름이 다르거나,
 *    이름이 같은데 semanticId가 다르면 「확인할 점」으로 보여 주고 판단은 사람이 한다.
 * 🔴 KOSMO Validator는 **장비별 AASX를 만들 때** 받는 검증이다 — 번들에는 공식 검증기가 없다(추진방안 §2.3).
 *    여기 ✓는 번들에 넣은 모델을 이 도구가 다시 확인한 참고 표시다. 「번들도 Validator로 판정받는다」처럼
 *    읽히게 쓰지 않는다(사용자 2026-09-30 지적).
 *
 * 2026-10-13 컴포넌트화 — 구역마다 bundle/ 의 부품으로 나눴다. 여기는 번들을 읽고 숫자를 모으고 구역을 놓는다.
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog.js';
import { api, type BundleView } from '../api.js';
import { tr } from '../i18n.js';
import { T } from './T.js';
import { AttachmentSection } from './bundle/AttachmentSection.js';
import { BundleFindings } from './bundle/BundleFindings.js';
import { BundleForm } from './bundle/BundleForm.js';
import { BundleMembers } from './bundle/BundleMembers.js';
import { BundleStats } from './bundle/BundleStats.js';
import { EvidenceSection } from './bundle/EvidenceSection.js';
import { LinkageMatrix } from './bundle/LinkageMatrix.js';

interface Props {
  packageId: string;
  onOpenPackage: (packageId: string) => void;
  onClose: () => void;
}

export function BundlePanel({ packageId, onOpenPackage, onClose }: Props): React.JSX.Element {
  const [view, setView] = useState<BundleView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('RB01');
  const [title, setTitle] = useState('');
  const [version, setVersion] = useState('1.0.0');
  /** 증빙 수준 — auto면 서버가 제안(시뮬레이션뿐일 때만 C) */
  const [evidenceLevel, setEvidenceLevel] = useState('auto');
  /** 증빙 기간 — 비우면 전부. 시험하며 쌓인 잡음을 뺄 때 */
  const [evidenceMinutes, setEvidenceMinutes] = useState('');
  /** 첨부를 올리거나 지운 뒤 다시 읽는다 */
  const [tick, setTick] = useState(0);
  /** 매트릭스의 강조 줄 — 확인할 점 목록에 마우스를 올려도 같은 줄이 강조된다 */
  const [focus, setFocus] = useState<string>();

  useEffect(() => {
    let alive = true;
    api
      .bundle(packageId, evidenceMinutes)
      .then((result) => alive && setView(result))
      .catch((reason: Error) => alive && setError(reason.message));
    return () => {
      alive = false;
    };
  }, [packageId, evidenceMinutes, tick]);

  if (error) {
    return (
      <Dialog label={tr('레퍼런스 번들')} onClose={onClose} close={{ text: tr('닫기') }}>
        <div className="bundle-body">
          <h2>{tr('레퍼런스 번들')}</h2>
          <p className="error-text">{error}</p>
        </div>
      </Dialog>
    );
  }

  const members = view?.members ?? [];
  const ready = members.filter((m) => m.packageId);
  const planned = members.filter((m) => !m.packageId);
  const failing = ready.filter((m) => m.lint && !m.lint.passed);
  const common = (view?.linkage.items ?? []).filter((item) => item.coverage >= 2).length;
  const warnings = (view?.linkage.findings ?? []).filter((f) => f.severity === 'warning').length;
  const category = view?.categories[code] ?? '';
  const demos = ready.filter((m) => m.demo);
  const evidence = view?.evidence;
  const carried = (evidence?.sources.length ?? 0) === 0 ? evidence?.carried : undefined;
  const shownSources = (evidence?.sources.length ?? 0) > 0 ? evidence!.sources : (carried?.entries ?? []);
  const samples = shownSources.reduce((sum, source) => sum + source.samples, 0);
  const effectiveLevel =
    evidenceLevel === 'auto'
      ? (evidence?.suggested ?? carried?.level ?? null)
      : evidenceLevel === 'none'
        ? null
        : evidenceLevel;
  const aasd120 = ready.reduce((sum, m) => sum + (m.lint?.aasd120 ?? 0), 0);

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.downloadBundle(packageId, {
        code,
        title: title.trim() || category,
        version,
        evidence: evidenceLevel,
        evidenceMinutes,
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog className="wide" label={tr('레퍼런스 번들')} onClose={onClose} close={{ text: tr('닫기') }}>
      <div className="bundle-body">
        <h2><T k={'레퍼런스 번들 {0}'} v={[<span className="dim">— {view?.process.name ?? tr('읽는 중…')}</span>]} />
        </h2>

        {/* 내보내기 — 한 화면에 파란 버튼은 하나 */}
        <BundleForm
          view={view}
          busy={busy}
          readyCount={ready.length}
          code={code}
          setCode={setCode}
          title={title}
          setTitle={setTitle}
          category={category}
          version={version}
          setVersion={setVersion}
          evidenceLevel={evidenceLevel}
          setEvidenceLevel={setEvidenceLevel}
          evidenceMinutes={evidenceMinutes}
          setEvidenceMinutes={setEvidenceMinutes}
          onExport={onExport}
        />

        {demos.length > 0 && (
          <p className="bundle-demo-note"><T k={'⚡ <b>시연본 {0}대 포함</b> — 수집 연결(AID)이 붙어 있습니다. 시연용으로는 맞지만,<b> 정식 번들</b>에는 연결이 없는 원본 참조모델을 넣으십시오. 내보내면 README와 manifest에도 표시됩니다.'} v={[demos.length]} /></p>
        )}

        {/* 한눈에 — 숫자 다섯 */}
        <BundleStats
          members={members.length}
          ready={ready.length}
          planned={planned.length}
          failing={failing.length}
          aasd120={aasd120}
          common={common}
          warnings={warnings}
          samples={samples}
          carried={carried !== undefined}
          effectiveLevel={effectiveLevel}
        />

        <BundleMembers view={view} members={members} onOpenPackage={onOpenPackage} />
        <LinkageMatrix view={view} common={common} focus={focus} setFocus={setFocus} />
        <EvidenceSection shownSources={shownSources} carried={carried} />
        <AttachmentSection packageId={packageId} view={view} onChanged={() => setTick((n) => n + 1)} />
        <BundleFindings view={view} setFocus={setFocus} />

        <p className="dim small bundle-foot"><T k={'내보낸 ZIP: <code>00_공정구성 · 01_UseCase문서 · 02_참조모델 · 03_가이던스 · 04_데이터연계정의 · 05_샘플데이터 · 06_검증결과</code>+ <code>bundle-manifest.json</code>(파일마다 SHA256) + <code>README.md</code>. 문서는 작성 안내만 들어갑니다.<br/>✓ 사전 점검은 번들에 넣은 모델을 이 도구가 <b>다시 확인한 참고 표시</b>입니다. 모델의 공식 검증(KOSMO Validator)은 장비별 AASX를 만들 때 받는 것이라 번들에서 따로 하지 않습니다 — 번들 자체의 확인은 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 합니다.'} /></p>
      </div>
    </Dialog>
  );
}
