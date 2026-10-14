/**
 * Item lists for the header menus — "File" · "Settings" · "Submodel" · "Export".
 * Split out of App.tsx (componentization, 2026-10-13). The item code is verbatim from before the move, and the state and actions it uses
 * arrive under the same names. Menu look and open/close are handled by components/Menu.tsx.
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { api, currentToken, setToken, type AuthState } from '../api.js';
import type { MenuItem } from '../components/Menu.js';
import { fill, tr, type Lang } from '../i18n.js';
import type { Shell } from '../model.js';
import type { Adding } from './types.js';

type T = (text: string) => string;
type Run = <R>(work: () => Promise<R>) => Promise<R | undefined>;

export interface FileMenuContext {
  t: T;
  busy: boolean;
  demoLocked: boolean;
  packages: readonly unknown[];
  fileInput: RefObject<HTMLInputElement | null>;
  bundleInput: RefObject<HTMLInputElement | null>;
  setAdding: (next: Adding | undefined) => void;
  setFilesOpen: Dispatch<SetStateAction<boolean>>;
  setPickedFiles: (next: ReadonlySet<string>) => void;
  onOpenSample: () => Promise<void>;
}

export function fileMenuItems({ t, busy, demoLocked, packages, fileInput, bundleInput, setAdding, setFilesOpen, setPickedFiles, onOpenSample }: FileMenuContext): MenuItem[] {
  return [
    {
      label: t('AASX 열기'),
      title: tr('이 PC의 .aasx 파일을 올려 엽니다'),
      onClick: () => fileInput.current?.click(),
      disabled: busy,
    },
    {
      label: t('새로 만들기'),
      title: tr('빈 설비 또는 회사·공정 묶음을 새로 만듭니다'),
      onClick: () => setAdding('new'),
      disabled: busy,
    },
    {
      label: t('번들 열기'),
      title: tr('이 도구로 내보낸 레퍼런스 번들(.zip)을 엽니다 — 공정과 설비가 한 번에 올라옵니다'),
      onClick: () => bundleInput.current?.click(),
      disabled: busy,
    },
    {
      // If this lived only on the start screen it could not be reopened once any file exists — it is also the way to restore a deleted sample
      label: demoLocked ? `🔒 ${t('견본 열기')}` : t('견본 열기'),
      title: tr('다 채워진 설비 1종과 공정 구성을 열어 둘러봅니다 — 고쳐도 되는 연습용입니다'),
      onClick: () => void onOpenSample(),
      disabled: busy,
    },
    {
      label: t('파일 목록'),
      title: tr('올려 둔 파일을 한눈에 보고 지웁니다'),
      onClick: () => {
        setFilesOpen((current) => !current);
        setPickedFiles(new Set());
      },
      disabled: busy || packages.length === 0,
      separated: true,
    },
  ];
}

export interface SettingsMenuContext {
  t: T;
  busy: boolean;
  lang: Lang;
  auth: AuthState | undefined;
  demoLocked: boolean;
  theme: { dark: boolean; toggle: () => void };
  bootstrap: () => Promise<void>;
  setShowSettings: (open: boolean) => void;
  setStartAccounts: (open: boolean) => void;
  setShowAccounts: (mode: 'mine' | 'people' | undefined) => void;
  setConfirmQuit: (open: boolean) => void;
  setShowRules: (open: boolean) => void;
  setShowIntegrations: (open: boolean) => void;
}

export function settingsMenuItems({ t, busy, lang, auth, demoLocked, theme, bootstrap, setShowSettings, setStartAccounts, setShowAccounts, setConfirmQuit, setShowRules, setShowIntegrations }: SettingsMenuContext): MenuItem[] {
  return [
    {
      label: fill(tr('언어 — {0}'), { 0: lang === 'en' ? 'English' : tr('한국어') }),
      title: tr('화면 글자의 언어를 고릅니다'),
      onClick: () => setShowSettings(true),
    },
    {
      label: theme.dark ? t('밝은 화면으로') : t('어두운 화면으로'),
      title: tr('화면 색을 밝게 · 어둡게 바꿉니다 — 이 브라우저에 기억합니다'),
      onClick: theme.toggle,
    },
    // Viewing with the demo account — creating your own account enables downloads
    ...(auth?.demo !== undefined && auth.signupAllowed === true
      ? [
          {
            label: t('회원가입'),
            title: t('계정을 만들면 작업한 파일을 내려받을 수 있습니다.'),
            onClick: () => setStartAccounts(true),
            separated: true,
          },
        ]
      : []),
    // Server not yet using accounts — start here
    ...(auth?.setupNeeded && !auth.authenticated
      ? [
          {
            label: t('첫 관리자 만들기'),
            title: t('계정과 로그인을 쓰기 시작합니다 — 지금은 누구나 들어올 수 있습니다'),
            onClick: () => setStartAccounts(true),
            separated: true,
          },
        ]
      : []),
    // Account — Important: not shown for the demo account (a shared entry point used by many, so it cannot be changed)
    //    Admins see "Manage accounts" (people) and "My account settings" (their own) separately (2026-10-08)
    ...(auth?.user && auth.demo === undefined
      ? [
          ...(auth.user.role === 'admin'
            ? [
                {
                  label: t('계정 관리'),
                  title: t('사람을 더하고, 역할을 바꾸고, 잠급니다'),
                  onClick: () => setShowAccounts('people'),
                  separated: true,
                },
              ]
            : []),
          {
            label: t('내 계정 설정'),
            title: t('내 이름 · 회사명 · 이메일 · 비밀번호를 바꿉니다'),
            onClick: () => setShowAccounts('mine'),
            separated: auth.user.role !== 'admin',
          },
        ]
      : []),
    // Signed-in user — name and sign-out in the same place
    ...(auth?.user
      ? [
          {
            label: `${demoLocked ? t('데모 계정') : auth.user.displayName} · ${t('로그아웃')}`,
            title: tr('이 브라우저의 로그인을 끝냅니다'),
            onClick: () => {
              void api
                .logout()
                .catch(() => undefined)
                .then(() => bootstrap());
            },
            separated: true,
          },
        ]
      : []),
    /*
     * Delete account — Important: hidden for the demo account (it is shared, so the server refuses too).
     * Irreversible, so ask once. Even after deletion **who made each change remains** —
     * that name is a copy taken at the time, not a reference to the users table.
     */
    ...(auth?.user && auth.demo === undefined
      ? [
          {
            label: t('탈퇴 — 계정 지우기'),
            title: t('이 계정을 지웁니다. 되돌릴 수 없습니다.'),
            onClick: () => setConfirmQuit(true),
          },
        ]
      : []),
    /*
     * Integrations — admins set up subscriptions and rules; everyone else gets the feed address and exports.
     * Important: hidden for the demo account — integrations are off in demo mode and the window would only say so.
     */
    ...(auth?.demo === undefined
      ? [
          {
            label: t('연동 (MES · ERP · CMMS)'),
            title: tr('MES · ERP · CMMS 가 이 도구의 설비 정보와 가동 사건을 받아 가게 설정합니다'),
            onClick: () => setShowIntegrations(true),
            separated: true,
          },
        ]
      : []),
    {
      label: t('규칙과 규약 보기'),
      title: tr('이 도구가 지키는 규칙 43종과 규약을 지금 도는 그대로 보여 줍니다'),
      onClick: () => setShowRules(true),
      disabled: busy,
      separated: true,
    },
    ...(currentToken() !== undefined
      ? [
          {
            label: t('토큰 지우기'),
            title: tr('이 브라우저에 저장된 접근 토큰을 지웁니다 — 공용 PC에서 자리를 뜰 때'),
            onClick: () => {
              setToken(undefined);
              void bootstrap(); // The token is gone, so the server will ask again
            },
          },
        ]
      : []),
  ];
}

