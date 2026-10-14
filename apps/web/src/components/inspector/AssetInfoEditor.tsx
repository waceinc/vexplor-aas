/**
 * AssetInformation 편집 — assetKind · globalAssetId · 대표 사진.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 * 입력 중인 값은 이 부품의 상태다. 다른 요소로 옮기거나 저장으로 내용이 바뀌면 Inspector 가 key 를 바꿔
 * 새로 그리므로 처음 값으로 돌아간다(예전 「지문이 바뀌면 초기화」 효과와 같은 결과).
 */
import { useState } from 'react';
import { tr } from '../../i18n.js';

interface Props {
  raw: Record<string, unknown>;
  busy: boolean;
  onSaveAssetInformation: (info: Record<string, unknown>) => void;
  onUploadThumbnail?: (file: File) => void;
  t: (text: string) => string;
}

export function AssetInfoEditor({ raw, busy, onSaveAssetInformation, onUploadThumbnail, t }: Props): React.JSX.Element {
  const [asset, setAsset] = useState<{ assetKind: string; globalAssetId: string }>({
    assetKind: String(raw['assetKind'] ?? 'Type'),
    globalAssetId: String(raw['globalAssetId'] ?? ''),
  });
  return (
    <div className="editor">
      {/* KOSMO-AAS-6은 Type을, AAS-5는 globalAssetId를 요구한다. 「자동 고치기」 말고 직접 고칠 길 */}
      <label className="stack">
        assetKind
        <select
          value={asset.assetKind}
          aria-label="assetKind"
          onChange={(event) => setAsset({ ...asset, assetKind: event.target.value })}
        >
          {['Type', 'Instance', 'NotApplicable'].map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
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
          // 스프레드로 원본을 얹으면 **지운 값이 되살아난다.** 키를 지워야 지워진다
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
