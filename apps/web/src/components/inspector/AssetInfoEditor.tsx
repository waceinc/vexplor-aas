/**
 * AssetInformation editing — assetKind · globalAssetId · main photo.
 * Split out of components/Inspector.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 * Values being typed are this part's state. When moving to another element or when a save changes the content, Inspector changes
 * the key and redraws it, so it returns to the initial values (same result as the old "reset when the fingerprint changes").
 */
import { useState } from 'react';
import { ASSET_KINDS_BY_VERSION } from '@aas/core';
import type { MetamodelVersion } from '../../api.js';
import { fill, tr } from '../../i18n.js';

interface Props {
  raw: Record<string, unknown>;
  busy: boolean;
  onSaveAssetInformation: (info: Record<string, unknown>) => void;
  onUploadThumbnail?: (file: File) => void;
  /** Metamodel version of the file — decides which assetKind values exist (Role from 3.1, Batch from 3.2). Default 3.0 */
  metamodel?: MetamodelVersion;
  t: (text: string) => string;
}

export function AssetInfoEditor({ raw, busy, onSaveAssetInformation, onUploadThumbnail, metamodel = '3.0', t }: Props): React.JSX.Element {
  const [asset, setAsset] = useState<{ assetKind: string; globalAssetId: string }>({
    assetKind: String(raw['assetKind'] ?? 'Type'),
    globalAssetId: String(raw['globalAssetId'] ?? ''),
  });
  // Important: the choices come from the version table of the core, not a list written here — a hand-written list
  //    offered 3.0 values only and hid Role · Batch from 3.1 / 3.2 files (spec difference table, item 7).
  //    A value the file already holds stays selectable even if its version does not allow it, so opening the editor
  //    never changes it silently — the note below says why it will not download as that version.
  const allowed = ASSET_KINDS_BY_VERSION[metamodel];
  const stored = String(raw['assetKind'] ?? '');
  const kinds = stored !== '' && !allowed.includes(stored) ? [...allowed, stored] : allowed;
  return (
    <div className="editor">
      {/* KOSMO-AAS-6 requires Type and AAS-5 requires globalAssetId. A way to fix them directly, other than "Auto fix" */}
      <label className="stack">
        assetKind
        <select
          value={asset.assetKind}
          aria-label="assetKind"
          onChange={(event) => setAsset({ ...asset, assetKind: event.target.value })}
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      {!allowed.includes(asset.assetKind) && (
        <p className="note warning">
          {fill(tr('assetKind {0}은(는) V{1}에 없는 값입니다 — 이 판으로 내려받으면 막힙니다. 더 높은 판으로 내려받거나 값을 바꾸십시오.'), { 0: asset.assetKind, 1: metamodel })}
        </p>
      )}
      {asset.assetKind !== 'Type' && (
        <p className="note warning">{t('본 사업 산출물은 형식(Type) 단위입니다(KOSMO-AAS-6).')}</p>
      )}
      <label className="stack">
        globalAssetId
        <input
          value={asset.globalAssetId}
          aria-label="globalAssetId"
          className="mono"
          onChange={(event) => setAsset({ ...asset, globalAssetId: event.target.value })}
        />
      </label>
      {onUploadThumbnail && (
        <label className="stack">
          {t('대표 사진 (defaultThumbnail)')}
          <span className="note">
            {String((raw['defaultThumbnail'] as { path?: string } | undefined)?.path ?? tr('없음'))}
            {(raw['defaultThumbnail'] as { path?: string } | undefined)?.path ===
              '/thumbnail.png' && tr(' — 임시 그림입니다. 실제 장비 사진으로 바꾸십시오')}
          </span>
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUploadThumbnail(file);
              event.target.value = '';
            }}
          />
        </label>
      )}
      <button
        className="primary"
        disabled={busy}
        title={t('자산 정보(종류·globalAssetId)를 반영합니다 — 묶음에서 설비를 가리키는 주소가 이것입니다')}
        onClick={() => {
          // Spreading the original on top **brings deleted values back.** Deleting requires removing the key
          const next = { ...raw } as Record<string, unknown>;
          next['assetKind'] = asset.assetKind;
          if (asset.globalAssetId.trim() === '') delete next['globalAssetId'];
          else next['globalAssetId'] = asset.globalAssetId.trim();
          onSaveAssetInformation(next);
        }}
      >
        {t('저장')}
      </button>
    </div>
  );
}
