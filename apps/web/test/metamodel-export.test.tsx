// @vitest-environment jsdom
/**
 * Metamodel versions on screen (2026-10-19) — the assetKind choices follow the file's version, and the download window
 * shows what a version drops, refuses or renames before the file is made.
 */
import { readAasx, writeAasx } from '@aas/aasx';
import type { Environment } from '@aas/core';
import { InMemoryStore } from '@aas/store';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ExportDialog } from '../src/components/ExportDialog.js';
import { AssetInfoEditor } from '../src/components/inspector/AssetInfoEditor.js';
import { attachedName } from '../src/components/inspector/helpers.js';
import { useScreenHarness, wireFetch } from './harness.js';

useScreenHarness();

// Repository-relative, like the other web tests — import.meta.url is not a file URL under jsdom
const GOLDEN = 'tests/fixtures/01-roll-forming-machine.aasx';
const t = (text: string): string => text;

function options(): string[] {
  return within(screen.getByLabelText('assetKind')).getAllByRole('option').map((o) => o.textContent ?? '');
}

describe('assetKind choices come from the version of the file', () => {
  const editor = (metamodel: '3.0' | '3.1' | '3.2', assetKind = 'Type') =>
    render(<AssetInfoEditor raw={{ assetKind, globalAssetId: 'urn:x' }} busy={false} onSaveAssetInformation={() => undefined} metamodel={metamodel} t={t} />);

  it('3.0 offers the three 3.0 values; 3.1 adds Role; 3.2 adds Batch', () => {
    const first = editor('3.0');
    expect(options()).toEqual(['Type', 'Instance', 'NotApplicable']);
    first.unmount();
    const second = editor('3.1');
    expect(options()).toEqual(['Type', 'Instance', 'NotApplicable', 'Role']);
    second.unmount();
    editor('3.2');
    expect(options()).toEqual(['Type', 'Instance', 'NotApplicable', 'Role', 'Batch']);
  });

  it('a value the version does not have is kept selectable and explained, never changed silently', () => {
    editor('3.1', 'Batch');
    expect(options()).toContain('Batch');
    expect((screen.getByLabelText('assetKind') as HTMLSelectElement).value).toBe('Batch');
    expect(screen.getByText(/assetKind Batch은\(는\) V3\.1에 없는 값입니다/)).toBeTruthy();
  });
});

describe('attachment names', () => {
  it('a percent-encoded name (V3.1 / V3.2 file) shows as the name a person wrote', () => {
    expect(attachedName({ value: 'file:///%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C.pdf' })).toBe('설치 설명서.pdf');
    expect(attachedName({ value: 'file:///plain.pdf' })).toBe('plain.pdf');
    expect(attachedName({ value: '/x/100%.pdf' })).toBe('100%.pdf');
  });
});

describe('download window', () => {
  async function stored(edit: (env: Environment) => void, extra: { part: string } | undefined = undefined): Promise<string> {
    const store = new InMemoryStore();
    await store.init();
    wireFetch(store);
    const pkg = readAasx(new Uint8Array(readFileSync(GOLDEN)));
    const environment = JSON.parse(JSON.stringify(pkg.environment)) as Environment;
    edit(environment);
    const files = extra ? [{ part: extra.part, contentType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }] : [];
    const record = await store.importPackage({ name: 'x.aasx', package: readAasx(writeAasx({ ...pkg, environment, supplementaryFiles: files })) });
    return record.id;
  }

  it('defaults to the file’s version; a lower version shows what blocks it, and only an explicit keep downloads it', async () => {
    const packageId = await stored((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Role';
    });
    const download = vi.fn(async () => undefined);
    render(<ExportDialog packageId={packageId} stored={{ version: '3.1', inferred: true }} busy={false} onDownload={download} onClose={() => undefined} />);

    expect((screen.getByRole('radio', { name: /V3\.1/ }) as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByText('V3.1으로 써도 빠지거나 바뀌는 것이 없습니다.')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /V3\.0/ }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/V3\.0으로 쓸 수 없는 값이 1건/)).toBeTruthy();
    expect(within(alert).getByText('/assetAdministrationShells/0/assetInformation/assetKind')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'V3.0으로 내려받기' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(within(alert).getByRole('checkbox'));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(download).toHaveBeenCalledWith({ metamodel: '3.0', keep: true });
  });

  it('3.1 lists the attachment names it percent-encodes, shown as written', async () => {
    const packageId = await stored(
      (env) => {
        const submodel = env.submodels![1]! as unknown as { submodelElements: Record<string, unknown>[] };
        submodel.submodelElements.push({ modelType: 'File', idShort: 'Manual', contentType: 'application/pdf', value: 'file:///설치 설명서.pdf' });
      },
      { part: '/설치 설명서.pdf' },
    );
    render(<ExportDialog packageId={packageId} stored={{ version: '3.0', inferred: true }} busy={false} onDownload={async () => undefined} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('radio', { name: /V3\.1/ }));
    expect(await screen.findByText(/파일 이름 1건을 퍼센트 인코딩/)).toBeTruthy();
    expect(screen.getByText('file:///%EC%84%A4%EC%B9%98%20%EC%84%A4%EB%AA%85%EC%84%9C.pdf')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'V3.1으로 내려받기' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
