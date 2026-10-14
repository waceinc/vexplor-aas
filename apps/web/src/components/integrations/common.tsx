/**
 * Small pieces shared by the integration tabs — package picker, copy box, error and "saved elsewhere" notes,
 * and who may do what.
 *
 * Important: the access rules here only decide **what is shown**. The server decides what is allowed (design D11:
 *    subscriptions, status and certificates need an admin session; package rules and external references need edit
 *    rights). A 403 from the server is still shown as is — the screen never pretends an action succeeded.
 */
import { useState } from 'react';
import type { AuthState, PackageDescription } from '../../api.js';
import { describeError } from '../../app/describeError.js';
import { locale, tr } from '../../i18n.js';

export interface Access {
  /** Admin session — subscriptions, deliveries, status, server rules, OPC UA certificates */
  admin: boolean;
  /** May change per-package rules and external references (editor or admin with full level, or an open server) */
  edit: boolean;
}

export function integrationAccess(auth: AuthState | undefined): Access {
  const user = auth?.user;
  if (auth?.demo !== undefined) return { admin: false, edit: false };
  // Open server (no accounts, no token required) — the server lets anyone edit, but subscriptions still need an admin
  if (!user) return { admin: false, edit: auth !== undefined && !auth.authRequired };
  const full = user.level === 'full';
  return { admin: user.role === 'admin' && full, edit: full && (user.role === 'admin' || user.role === 'editor') };
}

export function packageLabel(item: PackageDescription): string {
  return item.assetName ?? item.name ?? item.packageId;
}

export function when(iso: string | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(locale());
}

interface PickerProps {
  packages: readonly PackageDescription[];
  value: string | undefined;
  onChange: (packageId: string | undefined) => void;
  /** Offer "every file" as the first choice (exports and readiness can run across all visible files) */
  allowAll?: boolean;
  label?: string;
}

export function PackagePicker({ packages, value, onChange, allowAll = false, label }: PickerProps): React.JSX.Element {
  return (
    <label className="integration-picker">
      <span>{label ?? tr('파일')}</span>
      <select aria-label={label ?? tr('파일')} value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
        {allowAll ? <option value="">{tr('모든 파일')}</option> : <option value="">{tr('파일 고르기')}</option>}
        {packages.map((item) => (
          <option key={item.packageId} value={item.packageId}>
            {packageLabel(item)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Read-only value with a copy button — feed addresses and secrets */
export function CopyBox({ value, label }: { value: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-box">
      <input readOnly aria-label={label} value={value} onFocus={(event) => event.target.select()} />
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? tr('복사했습니다') : tr('복사')}
      </button>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }): React.JSX.Element | null {
  if (error === undefined) return null;
  return (
    <p className="note error" role="alert">
      {describeError(error)}
    </p>
  );
}

/** 412 — saved elsewhere first. Never overwrite silently: the person reloads and redoes the change */
export function StaleNote({ onReload }: { onReload: () => void }): React.JSX.Element {
  return (
    <p className="note warning" role="alert">
      {tr('다른 곳에서 먼저 저장했습니다. 다시 읽은 뒤 고쳐 주십시오 — 지금 고친 내용은 저장되지 않았습니다.')}{' '}
      <button type="button" onClick={onReload}>
        {tr('다시 읽기')}
      </button>
    </p>
  );
}

/** Comma list ⇄ text (rules, type filters) */
export function splitList(text: string): string[] {
  return [...new Set(text.split(',').map((item) => item.trim()).filter((item) => item !== ''))];
}