export interface SubmodelMenuContext {
  t: T;
  busy: boolean;
  shell: Shell | undefined;
  setAdding: (next: Adding | undefined) => void;
}

export function submodelMenuItems({ t, busy, shell, setAdding }: SubmodelMenuContext): MenuItem[] {
  return [
    {
      label: t('서브모델 추가'),
      title: tr('이 설비에 새 서브모델을 만듭니다 — id는 규약대로 지어집니다'),
      onClick: () => setAdding('submodel'),
      disabled: busy || !shell,
    },
    {
      label: t('다른 파일에서 가져오기'),
      title: tr('다른 AASX의 서브모델을 통째로 복사합니다 — 용어(CD)도 함께 옵니다'),
      onClick: () => setAdding('import'),
      disabled: busy,
    },
  ];
}

export interface ExportMenuContext {
  t: T;
  busy: boolean;
  packageId: string;
  fileUnit: 'equipment' | 'composite';
  run: Run;
  setAdding: (next: Adding | undefined) => void;
}

export function exportMenuItems({ t, busy, packageId, fileUnit, run, setAdding }: ExportMenuContext): MenuItem[] {
  return [
    {
      label: t('검증 결과서'),
      title: tr('검사 결과를 인쇄용으로 엽니다 — 인쇄하면 그대로 PDF로 저장할 수 있습니다'),
      onClick: () => void run(() => api.openReport(packageId)),
    },
    {
      label: t('문서용 자료'),
      title: tr('가이던스에 붙일 UML 그림과 표를 뽑습니다'),
      onClick: () => setAdding('docs'),
      disabled: busy,
    },
    ...(fileUnit === 'composite'
      ? [
          {
            label: t('레퍼런스 번들'),
            title: tr('이 공정을 ZIP 묶음으로 봅니다 — 구성·준비 상태·데이터 연계'),
            onClick: () => setAdding('bundle'),
            disabled: busy,
            separated: true,
          },
        ]
      : []),
  ];
}
