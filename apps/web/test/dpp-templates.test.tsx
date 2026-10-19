// @vitest-environment jsdom
/**
 * Product passport templates on the start screen — the list, the shipped files and the attribution must agree.
 *
 * Three ways this breaks silently: a list entry whose file is not shipped (the click fetches a 404), a shipped file
 * that the list forgets, and a file shipped without its attribution line (CC BY 4.0 requires it).
 */
import { readAasx } from '@aas/aasx';
import { fireEvent, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { dppTemplates } from '../src/app/dppTemplates.js';
import { Welcome } from '../src/app/Welcome.js';
import { tr } from '../src/i18n.js';
import { useScreenHarness } from './harness.js';

useScreenHarness();

// Repository-relative, like the other web tests — import.meta.url is not a file URL under jsdom
const folder = 'apps/web/public/samples/idta/';
const shipped = readdirSync(folder).filter((name) => name.endsWith('.aasx')).sort();

describe('product passport templates', () => {
  it('the list and the shipped files are the same set', () => {
    expect(dppTemplates().map((item) => item.file).sort()).toEqual(shipped);
    expect(shipped).toHaveLength(8);
  });

  it('every shipped file is named in the attribution notice', () => {
    const notice = readFileSync(folder + 'NOTICE.md', 'utf8');
    expect(notice).toContain('CC BY 4.0');
    for (const name of shipped) expect(notice).toContain(name);
  });

  it('every shipped file opens with the current reader — one shell and its submodel, nothing dropped', () => {
    for (const name of shipped) {
      const pkg = readAasx(new Uint8Array(readFileSync(folder + name)));
      expect(pkg.environment.assetAdministrationShells, name).toHaveLength(1);
      expect(pkg.environment.submodels, name).toHaveLength(1);
      expect((pkg.environment.submodels![0]!.submodelElements ?? []).length, name).toBeGreaterThan(0);
    }
  });

  it('the start screen lists them and a click passes the file name on', () => {
    const open = vi.fn();
    const noop = () => undefined;
    render(
      <Welcome
        t={tr}
        lang="ko"
        packages={[]}
        creating={false}
        busy={false}
        onOpenPackage={noop}
        onPickFile={noop}
        onPickBundle={noop}
        onStartNew={noop}
        onCancelNew={noop}
        onOpenSample={noop}
        onOpenDppTemplate={open}
        onImportFile={async () => undefined}
        onCreate={noop}
      />,
    );
    const first = dppTemplates()[0]!;
    fireEvent.click(screen.getByText(first.label));
    expect(open).toHaveBeenCalledWith(first.file);
  });
});
