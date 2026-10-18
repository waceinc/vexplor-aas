// @vitest-environment jsdom
/**
 * Authoring UI integration tests.
 *
 * We do not mock the screen in isolation — fetch is wired to the **real API handler** (@aas/api + in-memory store + linter)
 * and run end to end, so it is verified that "click a finding and that element opens" actually holds.
 */
import { readAasx } from '@aas/aasx';
import { createApi } from '@aas/api';
import { InMemoryStore } from '@aas/store';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { currentToken, setToken } from '../src/api.js';

/**
 * Important: raise **both** wait budgets. Raising only one does not fix it (measured 2026-10-02).
 *
 * This file does not just mock the screen; it runs the **real API, linter and store** together.
 * When the whole suite (50-odd files) ran at once, CPU sharing occasionally pushed a test past
 * the default 1 s and it failed — a problem with the measurement, not the product.
 *
 * At first only `asyncUtilTimeout` was raised from 1 s to 5 s, but **the per-test timeout
 * happened to be 5 s too (vitest default)**, so "not found within 1 s" merely turned into
 * "whole test timed out at 5 s". The wait must be **comfortably smaller** than the test budget —
 * only then does a failure tell you "what could not be found".
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
configure({ asyncUtilTimeout: 5000 });

// Under jsdom import.meta.url is an http URL, so no file path can be built from it. Use a path relative to the repo root
const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-roll-forming-machine.aasx'));

/** Missing in jsdom. The tree only uses it to measure the window height */
class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

async function mountApi(
  damage?: (env: ReturnType<typeof readAasx>['environment']) => void,
  options: { extraPackage?: boolean; aid?: boolean; auth?: { tokens: string[]; readOnlyTokens: string[] }; nameplateTemplate?: readonly string[] } = {},
) {
  const store = new InMemoryStore();
  await store.init();
  const pkg = readAasx(goldenBytes);
  damage?.(pkg.environment);
  if (options.aid) pkg.environment.submodels!.push(aidSubmodel() as never);
  await store.importPackage({ name: '01-롤포밍기.aasx', package: pkg });

  // Mimics an IDTA template — the nameplate submodel switched to kind=Template + cardinality (One only for names given as required)
  if (options.nameplateTemplate) {
    const tpl = readAasx(goldenBytes);
    const nameplate = structuredClone(tpl.environment.submodels!.find((sm) => sm.idShort === 'DigitalNameplate')!) as unknown as Record<string, unknown>;
    nameplate['kind'] = 'Template';
    nameplate['id'] = `${String(nameplate['id'])}/template`;
    for (const element of (nameplate['submodelElements'] ?? []) as Record<string, unknown>[]) {
      element['qualifiers'] = [
        { type: 'SMT/Cardinality', valueType: 'xs:string', value: options.nameplateTemplate.includes(String(element['idShort'])) ? 'One' : 'ZeroToOne' },
      ];
    }
    tpl.environment.submodels = [nameplate as never];
    tpl.environment.assetAdministrationShells![0]!.submodels = [];
    await store.importPackage({ name: 'IDTA_Nameplate_template.aasx', package: tpl });
  }

  // For the import test — a new piece of equipment with no submodels
  if (options.extraPackage) {
    const bare = readAasx(goldenBytes);
    bare.environment.assetAdministrationShells![0]!.idShort = 'NewMachine';
    bare.environment.assetAdministrationShells![0]!.submodels = [];
    bare.environment.submodels = [];
    bare.environment.conceptDescriptions = [];
    await store.importPackage({ name: '새장비.aasx', package: bare });
  }

  const handle = createApi(store, {
    ...(options.auth ? { auth: options.auth } : {}),
    // Fake collection adapter — the real OPC UA round trip is covered by packages/opcua
    openReader: async (descriptor) => ({
      base: descriptor.base ?? '',
      read: async (sources) =>
        sources.map((source) => ({
          source,
          value: source.includes('Alarm') ? false : 1310.75,
          quality: 'Good',
          observedAt: '2026-08-24T00:00:00.000Z',
        })),
      close: async () => {},
    }),
    // Fake equipment browse — the real protocol round trip is covered by packages/opcua/test/browse.test.ts
    browseDevice: async (endpoint: string) => ({
      endpoint,
      truncated: false,
      nodes: [
        {
          nodeId: 'ns=1;s=Machine.MotorSpeed',
          name: 'MotorSpeed',
          path: 'Machine > MotorSpeed',
          type: 'float',
          value: '1200.5',
        },
        // A tag containing characters not allowed in element names — must be converted when added
        {
          nodeId: 'ns=1;s=Machine.Alarm-Active',
          name: 'Alarm-Active',
          path: 'Machine > Alarm-Active',
          type: 'boolean',
          value: 'false',
        },
      ],
    }),
  });

  /**
   * Cookie jar — mimics what the browser does on its own. Without it, requests after login
   * go out as logged-out, so screens **behind** login (account management etc.) cannot be tested.
   */
  let cookie: string | undefined;
  const install = (): void => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const query: Record<string, string> = {};
    const queryAll: Record<string, string[]> = {};
    for (const [key, value] of url.searchParams) {
      query[key] = value;
      queryAll[key] = [...(queryAll[key] ?? []), value];
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    if (cookie) headers['cookie'] = cookie;

    let body: unknown;
    if (init?.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
    else if (typeof init?.body === 'string') {
      body = headers['content-type']?.includes('json') ? JSON.parse(init.body) : init.body;
    }

    const response = await handle({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query,
      queryAll,
      headers,
      ...(body === undefined ? {} : { body }),
    });

    const issued = response.headers?.['set-cookie'];
    if (issued) cookie = issued.includes('Max-Age=0') ? undefined : issued.split(';')[0];

    const payload =
      response.body instanceof Uint8Array
        ? response.body
        : response.body === undefined
          ? null
          : JSON.stringify(response.body);
    return new Response(response.status === 204 ? null : (payload as BodyInit | null), {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;
  };
  install();
  // To simulate concurrent editing, the test must be able to touch the store directly
  return store;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  // jsdom computes no layout, so height is 0. The virtual scroller cannot find its window, so give it a height
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 900, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The findings list is a **popup** (2026-09-01) — the right pane is used by collection (OPC UA).
 * The list opens only after clicking the "N violations" badge in the header.
 */
async function openFindings(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /위반 \d+건/ }));
}

/** In the bundle-creation screen, add the first candidate file directly under the company — tree mode (2026-09-08) */
/**
 * Clicks an item inside a header menu.
 *
 * Important: on 2026-10-02 the header was collapsed into grouped menus — "New", "File list", "Rules" and the like
 *    moved into "File▾" and "Settings▾". The test takes the same path a person does: open the menu, then pick.
 */
function clickMenuItem(menu: string, item: string): void {
  const header = document.querySelector('header') as HTMLElement;
  fireEvent.click(within(header).getByRole('button', { name: new RegExp(`^${menu}`) }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

function addFirstCandidate(parts: HTMLElement): void {
  fireEvent.click(within(parts).getAllByRole('button', { name: '＋ 설비' })[0]!);
  const select = parts.querySelector('.build-adder select') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: select.options[1]!.value } });
  fireEvent.click(within(parts).getByRole('button', { name: '넣기' }));
}

describe('Authoring UI', () => {
  it('opening a file shows the tree and lint results together', async () => {
    await mountApi();
    render(<App />);

    expect(await screen.findByText('DigitalNameplate')).toBeTruthy();
    expect(screen.getByText('OperationalData')).toBeTruthy();
    // The golden file has 0 violations (checked via the header badge — the findings pane title uses the same wording)
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });

  it('clicking a finding opens that element in the tree and shows it in the property pane', async () => {
    // Remove the first Property's semanticId to trigger KOSMO-SME-3
    await mountApi((env) => {
      const target = env.submodels![0]!.submodelElements![0]!;
      delete (target as { semanticId?: unknown }).semanticId;
    });
    render(<App />);

    await openFindings();
    const finding = await screen.findByText('semanticId가 없습니다.');
    fireEvent.click(finding);

    // The property pane switches to that element — proof that findings and tree share one coordinate system
    const inspector = document.querySelector('.inspector') as HTMLElement;
    await waitFor(() => {
      expect(within(inspector).getByRole('heading').textContent).toBe('URIOfTheProduct');
    });
    expect(within(inspector).getByText('/submodels/0/submodelElements/0')).toBeTruthy();
  });

  it('clicking an AAS finding opens AssetInformation — previously it had nowhere to go', async () => {
    await mountApi((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    });
    render(<App />);

    await openFindings();
    fireEvent.click(await screen.findByText(/assetKind가 Type이 아닙니다/));

    const inspector = document.querySelector('.inspector') as HTMLElement;
    await waitFor(() => {
      expect(within(inspector).getByRole('heading').textContent).toBe('AssetInformation');
    });
    // The value the finding points at is visible on screen (in both the select box and the description list)
    expect(within(inspector).getAllByText('Instance').length).toBeGreaterThan(0);
  });

  it('CD findings also open in the tree — under the ConceptDescription group', async () => {
    await mountApi();
    render(<App />);

    // Known warning in the golden file (duplicate CD idShort) — the same rule (KOSMO-CD-5) is folded into one group.
    // Click the target inside the group (ManufacturerName) to jump to that element
    await openFindings();
    const findingsPanel = document.querySelector('.findings') as HTMLElement;
    await waitFor(() => expect(within(findingsPanel).getByText('KOSMO-CD-5')).toBeTruthy());
    fireEvent.click(within(findingsPanel).getAllByText('ManufacturerName')[0]!);

    const inspector = document.querySelector('.inspector') as HTMLElement;
    await waitFor(() => {
      expect(within(inspector).getByRole('heading').textContent).toBe('ManufacturerName');
    });
    expect(within(inspector).getByText(/\/conceptDescriptions\//)).toBeTruthy();
  });

  it('editing a term (CD) definition on screen and saving shows it again via the server', async () => {
    await mountApi();
    render(<App />);
    await openFindings();
    const findingsPanel = document.querySelector('.findings') as HTMLElement;
    await waitFor(() => expect(within(findingsPanel).getByText('KOSMO-CD-5')).toBeTruthy());
    fireEvent.click(within(findingsPanel).getAllByText('ManufacturerName')[0]!);

    const inspector = document.querySelector('.inspector') as HTMLElement;
    const definition = (await within(inspector).findByLabelText('definition (en)')) as HTMLTextAreaElement;
    fireEvent.change(definition, { target: { value: 'legally valid designation of the natural or judicial person' } });
    fireEvent.change(within(inspector).getByLabelText('unit'), { target: { value: 'mm' } });
    fireEvent.click(within(inspector).getByRole('button', { name: '저장' }));

    expect(await screen.findByText(/정의를 저장했습니다/)).toBeTruthy();
    await waitFor(() => {
      const again = within(document.querySelector('.inspector') as HTMLElement).getByLabelText(
        'definition (en)',
      ) as HTMLTextAreaElement;
      expect(again.value).toBe('legally valid designation of the natural or judicial person');
    });
    expect((within(inspector).getByLabelText('unit') as HTMLInputElement).value).toBe('mm');
  });

  it('clicking Fix clears the violations and shows what was fixed', async () => {
    await mountApi((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
      env.submodels![1]!.kind = 'Instance';
    });
    render(<App />);

    const button = await screen.findByRole('button', { name: /^자동 고치기/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    // Do not fix right away — review per-item before/after in the preview popup, then apply (2026-09-11)
    const dialog = await screen.findByRole('dialog', { name: '자동 고치기 미리보기' });
    expect(within(dialog).getAllByRole('row').length).toBeGreaterThan(1);
    expect(within(dialog).getByText('Type')).toBeTruthy(); // assetKind after
    // A removing fix (AASd-120) shows "(removed)" rather than "—" in the after column — so it does not look empty
    expect(within(dialog).getAllByText('(지움)').length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /고른 \d+건 반영/ }));

    expect(await screen.findByText(/교정 \d+건/)).toBeTruthy();
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });

  it('items unchecked in the preview are not fixed — only the selected ones are applied', async () => {
    await mountApi((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
      env.submodels![1]!.kind = 'Instance';
    });
    render(<App />);
    // 2 violations + the fixable warnings in the golden file — the button count is their sum
    const button = await screen.findByRole('button', { name: /^자동 고치기 \d+건$/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    const dialog = await screen.findByRole('dialog', { name: '자동 고치기 미리보기' });
    // Before/after shown in the table — assetKind Instance → Type
    expect(within(dialog).getAllByText('Instance', { exact: true }).length).toBeGreaterThan(0);
    // Turn everything off and enable only assetKind — the kind=Instance violation must remain
    fireEvent.click(within(dialog).getByLabelText('전체 고르기'));
    expect((within(dialog).getByRole('button', { name: '고른 0건 반영' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText(/^KOSMO-AAS-6 /));
    fireEvent.click(within(dialog).getByRole('button', { name: '고른 1건 반영' }));

    expect(await screen.findByText(/교정 1건/)).toBeTruthy();
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 1건')).toBeTruthy();
    });
  });

  it('editing a value and saving shows it in the tree again via the server', async () => {
    await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('URIOfTheProduct'));
    const editor = screen.getByLabelText('값') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'https://example.com/새-제품' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    // Do not trust screen state; the value re-read from the server must be shown
    expect(await screen.findByText('https://example.com/새-제품')).toBeTruthy();
  });

  it('findings that cannot be fixed leave a reason', async () => {
    await mountApi((env) => {
      // Clear a Property value — KOSMO-SME-4 must be filled by a person (not an auto-fix target).
      // DigitalNameplate and HandoverDocumentation are exempt from the rule, so pick from OperationalData
      const operational = env.submodels!.find((s) => s.idShort === 'OperationalData')!;
      const stack = [...(operational.submodelElements ?? [])];
      while (stack.length > 0) {
        const node = stack.shift() as { modelType: string; value?: unknown };
        if (node.modelType === 'Property') {
          node.value = '';
          return;
        }
        if (Array.isArray(node.value)) stack.push(...(node.value as never[]));
      }
      throw new Error('OperationalData에서 Property를 찾지 못했습니다');
    });
    render(<App />);

    await openFindings();
    expect(await screen.findByText('Property에 값이 없습니다.')).toBeTruthy();
    const item = screen.getByText('Property에 값이 없습니다.').closest('li') as HTMLElement;
    expect(within(item).queryByText(/자동 고치기 대상|자동 교정/)).toBeNull();
  });
});

describe('Header — there should be exactly one next thing to click', () => {
  it('without a file there is no edit/submit row; it appears once a file is opened', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByRole('button', { name: /^자동 고치기/ })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'AASX 내려받기' })).toBeTruthy();

    // Clicking the logo goes to the start screen — file actions disappear
    fireEvent.click(within(header).getByRole('button', { name: /처음 화면으로|AAS Studio/ }));
    expect(within(header).queryByRole('button', { name: /^자동 고치기/ })).toBeNull();
    expect(within(header).queryByRole('button', { name: 'AASX 내려받기' })).toBeNull();
    expect(within(header).getByRole('button', { name: /^파일/ })).toBeTruthy();
  });

  it('with violations Auto-fix is the blue button, without them Download AASX is', async () => {
    await mountApi((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    });
    render(<App />);
    const fix = await screen.findByRole('button', { name: /^자동 고치기 \d+건$/ });
    await waitFor(() => expect(fix.className).toContain('primary'));
    expect(screen.getByRole('button', { name: 'AASX 내려받기' }).className).not.toContain('primary');

    fireEvent.click(fix);
    const dialog = await screen.findByRole('dialog', { name: '자동 고치기 미리보기' });
    fireEvent.click(within(dialog).getByRole('button', { name: /고른 \d+건 반영/ }));
    await screen.findByText(/교정 \d+건/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'AASX 내려받기' }).className).toContain('primary'),
    );
    expect((screen.getByRole('button', { name: '자동 고치기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('downloading with violations left asks first, and cancelling does not download', async () => {
    await mountApi((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
    });
    render(<App />);
    await screen.findByRole('button', { name: /^자동 고치기 \d+건$/ });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'AASX 내려받기' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String(confirm.mock.calls[0]![0])).toMatch(/위반 \d+건이 남아/);
    expect(screen.queryByText(/내려받았습니다/)).toBeNull();
    confirm.mockRestore();
  });
});

describe('Adding and deleting elements and submodels', () => {
  it('creates and deletes an element under the selected collection', async () => {
    await mountApi();
    render(<App />);

    // Select GeneralInformation (SMC) in TechnicalData
    fireEvent.click(await screen.findByText('GeneralInformation'));
    fireEvent.click(await screen.findByRole('button', { name: '요소 추가' }));

    fireEvent.change(screen.getByLabelText('새 요소 이름 (idShort)'), { target: { value: 'TestProbe' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));

    // It appears in the tree re-read via the server.
    // The same name also appears in the findings pane (new elements have no semanticId), so narrow the search to the tree
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).getByText('TestProbe')).toBeTruthy());

    // New elements have no semanticId, so the linter flags them — this flow leads into Fix
    await openFindings();
    await waitFor(() => {
      expect(screen.getAllByText('semanticId가 없습니다.').length).toBeGreaterThan(0);
    });
    // Close the popup and return to the tree
    fireEvent.click(screen.getByRole('button', { name: '지적 목록 닫기' }));

    vi.stubGlobal('confirm', () => true);
    fireEvent.click(within(tree).getByText('TestProbe'));
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(within(tree).queryByText('TestProbe')).toBeNull());
  });

  it('blocks adding when idShort breaks the naming rule (AASd-002)', async () => {
    await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('GeneralInformation'));
    fireEvent.click(await screen.findByRole('button', { name: '요소 추가' }));
    fireEvent.change(screen.getByLabelText('새 요소 이름 (idShort)'), { target: { value: '한글이름' } });

    expect(screen.getByText(/영문자로 시작하는 2자 이상/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '추가' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a new submodel is created rule-compliant and gets the AAS reference too', async () => {
    await mountApi();
    render(<App />);

    await screen.findByText('DigitalNameplate');
    clickMenuItem('서브모델', '서브모델 추가');
    fireEvent.change(screen.getByLabelText('이름 (idShort)'), { target: { value: 'SafetyData' } });

    // Propose an id from the iriBase received from the server (linter policy)
    expect(
      screen.getByText('https://www.smart-factory.kr/ids/sm/RollFormingMachine/SafetyData/1/0'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    expect(await screen.findByText('SafetyData')).toBeTruthy();

    // Creating it must not add violations — it is created with kind, semanticId and administration in place
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });
});

describe('Importing submodels', () => {
  it('importing a submodel from another file brings its CDs along', async () => {
    await mountApi(undefined, { extraPackage: true });
    render(<App />);

    // Switch to the second file (empty equipment) and import there
    await screen.findByText('DigitalNameplate');
    const picker = document.querySelector('header select') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'pkg_2' } });
    // Empty equipment, so no submodels. The AAS node always exists (where findings land)
    await waitFor(() => {
      const tree = document.querySelector('.tree') as HTMLElement;
      expect(within(tree).queryByText('DigitalNameplate')).toBeNull();
      expect(within(tree).getByText('NewMachine')).toBeTruthy();
    });

    // The header's Import — the panel has a button with the same name too
    const header = document.querySelector('header') as HTMLElement;
    clickMenuItem('서브모델', '다른 파일에서 가져오기');
    await waitFor(() =>
      expect((screen.getByLabelText('서브모델') as HTMLSelectElement).value).not.toBe(''),
    );
    fireEvent.change(screen.getByLabelText('서브모델'), {
      target: { value: 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/DigitalNameplate/3/1' },
    });
    const form = document.querySelector('.add-form') as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: '가져오기' }));

    // The id is regenerated with the new equipment name and the CDs come along
    expect(await screen.findByText(/ConceptDescription \d+건 동반/)).toBeTruthy();
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).getByText('DigitalNameplate')).toBeTruthy());

    // The import creates no new **violations**.
    // (AASd-120 is a warning — the SML child idShort from the source came along;
    //  it does not block KOSMO submission but flags that interoperability breaks)
    await openFindings();
    await waitFor(() => {
      const cards = [...document.querySelectorAll('.findings li')];
      const errors = cards.filter((card) => card.classList.contains('error'));
      const rules = errors.map((card) => card.querySelector('.rule')?.textContent);
      expect(new Set(rules)).toEqual(new Set(['KOSMO-AAS-4']));
      expect(cards.some((card) => card.querySelector('.rule')?.textContent === 'AASd-120')).toBe(true);
    });
  });
});

describe('Direct semanticId input (M4 reduced scope)', () => {
  it('validates at the input and persists to the file on save', async () => {
    await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('SerialNumber'));
    const input = screen.getByLabelText('semanticId') as HTMLInputElement;

    // Outside the allow-list — blocked right there
    fireEvent.change(input, { target: { value: 'https://example.com/x' } });
    await openFindings();
    expect(await screen.findByText(/허용 목록 밖입니다/)).toBeTruthy();

    // Official IDTA IRI is a regulation conflict, so a warning
    fireEvent.change(input, { target: { value: 'https://admin-shell.io/zvei/nameplate/3/0/X' } });
    expect(screen.getByText(/KOSMO Validator는 이를 거부/)).toBeTruthy();

    // An IRDI present in the file passes
    fireEvent.change(input, { target: { value: '0112/2///61987#ABA951#009' } });
    expect(screen.getByText('표준 사전 IRDI 형식입니다.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'semanticId 저장' }));

    // Still there after re-reading via the server
    await waitFor(() => {
      const inspector = document.querySelector('.inspector') as HTMLElement;
      expect(within(inspector).getAllByText('0112/2///61987#ABA951#009').length).toBeGreaterThan(0);
    });
  });

  it('an id not in the file reports that no CD exists', async () => {
    await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('SerialNumber'));
    fireEvent.change(screen.getByLabelText('semanticId'), {
      target: { value: 'https://www.smart-factory.kr/ids/cd/처음보는것/1/0' },
    });
    await openFindings();
    expect(await screen.findByText(/ConceptDescription이 파일에 없습니다/)).toBeTruthy();
  });
});

describe('Concurrent edit conflict', () => {
  it('if changed elsewhere first, it warns instead of overwriting', async () => {
    const store = await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('SerialNumber'));

    // Make the screen's revision stale: simulate someone else editing the same submodel
    const packageId = 'pkg_1';
    const nameplate = readAasx(goldenBytes).environment.submodels![0]!;
    const current = (await store.getIdentifiable(packageId, 'Submodel', nameplate.id))!;
    await store.updateIdentifiable(packageId, 'Submodel', nameplate.id, {
      ...current.content,
      category: 'PARAMETER',
    });

    const editor = screen.getByLabelText('값') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '내가 쓴 값' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    expect(await screen.findByText(/다른 곳에서 이 서브모델이 먼저 바뀌었습니다/)).toBeTruthy();
    expect(screen.getByText('내 수정은 저장하지 않았습니다.')).toBeTruthy();

    // The other person's edit must survive — proof that nothing was overwritten
    const after = (await store.getIdentifiable(packageId, 'Submodel', nameplate.id))!;
    expect((after.content as { category?: string }).category).toBe('PARAMETER');

    // Re-reading fetches the latest revision so editing can continue
    fireEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    await waitFor(() =>
      expect(screen.queryByText(/다른 곳에서 이 서브모델이 먼저 바뀌었습니다/)).toBeNull(),
    );
  });
});

/** AID submodel — IDTA-02017 structure as is (EndpointMetadata.base · forms.href) */
function aidSubmodel(): unknown {
  const smc = (idShort: string, value: unknown[]): unknown => ({
    modelType: 'SubmodelElementCollection',
    idShort,
    value,
  });
  const prop = (idShort: string, value: string): unknown => ({
    modelType: 'Property',
    idShort,
    valueType: 'xs:string',
    value,
  });
  return {
    modelType: 'Submodel',
    id: 'https://www.smart-factory.kr/ids/sm/RollFormingMachine/AssetInterfacesDescription/1/0',
    idShort: 'AssetInterfacesDescription',
    kind: 'Template',
    administration: { version: '1', revision: '0' },
    semanticId: {
      type: 'ExternalReference',
      keys: [
        {
          type: 'GlobalReference',
          value: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/1/Submodel',
        },
      ],
    },
    submodelElements: [
      smc('InterfaceTemplateForOPCUA', [
        prop('title', '롤포밍기 제어반'),
        smc('EndpointMetadata', [prop('base', 'opc.tcp://192.168.0.10:4840')]),
        smc('InteractionMetadata', [
          smc('properties', [
            smc('MotorSpeed', [
              prop('unit', 'rpm'),
              smc('forms', [prop('href', 'ns=1;s=Machine.MotorSpeed')]),
            ]),
            smc('AlarmActive', [smc('forms', [prop('href', 'ns=1;s=Machine.AlarmActive')])]),
          ]),
        ]),
      ]),
    ],
  };
}

/** AssetInformation rows have the same name and kind, so text cannot pick them. Pick by position */
const assetInfoRow = (): HTMLElement | null =>
  document.querySelector('[data-pointer="/assetAdministrationShells/0/assetInformation"]');

describe('AssetInformation editing', () => {
  it('changing assetKind makes a linter finding appear and disappear in place', async () => {
    await mountApi();
    render(<App />);

    // Select AssetInformation in the tree — by position (the same text appears in several places)
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(assetInfoRow()).toBeTruthy());
    fireEvent.click(assetInfoRow()!);

    const kind = screen.getByLabelText('assetKind') as HTMLSelectElement;
    expect(kind.value).toBe('Type');

    fireEvent.change(kind, { target: { value: 'Instance' } });
    expect(screen.getByText(/형식\(Type\) 단위입니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    // On save the server lints and the finding comes up
    await openFindings();
    expect(await screen.findByText(/assetKind가 Type이 아닙니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '지적 목록 닫기' }));

    // Reverting makes it go away
    fireEvent.click(assetInfoRow()!);
    fireEvent.change(screen.getByLabelText('assetKind'), { target: { value: 'Type' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });

  it('clearing globalAssetId and saving shows KOSMO-AAS-5', async () => {
    await mountApi();
    render(<App />);

    await waitFor(() => expect(assetInfoRow()).toBeTruthy());
    fireEvent.click(assetInfoRow()!);
    fireEvent.change(screen.getByLabelText('globalAssetId'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await openFindings();
    expect(await screen.findByText('globalAssetId가 없습니다.')).toBeTruthy();
  });
});

describe('Collection screen (M8)', () => {
  it('without an AID it offers a way to create one — not just a notice', async () => {
    await mountApi();
    render(<App />);
    expect(await screen.findByText(/수집 연결.*이 없습니다|아직 수집 연결/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '수집' })).toBeNull();
    expect(screen.getByRole('button', { name: '수집 연결 만들기' })).toBeTruthy();
  });

  it('creating a collection connection — filling the table creates an AID and collection works', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));

    fireEvent.change(screen.getByLabelText('접속 주소'), {
      target: { value: 'opc.tcp://192.168.0.50:4840' },
    });
    // Manual entry is the secondary path — the default is "Load from equipment", so click once to open the fields
    fireEvent.click(screen.getByRole('button', { name: '+ 손으로 입력' }));
    // Match the name to a model element (SerialNumber) — a precondition for live export
    fireEvent.change(screen.getByLabelText('태그 1 이름'), { target: { value: 'SerialNumber' } });
    fireEvent.change(screen.getByLabelText('태그 1 주소'), { target: { value: 'ns=1;s=Serial' } });
    fireEvent.click(screen.getByRole('button', { name: /^만들기/ }));

    // When all names match, it finishes in one line with no warning
    const toast = await screen.findByText(/수집 연결을 만들었습니다/);
    expect(toast.textContent).not.toMatch(/⚠/);

    // Important: the file now has a real AID and parseAid can read it back
    const environment = await store.getEnvironment('pkg_1');
    const aid = environment.submodels!.find((sm) => sm.idShort === 'AssetInterfacesDescription');
    expect(aid).toBeTruthy();
    expect(JSON.stringify(aid)).toContain('opc.tcp://192.168.0.50:4840');

    // The collection table also appears on screen
    expect(await screen.findByRole('button', { name: '수집' })).toBeTruthy();
  });

  it('connection state is shown as a dot and text — no guessing before collection', async () => {
    await mountApi(undefined, { aid: true });
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // Never connected yet — "not collected"
    expect(await screen.findByText('수집 전')).toBeTruthy();

    // After collecting, the result becomes the state as is (fake adapter, so success)
    fireEvent.click(screen.getByRole('button', { name: '수집' }));
    expect(await screen.findByText('연결됨')).toBeTruthy();
  });

  it('value table categories — with a template, required/optional is shown and "Show only to fill" hides optional', async () => {
    await mountApi(undefined, { nameplateTemplate: ['ManufacturerName', 'SerialNumber'] });
    render(<App />);
    fireEvent.click(await screen.findByText('DigitalNameplate'));
    const table = (await screen.findByText(/값 한꺼번에 입력/)).closest('.bulk-values') as HTMLElement;
    expect(within(table).getByText(/^필수 2$/)).toBeTruthy();
    expect(within(table).getByText(/^선택 \d+$/)).toBeTruthy();
    expect(within(table).getByText(/기준: 템플릿 IDTA_Nameplate_template\.aasx/)).toBeTruthy();
    const rowsBefore = table.querySelectorAll('tbody tr').length;
    const serial = within(table).getByText('SerialNumber').closest('tr') as HTMLElement;
    expect(within(serial).getByText('필수')).toBeTruthy();

    fireEvent.click(within(table).getByLabelText('채울 것만 보기'));
    const rowsAfter = table.querySelectorAll('tbody tr').length;
    expect(rowsAfter).toBe(2); // only the two required rows
    expect(rowsAfter).toBeLessThan(rowsBefore);
  });

  it('value table categories — without a template it invents nothing and says "unknown"', async () => {
    await mountApi();
    render(<App />);
    fireEvent.click(await screen.findByText('DigitalNameplate'));
    const table = (await screen.findByText(/값 한꺼번에 입력/)).closest('.bulk-values') as HTMLElement;
    expect(within(table).getByText(/IDTA 템플릿이 없어 필수 여부를 모릅니다/)).toBeTruthy();
    expect(within(table).queryByText('필수')).toBeNull();
  });

  it('value freshness — no value before collection, receiving once read (even if the device clock is old, if it was just read)', async () => {
    await mountApi(undefined, { aid: true });
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const card = (): HTMLElement => document.querySelector('.collection .interface') as HTMLElement;
    await waitFor(() => expect(card()).toBeTruthy());
    // Nothing has arrived yet
    expect(within(card()).getByText(/^값 없음 \d+$/)).toBeTruthy();
    expect(within(card()).getByText('받는 중 0')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '수집' }));
    await screen.findByText('연결됨');
    // Important: the fake adapter's device clock is stuck at 2026-08-24 — judging by it would mark everything "disconnected".
    //    Judging by receive time, everything is receiving; nothing is disconnected or without value
    await waitFor(() => expect(within(card()).queryByText(/^값 없음 \d+$/)).toBeNull());
    expect(within(card()).getByText(/^받는 중 [1-9]\d*$/)).toBeTruthy();
    expect(within(card()).queryByText(/^끊김 \d+$/)).toBeNull();
    expect(within(card()).getAllByText('방금').length).toBeGreaterThan(0);
  });

  it('a connection can be deleted — create/change without delete is not acceptable', async () => {
    const store = await mountApi(undefined, { aid: true });
    render(<App />);
    await screen.findByText('DigitalNameplate');
    // With an AID, the collection table and "Delete connection" are shown
    const remove = await screen.findByRole('button', { name: '연결삭제' });

    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    fireEvent.click(remove);

    expect(await screen.findByText('수집 연결을 지웠습니다.')).toBeTruthy();
    // It is really gone from the file, and the empty state returns
    const environment = await store.getEnvironment('pkg_1');
    expect(
      environment.submodels!.find((sm) => sm.idShort === 'AssetInterfacesDescription'),
    ).toBeUndefined();
    expect(await screen.findByRole('button', { name: '수집 연결 만들기' })).toBeTruthy();
  });

  /** Up to adding one tag that is not in the model — the two paths diverge here */
  const fillOneUnknownTag = async (): Promise<void> => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));

    fireEvent.change(screen.getByLabelText('접속 주소'), {
      target: { value: 'opc.tcp://192.168.0.50:4840' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ 손으로 입력' }));
    fireEvent.change(screen.getByLabelText('태그 1 이름'), { target: { value: 'MotorSpeed' } });
    fireEvent.change(screen.getByLabelText('태그 1 주소'), { target: { value: 'ns=1;s=Speed' } });
    // The warning shows even while typing — the name is not in the model
    expect(screen.getByText(/1개는 모델에 없는 이름/)).toBeTruthy();
  };

  it('creating the slot together avoids a half connection (default behavior)', async () => {
    await fillOneUnknownTag();
    fireEvent.click(screen.getByRole('button', { name: /^만들기/ }));

    // The item that was not in the model is placed in OperationalData, so the names do not mismatch
    const toast = await screen.findByText(/요소 1개 새로 만듦/);
    expect(toast.textContent).not.toMatch(/⚠/);
  });

  it('browsing and picking from equipment means no typing NodeIds', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));

    // Cannot browse before an address is entered — it does not know where to connect
    expect(screen.getByRole('button', { name: '설비에서 불러오기' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('접속 주소'), {
      target: { value: 'opc.tcp://192.168.0.50:4840' },
    });
    fireEvent.click(screen.getByRole('button', { name: '설비에서 불러오기' }));

    // Found tags appear with their current values — confirm here that "this is the right tag"
    expect(await screen.findByText(/태그 2개/)).toBeTruthy();
    expect(screen.getByText('1200.5')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '전체 선택' }));
    fireEvent.click(screen.getByRole('button', { name: /고른 2개 담기/ }));

    // The address goes straight into the tag table — not typed by hand
    await waitFor(() =>
      expect((screen.getByLabelText('태그 1 주소') as HTMLInputElement).value).toBe(
        'ns=1;s=Machine.MotorSpeed',
      ),
    );
    expect((screen.getByLabelText('태그 1 이름') as HTMLInputElement).value).toBe('MotorSpeed');
    // Important: characters not allowed in element names (-) become underscores — otherwise creation is blocked
    expect((screen.getByLabelText('태그 2 이름') as HTMLInputElement).value).toBe('Alarm_Active');
  });

  it('turning off slot creation reports that names do not match', async () => {
    await fillOneUnknownTag();
    // Turn off the default that is on — the path for people who do not want to touch the model
    // Slot creation is folded under "Details" — expand it and turn it off
    fireEvent.click(screen.getByText(/자세히 — 모델에 없는 항목의 자리/));
    fireEvent.click(screen.getByRole('checkbox', { name: /자리도 함께 만들기/ }));
    fireEvent.click(screen.getByRole('button', { name: /^만들기/ }));

    expect(await screen.findByText(/⚠ 모델과 이름이 안 맞는 태그 1개/)).toBeTruthy();
  });

  it('with an AID it shows the interface and address', async () => {
    await mountApi(undefined, { aid: true });
    render(<App />);

    expect(await screen.findByText('롤포밍기 제어반')).toBeTruthy();
    expect(screen.getByText('OPCUA')).toBeTruthy();
    expect(screen.getByText('opc.tcp://192.168.0.10:4840')).toBeTruthy();
    expect(screen.getByText('ns=1;s=Machine.MotorSpeed')).toBeTruthy();
  });

  it('clicking Collect now brings in values and leaves the model unchanged', async () => {
    const store = await mountApi(undefined, { aid: true });
    render(<App />);

    const before = JSON.stringify(await store.getEnvironment('pkg_1'));
    fireEvent.click(await screen.findByRole('button', { name: '수집' }));

    expect(await screen.findByText(/수집 2건/)).toBeTruthy();
    // The latest value appears in the table (the tree also has false, so narrow to the collection table)
    const table = document.querySelector('.collection') as HTMLElement;
    await waitFor(() => expect(within(table).getByText('1310.75')).toBeTruthy());
    expect(within(table).getByText('false')).toBeTruthy();

    // Important: collection is not editing — the model stays the same
    expect(JSON.stringify(await store.getEnvironment('pkg_1'))).toBe(before);

    // Important: adding an AID raises one violation: KOSMO treats the AID's standard semanticId (admin-shell.io)
    // as outside its whitelist (regulation conflict 1). It is not caused by collection but has existed
    // since the AID was added, and Fix resolves it while leaving a migration ledger
    await openFindings();
    expect(await screen.findByText(/semanticId가 허용 목록 밖입니다/)).toBeTruthy();
  });
});

describe('Login wall (2026-10-02)', () => {
  const auth = { tokens: ['공장-토큰'], readOnlyTokens: [] };

  it('on a server with auth enabled the wall comes first — files must not be visible', async () => {
    await mountApi(undefined, { auth });
    setToken(undefined);
    render(<App />);

    // The server has no accounts, so the "Create admin" side shows (with accounts it is "Log in")
    expect(await screen.findByRole('button', { name: '관리자 만들기' })).toBeTruthy();
    expect(screen.queryByText('01-롤포밍기.aasx')).toBeNull();
    expect(screen.queryByText('DigitalNameplate')).toBeNull();
  });

  it('holding an API key enters without the login screen — existing integrations are not kicked out', async () => {
    await mountApi(undefined, { auth });
    setToken('공장-토큰');
    render(<App />);

    expect(await screen.findByText('DigitalNameplate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull();
    setToken(undefined);
  });

  it('on a server with auth disabled no login screen is shown — there is no account to enter', async () => {
    await mountApi();          // no token, no accounts
    setToken(undefined);
    render(<App />);

    expect(await screen.findByText('DigitalNameplate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull();
  });

  it('a server with no accounts (token only) shows first-admin creation', async () => {
    await mountApi(undefined, { auth });
    setToken(undefined);
    render(<App />);

    // setupNeeded, so the "Create admin" button shows
    expect(await screen.findByRole('button', { name: '관리자 만들기' })).toBeTruthy();
    expect(screen.getByLabelText(/비밀번호 확인/)).toBeTruthy();
  });
});

describe('Settings menu and account management (2026-10-04)', () => {
  const auth = { tokens: ['공장-토큰'], readOnlyTokens: [] };
  const PASSWORD = '열자가넘는비밀번호입니다';

  /** Create the first admin via the UI and enter */
  async function enterAsAdmin(): Promise<void> {
    await mountApi(undefined, { auth });
    setToken(undefined);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('로그인 이름'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: '주인' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText('비밀번호 확인'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: '관리자 만들기' }));
    expect(await screen.findByText('DigitalNameplate')).toBeTruthy();
  }

  it('Settings is text, not a gear — on this screen the gear icon marks equipment', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByRole('button', { name: /^설정/ })).toBeTruthy();
    expect(within(header).queryByRole('button', { name: /^⚙/ })).toBeNull();
  });

  it('an admin adds people from the UI — previously there was nothing to click', async () => {
    await enterAsAdmin();
    clickMenuItem('설정', '계정 관리');
    const dialog = await screen.findByRole('dialog', { name: '계정' });

    // Just me for now
    expect(await within(dialog).findByText('owner')).toBeTruthy();

    const form = within(dialog).getByRole('button', { name: '계정 만들기' }).closest('form') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('로그인 이름'), { target: { value: 'kim' } });
    fireEvent.change(within(form).getByLabelText('표시 이름'), { target: { value: '김편집' } });
    fireEvent.change(within(form).getByLabelText('처음 비밀번호'), { target: { value: PASSWORD } });
    fireEvent.click(within(form).getByRole('button', { name: '계정 만들기' }));

    expect(await within(dialog).findByText('계정을 만들었습니다.')).toBeTruthy();
    expect(within(dialog).getByText('김편집')).toBeTruthy();
  });

  it('admins also change name, company and email in My account settings (2026-10-08)', async () => {
    await enterAsAdmin();
    clickMenuItem('설정', '내 계정 설정');
    const dialog = await screen.findByRole('dialog', { name: '계정' });
    expect(within(dialog).getByText('내 계정 설정')).toBeTruthy();
    expect((within(dialog).getByLabelText('로그인 이름') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('표시 이름'), { target: { value: 'WACE 관리자' } });
    fireEvent.change(within(dialog).getByLabelText('회사명'), { target: { value: 'WACE' } });
    fireEvent.change(within(dialog).getByLabelText('이메일'), { target: { value: 'admin@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    expect(await within(dialog).findByText('내 정보를 저장했습니다.')).toBeTruthy();
    // The account management window has no field for my own password — mine is in "My account settings"
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    clickMenuItem('설정', '계정 관리');
    const people = await screen.findByRole('dialog', { name: '계정' });
    expect(within(people).queryByLabelText('지금 비밀번호')).toBeNull();
    expect(await within(people).findByText('WACE 관리자')).toBeTruthy();
  });

  it('when the server rejects, the reason is shown as is — short password', async () => {
    await enterAsAdmin();
    clickMenuItem('설정', '계정 관리');
    const dialog = await screen.findByRole('dialog', { name: '계정' });
    const form = within(dialog).getByRole('button', { name: '계정 만들기' }).closest('form') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('로그인 이름'), { target: { value: 'kim' } });
    fireEvent.change(within(form).getByLabelText('처음 비밀번호'), { target: { value: '짧다' } });
    fireEvent.click(within(form).getByRole('button', { name: '계정 만들기' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('10자');
  });

  it('the last admin cannot be locked — otherwise nobody could manage accounts', async () => {
    await enterAsAdmin();
    clickMenuItem('설정', '계정 관리');
    const dialog = await screen.findByRole('dialog', { name: '계정' });
    await within(dialog).findByText('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: '잠그기' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('마지막 관리자');
  });
});

describe('Attachments', () => {
  /**
   * Important: this is the substance of the submission. The manual PDF in HandoverDocumentation must actually be
   * inside the AASX, and until now there was no way to add it from the UI (only value = path could be edited).
   */
  it('attaching a file to a File element puts it in the package and value points to that part', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // Expand HandoverDocumentation → … → DigitalFilesEntry_0
    const tree = document.querySelector('.tree') as HTMLElement;
    for (const label of [
      'Documents',
      'DocumentsEntry_0',
      'DocumentVersions',
      'DocumentVersionsEntry_0',
      'DigitalFiles',
    ]) {
      fireEvent.click(within(tree).getByText(label).closest('.row')!.querySelector('.twist')!);
    }
    fireEvent.click(within(tree).getByText('DigitalFilesEntry_0'));

    // Before attaching, "attached" shows only the file name (value exists but the package has no part)
    const inspector = document.querySelector('.inspector') as HTMLElement;
    expect(within(inspector).getByText(/첨부 파일/)).toBeTruthy();

    const before = (await store.packageFiles('pkg_1')).length;
    const chooser = within(inspector).getByLabelText('첨부 파일') as HTMLInputElement;
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], '설치매뉴얼.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(chooser, { target: { files: [pdf] } });

    // The screen states the fact
    expect(await screen.findByText(/설치매뉴얼\.pdf.*붙였습니다/)).toBeTruthy();

    // Important: did it really go into the package — check the store, not the screen text
    const after = await store.packageFiles('pkg_1');
    expect(after.length).toBe(before + 1);
    const added = after.find((file) => file.part.includes('설치매뉴얼.pdf'));
    expect(added).toBeTruthy();
    expect(added!.contentType).toBe('application/pdf');
    expect([...added!.data.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);

    // The model's File.value must point to that part too — otherwise the file just floats unreferenced
    const environment = await store.getEnvironment('pkg_1');
    const found = JSON.stringify(environment).includes(`file://${added!.part}`);
    expect(found).toBe(true);
  });
});

describe('Reorder and duplicate — directly in the tree (drag and drop, context menu, Alt+Up/Down)', () => {
  const namesOf = async (store: Awaited<ReturnType<typeof mountApi>>): Promise<(string | undefined)[]> =>
    (await store.getEnvironment('pkg_1')).submodels![0]!.submodelElements!.map((e) => e.idShort);

  it('Alt+Down on a tree row changes the order in the file and the selection follows the element', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    const row = (within(tree).getByText('SerialNumber').closest('.row') as HTMLElement);
    fireEvent.click(row);
    const inspector = document.querySelector('.inspector') as HTMLElement;
    const before = await namesOf(store);
    const at = before.indexOf('SerialNumber');

    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });

    await waitFor(async () => {
      const after = await namesOf(store);
      expect(after[at + 1]).toBe('SerialNumber');
      expect(after[at]).toBe(before[at + 1]);
    });
    // The selection followed — the property pane title is still SerialNumber
    await waitFor(() => expect(within(inspector).getByRole('heading', { name: 'SerialNumber' })).toBeTruthy());
  });

  it('dragging and dropping below another sibling moves it there', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    const source = (within(tree).getByText('SerialNumber').closest('.row') as HTMLElement);
    const target = (within(tree).getByText('YearOfConstruction').closest('.row') as HTMLElement);
    const before = await namesOf(store);

    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => undefined };
    fireEvent.dragStart(source, { dataTransfer });
    // Drop on the lower half of the target row → "below it"
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 26 } as DOMRect);
    fireEvent.dragOver(target, { dataTransfer, clientY: 20 });
    expect(target.className).toContain('drop-after');
    fireEvent.drop(target, { dataTransfer });

    await waitFor(async () => {
      const after = await namesOf(store);
      expect(after.indexOf('SerialNumber')).toBe(after.indexOf('YearOfConstruction') + 1);
      expect(after.length).toBe(before.length);
    });
  });

  it('context menu Make copy only on container elements — Markings_2 appears right below and gets selected', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    // A single Property has no copy — it would just yield an X_2 with the same value, which is meaningless (user, 2026-09-09)
    fireEvent.contextMenu((within(tree).getByText('SerialNumber').closest('.row') as HTMLElement));
    const leafMenu = await screen.findByRole('menu', { name: 'SerialNumber 메뉴' });
    expect(within(leafMenu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      '↑ 한 칸 위로',
      '↓ 한 칸 아래로',
      '삭제',
    ]);
    fireEvent.keyDown(window, { key: 'Escape' });

    // Container element (SML) — one more copy of the whole structure, like a second certification mark group
    fireEvent.contextMenu((within(tree).getByText('Markings').closest('.row') as HTMLElement));
    const menu = await screen.findByRole('menu', { name: 'Markings 메뉴' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      '요소 추가',
      '사본 만들기 (복제)',
      '↑ 한 칸 위로',
      '↓ 한 칸 아래로',
      '삭제',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: '사본 만들기 (복제)' }));
    const inspector = document.querySelector('.inspector') as HTMLElement;

    expect(await screen.findByText(/「Markings_2」\(으\)로 복제했습니다/)).toBeTruthy();
    await waitFor(() => expect(within(tree).getByText('Markings_2')).toBeTruthy());
    await waitFor(() =>
      expect(within(inspector).getByRole('heading', { name: 'Markings_2' })).toBeTruthy(),
    );
    const names = (await store.getEnvironment('pkg_1')).submodels![0]!.submodelElements!.map(
      (e) => e.idShort,
    );
    expect(names[names.indexOf('Markings') + 1]).toBe('Markings_2');
  });
});

describe('Renaming (idShort)', () => {
  it('renaming an element updates both the tree and the file', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('SerialNumber'));

    const inspector = document.querySelector('.inspector') as HTMLElement;
    fireEvent.change(within(inspector).getByLabelText('이름'), {
      target: { value: 'SerialNo' },
    });
    fireEvent.click(within(inspector).getByRole('button', { name: '이름 바꾸기' }));

    expect(await screen.findByText(/「SerialNo」\(으\)로 바꿨습니다/)).toBeTruthy();
    await waitFor(() => expect(within(tree).queryByText('SerialNumber')).toBeNull());
    expect(within(tree).getByText('SerialNo')).toBeTruthy();

    // Important: did the file change, not just the screen
    const environment = await store.getEnvironment('pkg_1');
    expect(JSON.stringify(environment)).toContain('"SerialNo"');
  });

  it('blocks a name clash with a sibling — otherwise the wrong element is silently edited', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('SerialNumber'));

    const inspector = document.querySelector('.inspector') as HTMLElement;
    fireEvent.change(within(inspector).getByLabelText('이름'), {
      target: { value: 'YearOfConstruction' }, // already exists in the same submodel
    });
    fireEvent.click(within(inspector).getByRole('button', { name: '이름 바꾸기' }));

    expect(await screen.findByText(/이미 「YearOfConstruction」이\(가\) 있습니다/)).toBeTruthy();
    // The original name must remain
    expect(within(tree).getByText('SerialNumber')).toBeTruthy();
  });

  it('list children get no name field (AASd-120)', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('Markings').closest('.row')!.querySelector('.twist')!);
    fireEvent.click(within(tree).getByText('MarkingsEntry_0'));

    const inspector = document.querySelector('.inspector') as HTMLElement;
    expect(within(inspector).queryByLabelText('이름')).toBeNull();
  });
});

describe('Search in the tree', () => {
  it('filters by name — the path leading to it is kept too', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    fireEvent.change(screen.getByLabelText('트리에서 찾기'), { target: { value: 'serial' } });

    const tree = document.querySelector('.tree') as HTMLElement;
    // A ConceptDescription with the same name as the submodel Property also matches — both are correct results
    await waitFor(() => expect(within(tree).getAllByText('SerialNumber').length).toBeGreaterThan(0));
    // Only matches and their ancestors remain — siblings disappear
    expect(within(tree).queryByText('YearOfConstruction')).toBeNull();
    expect(within(tree).getByText('DigitalNameplate')).toBeTruthy(); // the path
    // It reports how many matched
    const search = document.querySelector('.search') as HTMLElement;
    expect(within(search).getByText(/\d+건/)).toBeTruthy();
  });

  it('also searches by value and semanticId', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const box = screen.getByLabelText('트리에서 찾기');
    fireEvent.change(box, { target: { value: 'EXM-RFL-2026' } }); // value
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).getByText('SerialNumber')).toBeTruthy());

    fireEvent.change(box, { target: { value: '0173-1#02' } }); // semanticId
    await waitFor(() => expect(within(tree).queryAllByText(/./).length).toBeGreaterThan(0));
    expect(screen.queryByText('없음')).toBeNull();
  });

  it('says nothing was found when there is no match — not just an empty tree', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    fireEvent.change(screen.getByLabelText('트리에서 찾기'), {
      target: { value: '있을리없는이름' },
    });
    expect(await screen.findByText('없음')).toBeTruthy();
  });

  it('clearing returns to the original tree', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    fireEvent.change(screen.getByLabelText('트리에서 찾기'), { target: { value: 'serial' } });
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).queryByText('YearOfConstruction')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(within(tree).getByText('YearOfConstruction')).toBeTruthy());
  });
});

describe('New — equipment and process', () => {
  /**
   * Important: the point is not to create an empty AAS. KOSMO requires 4 submodel types and
   * bounds the total at 6–8 types — it must have 0 violations right after creation.
   */
  it('creating yields a rule-compliant skeleton (0 violations)', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.change(screen.getByLabelText('설비 이름'), { target: { value: 'PressMachine' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));

    expect(await screen.findByText(/새 설비 「PressMachine」/)).toBeTruthy();
    // It must pass right from birth
    const header = document.querySelector('header') as HTMLElement;
    await waitFor(() => expect(within(header).getByText('위반 0건')).toBeTruthy());

    const tree = document.querySelector('.tree') as HTMLElement;
    for (const required of ['DigitalNameplate', 'HandoverDocumentation', 'TechnicalData', 'OperationalData']) {
      expect(within(tree).getByText(required)).toBeTruthy();
    }
    expect(within(tree).getByText('PressMachine')).toBeTruthy(); // AAS
  });

  it('equipment-specific submodels can be added', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.change(screen.getByLabelText('설비 이름'), { target: { value: 'PressMachine' } });
    fireEvent.change(screen.getByLabelText('설비 특화 서브모델 (직접 입력)'), {
      target: { value: 'PressSafety' },
    });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));

    await screen.findByText(/새 설비 「PressMachine」/);
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).getByText('PressSafety')).toBeTruthy());
    // Even at 7 types it is within range (6–8)
    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByText('위반 0건')).toBeTruthy();
  });

  /**
   * Process — a unit made up of several pieces of equipment.
   *
   * Important: the point is **whether picking equipment files is enough to attach them**. Making people copy
   * names and Asset addresses by hand invites typos, and since that value is the only link between the two files, it breaks silently.
   */
  it('creating a process shows what it is made of', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingProcess' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));

    expect(await screen.findByText(/새 묶음 「WeldingProcess」/)).toBeTruthy();
    const header = document.querySelector('header') as HTMLElement;
    await waitFor(() => expect(within(header).getByText('위반 0건')).toBeTruthy());

    // The hierarchy panel shows the entry point
    const panel = await screen.findByText('공정·설비 구성');
    expect(panel).toBeTruthy();
    const hierarchy = document.querySelector('.hierarchy') as HTMLElement;
    expect(within(hierarchy).getByText('WeldingProcess')).toBeTruthy();
    expect(within(hierarchy).getByText(/아직 아무것도 들어 있지 않습니다/)).toBeTruthy();
  });

  it('picking uploaded equipment and adding it shows it in the list', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingProcess' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/새 묶음 「WeldingProcess」/);

    const hierarchy = document.querySelector('.hierarchy') as HTMLElement;
    // After creation it is the same tree editor — the company row's "+ Equipment" → pick the uploaded golden file → Add
    addFirstCandidate(hierarchy);

    await waitFor(() =>
      expect(
        within(document.querySelector('.hierarchy') as HTMLElement).getByText('RollFormingMachine'),
      ).toBeTruthy(),
    );
    // Attaching creates no rule violations
    const header = document.querySelector('header') as HTMLElement;
    await waitFor(() => expect(within(header).getByText('위반 0건')).toBeTruthy());
  });

  it('picks equipment in the create screen and adds it in one go', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });

    // Open equipment appears as a candidate
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    addFirstCandidate(parts);

    // The tree itself is the preview — equipment shows under the company
    expect(parts.textContent).toContain('WeldingLine');
    expect(parts.textContent).toContain('RollFormingMachine');

    fireEvent.click(screen.getByRole('button', { name: '만들기' }));

    // Added during creation — the user never sees an empty process first
    expect(await screen.findByText(/1건과 함께 만들었습니다/)).toBeTruthy();
    await waitFor(() =>
      expect(
        within(document.querySelector('.hierarchy') as HTMLElement).getByText('RollFormingMachine'),
      ).toBeTruthy(),
    );
  });

  /**
   * Important: where it used to get stuck at "No uploaded files" (user, 2026-09-09).
   * The candidate list shows **only what is already on the server** — a first-time user has uploaded nothing.
   * It must be possible to upload a .aasx from a PC folder right from that row.
   */
  it('uploads a .aasx from a PC folder in place from the composition tree', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });

    const parts = document.querySelector('.pick-parts') as HTMLElement;
    fireEvent.click(within(parts).getAllByRole('button', { name: '＋ 설비' })[0]!);

    const select = parts.querySelector('.build-adder select') as HTMLSelectElement;
    const before = select.options.length;
    // The button is on that row — clicking it opens the OS file dialog, so here we simulate the hidden input directly
    expect(within(parts).getByRole('button', { name: 'PC에서 가져오기' })).toBeTruthy();
    const chooser = parts.querySelector('.build-adder input[type="file"]') as HTMLInputElement;
    fireEvent.change(chooser, { target: { files: [new File([goldenBytes], '02-절단기.aasx')] } });

    // The uploaded file joins the candidates and comes back **already selected** — the user does not search and pick again
    await waitFor(() => expect(select.options.length).toBe(before + 1));
    await waitFor(() => expect(select.value).not.toBe(''));

    fireEvent.click(within(parts).getByRole('button', { name: '넣기' }));
    expect(parts.textContent).toContain('RollFormingMachine');
  });

  it('creating a process from the start screen and uploading via Import from PC keeps the tree being built', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    // Go to the start screen via the logo and create there — the start screen form used to vanish when busy switched to the three-pane view (reported 2026-09-09)
    fireEvent.click(screen.getByTitle('처음 화면으로'));
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WaceFactory' } });

    const parts = document.querySelector('.pick-parts') as HTMLElement;
    fireEvent.click(within(parts).getByRole('button', { name: '＋ 공정' }));
    fireEvent.change(screen.getByLabelText('공정 이름'), { target: { value: 'PressLine' } });
    fireEvent.click(within(parts).getByRole('button', { name: '넣기' }));
    expect(parts.textContent).toContain('PressLine');
    fireEvent.click(within(parts).getAllByRole('button', { name: '＋ 설비' })[1]!); // the one on the process row

    const chooser = parts.querySelector('.build-adder input[type="file"]') as HTMLInputElement;
    fireEvent.change(chooser, { target: { files: [new File([goldenBytes], '02-절단기.aasx')] } });

    // After upload the form, process and input rows are intact and the uploaded file is selected
    const select = () => document.querySelector('.pick-parts .build-adder select') as HTMLSelectElement | null;
    await waitFor(() => expect(select()?.value).toBeTruthy());
    expect(screen.getByLabelText('① 이름 (회사·공정·라인)')).toHaveProperty('value', 'WaceFactory');
    expect((document.querySelector('.pick-parts') as HTMLElement).textContent).toContain('PressLine');
    fireEvent.click(within(document.querySelector('.pick-parts') as HTMLElement).getByRole('button', { name: '넣기' }));
    expect((document.querySelector('.pick-parts') as HTMLElement).textContent).toContain('RollFormingMachine');
  });

  it('the HierarchicalStructures row gets a what-is-this label — parts for equipment files, composition for company files', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const tree = () => document.querySelector('.tree') as HTMLElement;
    const hsRow = () => (within(tree()).getByText('HierarchicalStructures').closest('.row') as HTMLElement).textContent ?? '';
    expect(hsRow()).not.toContain('부품 구성'); // not added on equipment files (user, 2026-09-09)

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WaceFactory' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('공정·설비 구성');
    await waitFor(() => expect(hsRow()).toContain('회사·공정 구성도'));
  });

  it('company file process, equipment and top AAS rows also have a ⋯ menu — for easier registration (user, 2026-09-09)', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WaceFactory' } });
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    fireEvent.click(within(parts).getByRole('button', { name: '＋ 공정' }));
    fireEvent.change(screen.getByLabelText('공정 이름'), { target: { value: 'PressLine' } });
    fireEvent.click(within(parts).getByRole('button', { name: '넣기' }));
    fireEvent.click(within(parts).getAllByRole('button', { name: '＋ 설비' })[1]!);
    const select = parts.querySelector('.build-adder select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: select.options[1]!.value } });
    fireEvent.click(within(parts).getByRole('button', { name: '넣기' }));
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('공정·설비 구성');

    const tree = document.querySelector('.tree') as HTMLElement;
    const rowOf = (text: string) =>
      [...tree.querySelectorAll('[role="treeitem"]')].find((r) => r.textContent?.includes(text)) as HTMLElement;
    const items = async (row: HTMLElement, name: string) => {
      fireEvent.contextMenu(row);
      const menu = await screen.findByRole('menu', { name: `${name} 메뉴` });
      const labels = within(menu).getAllByRole('menuitem').map((b) => b.textContent);
      fireEvent.keyDown(window, { key: 'Escape' });
      return labels;
    };
    await waitFor(() => expect(rowOf('PressLine')).toBeTruthy());
    expect(await items(rowOf('PressLine'), 'PressLine')).toEqual(['＋ 설비', '이 구성에서 빼기']);
    await waitFor(() => expect(rowOf('RollFormingMachine')).toBeTruthy());
    expect(await items(rowOf('RollFormingMachine'), 'RollFormingMachine')).toEqual([
      '이 설비에 서브모델 추가',
      '이 설비 파일 열기',
      '이 구성에서 빼기',
    ]);
    expect(await items(rowOf('WaceFactory'), 'WaceFactory')).toEqual(['＋ 공정', '＋ 설비', '서브모델 추가']);
  });

  it('(b) expanding a child equipment shows its submodels in place', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // Create a process that contains the golden equipment
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    addFirstCandidate(parts);
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/1건과 함께 만들었습니다/);

    // Expand — the file structure is unchanged; it is only joined on screen
    const hierarchy = document.querySelector('.hierarchy') as HTMLElement;
    await waitFor(() => expect(within(hierarchy).getByText('RollFormingMachine')).toBeTruthy());
    fireEvent.click(hierarchy.querySelector('.hier-toggle') as HTMLElement);

    const detail = await waitFor(() => {
      const found = hierarchy.querySelector('.hier-sublist');
      if (!found) throw new Error('아직');
      return found as HTMLElement;
    });
    // The equipment's submodels are shown as is
    expect(within(detail).getByText('DigitalNameplate')).toBeTruthy();
    expect(within(detail).getByText('TechnicalData')).toBeTruthy();
    expect(within(hierarchy).getByText('이 설비 파일 열기 →')).toBeTruthy();
  });

  it('the process tree is drawn as process → equipment → per-equipment submodels', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    addFirstCandidate(parts);
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/1건과 함께 만들었습니다/);

    // An equipment branch appears in the left tree — joined on screen, not part of the file structure
    const tree = document.querySelector('.tree') as HTMLElement;
    const asset = await waitFor(() => {
      const row = [...tree.querySelectorAll('[data-model-type="LinkedAsset"]')].find((r) =>
        r.textContent?.includes('RollFormingMachine'),
      );
      if (!row) throw new Error('아직');
      return row as HTMLElement;
    });

    // Expanding shows the folded "BOM (n)" first, then that equipment's submodels — parts stay folded (2026-09-08)
    fireEvent.click(asset);
    await waitFor(() => {
      const labels = [...tree.querySelectorAll('[role="treeitem"]')].map((r) => r.textContent ?? '');
      const at = labels.findIndex((t) => t.includes('RollFormingMachine') && t.includes('LinkedAsset'));
      const below = labels.slice(at + 1, at + 14).join(' ');
      expect(below).toContain('BOM ('); // parts drawer (folded)
      expect(below).not.toContain('Uncoiler');
      expect(below).toContain('DigitalNameplate'); // the equipment's own submodel
      expect(below).toContain('RollFormingSafety');
    });
    // Expanding the drawer shows parts as Part
    const drawer = [...tree.querySelectorAll('[role="treeitem"]')].find((r) => r.textContent?.includes('BOM ('))!;
    fireEvent.click(drawer);
    await waitFor(() => {
      const labels = [...tree.querySelectorAll('[role="treeitem"]')].map((r) => r.textContent ?? '');
      expect(labels.some((t) => t.includes('Uncoiler') && t.includes('Part'))).toBe(true);
    });
  });

  it('each file can be deleted from the file list', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    expect(within(list).getByText(/열린 파일/)).toBeTruthy();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(list).getAllByRole('button', { name: '지우기' })[0]!);
    await screen.findByText(/지웠습니다/);
    confirm.mockRestore();
  });

  it('check several files in the file list and delete them at once', async () => {
    await mountApi(undefined, { extraPackage: true });
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    expect(within(list).getByText('열린 파일 2건')).toBeTruthy();
    // Disabled when nothing is selected
    const bulk = within(list).getByRole('button', { name: /고른 0건 지우기/ }) as HTMLButtonElement;
    expect(bulk.disabled).toBe(true);

    fireEvent.click(within(list).getByLabelText('전체 고르기'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(list).getByRole('button', { name: /고른 2건 지우기/ }));
    // Both names appear in the confirmation text
    await waitFor(() => expect(confirm.mock.calls.some((call) => /2건을 목록에서 지웁니다/.test(String(call[0])))).toBe(true));
    await screen.findByText(/파일 2건을 지웠습니다/);
    // Nothing left, so the start screen
    expect(await screen.findByRole('button', { name: 'AASX 파일 열기' })).toBeTruthy();
    confirm.mockRestore();
  });

  it('the editor Close button returns to the add-equipment screen', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // Create a process and select something in the tree — the editor takes the center
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/만들었습니다/);

    const tree = document.querySelector('.tree') as HTMLElement;
    const row = [...tree.querySelectorAll('[role="treeitem"]')].find((r) =>
      r.textContent?.includes('ArcheType'),
    )!;
    fireEvent.click(row);
    expect(document.querySelector('.inspector')).toBeTruthy();
    expect(screen.queryByText('공정·설비 구성')).toBeNull();

    // Important: without Close there is no way back to the add-equipment screen (a gap caught by measurement)
    fireEvent.click(screen.getByRole('button', { name: /닫기 ✕/ }));
    expect(await screen.findByText('공정·설비 구성')).toBeTruthy();
  });

  it('selecting a submodel shows a value table and saves in one go', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('DigitalNameplate'));
    const table = await waitFor(() => {
      const found = document.querySelector('.bulk-values');
      if (!found) throw new Error('아직');
      return found as HTMLElement;
    });
    // Property and MLP appear as rows
    expect(within(table).getByText('SerialNumber')).toBeTruthy();
    const inputs = table.querySelectorAll('input');
    expect(inputs.length).toBeGreaterThan(5);

    // Editing one cell changes the button to "Save 1 changed", and saving changes the server value
    const serialRow = [...table.querySelectorAll('tr')].find((row) =>
      row.textContent?.includes('SerialNumber'),
    )!;
    fireEvent.change(serialRow.querySelector('input')!, { target: { value: 'SN-9999' } });
    fireEvent.click(within(table).getByRole('button', { name: /바뀐 1개 저장/ }));
    await screen.findByText(/값을 저장했습니다/);

    fireEvent.click(within(tree).getByText('DigitalNameplate'));
    await waitFor(() => {
      const again = document.querySelector('.bulk-values') as HTMLElement;
      const row = [...again.querySelectorAll('tr')].find((r) =>
        r.textContent?.includes('SerialNumber'),
      )!;
      expect((row.querySelector('input') as HTMLInputElement).value).toBe('SN-9999');
    });
  });

  it('the equipment name goes into the id — not just any characters are accepted', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.change(screen.getByLabelText('설비 이름'), { target: { value: '프레스 기계' } });

    expect(screen.getByText(/영문으로 시작하고/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '만들기' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Rules and conventions screen', () => {
  /**
   * Important: the point is to **show the basis for judgments**, and to put the fact that this tool does not
   *    decide pass/fail at the very top — confusing the two would be a problem for the submission target.
   */
  it('shows the rules currently running as they are', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('설정', '규칙과 규약 보기');

    expect(await screen.findByText(/이 도구가 지키는 규칙과 규약/)).toBeTruthy();
    const panel = document.querySelector('.rules') as HTMLElement;
    // Rule ids actually appear
    expect(within(panel).getByText('AASd-120')).toBeTruthy();
    expect(within(panel).getByText('PKG-EMPTY-ARRAY')).toBeTruthy();
  });

  it('states first who decides pass/fail — not this tool', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    clickMenuItem('설정', '규칙과 규약 보기');

    const panel = (await screen.findByText(/합격은 누가 정하는가/)).closest('section')!;
    expect(within(panel).getByText('KOSMO Validator')).toBeTruthy();
    expect(within(panel).getByText(/미리 걸러 주는 사전 점검/)).toBeTruthy();
  });

  it('shows what was chosen in regulation conflicts', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    clickMenuItem('설정', '규칙과 규약 보기');
    await screen.findByText(/규정이 충돌할 때/);

    const panel = document.querySelector('.rules') as HTMLElement;
    expect(within(panel).getAllByText(/지금 이것/).length).toBe(5);
  });

  it('can filter by layer', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    clickMenuItem('설정', '규칙과 규약 보기');
    await screen.findByText(/규정이 충돌할 때/);

    const panel = document.querySelector('.rules') as HTMLElement;
    const all = within(panel).getAllByRole('row').length;
    fireEvent.click(within(panel).getByRole('button', { name: /^L1/ }));
    await waitFor(() => expect(within(panel).getAllByRole('row').length).toBeLessThan(all));
  });
});

/**
 * Deleting files.
 *
 * Important: the point is **whether it warns first when something points to it**. A process points to
 * equipment only through a single link, globalAssetId, so deleting the equipment leaves the process file looking fine —
 * the broken link shows up nowhere on screen.
 */
describe('Deleting files', () => {
  it('deletes after confirmation', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    fireEvent.click(within(list).getAllByRole('button', { name: '지우기' })[0]!);

    await waitFor(() =>
      expect(confirm.mock.calls.some((call) => String(call[0]).includes('되돌릴 수 없습니다'))).toBe(
        true,
      ),
    );
    await screen.findByText(/지웠습니다/);
    confirm.mockRestore();
  });

  it('does not delete when cancelled', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    fireEvent.click(within(list).getAllByRole('button', { name: '지우기' })[0]!);

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.queryByText(/지웠습니다/)).toBeNull();
    // The tree is unchanged
    expect(screen.getByText('DigitalNameplate')).toBeTruthy();
    confirm.mockRestore();
  });

  it('warns before deleting if a process points to this equipment', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // Create one process containing this equipment
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    addFirstCandidate(parts);
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/1건과 함께 만들었습니다/);

    // Go back to that equipment and try to delete it
    const header = document.querySelector('header') as HTMLElement;
    const select = within(header).getByRole('combobox') as HTMLSelectElement;
    const machine = [...select.options].find((o) => o.text.includes('롤포밍기'))!;
    fireEvent.change(select, { target: { value: machine.value } });
    await waitFor(() => expect(screen.getByText('DigitalNameplate')).toBeTruthy());

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    // Click delete on the roll-forming machine row in the list
    const row = [...list.querySelectorAll('li')].find((item) =>
      item.textContent?.includes('롤포밍기'),
    )!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '지우기' }));
    await waitFor(() =>
      expect(confirm.mock.calls.some((call) => String(call[0]).includes('연결이 끊어집니다'))).toBe(
        true,
      ),
    );
    const asked = confirm.mock.calls.find((call) => String(call[0]).includes('연결이 끊어집니다'))!;
    expect(String(asked[0])).toContain('WeldingLine');
    confirm.mockRestore();
  });
});

describe('Undo — going back after a mistake', () => {
  it('starts disabled, enables after deleting an element, restores it on click and enables Redo', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const undo = screen.getByRole('button', { name: '되돌리기' });
    const redo = screen.getByRole('button', { name: '다시 하기' });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    expect((redo as HTMLButtonElement).disabled).toBe(true);

    // Mistake: delete SerialNumber
    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('SerialNumber'));
    const inspector = document.querySelector('.inspector') as HTMLElement;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(inspector).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(within(tree).queryByText('SerialNumber')).toBeNull());

    // The button enables and its title says what will be undone
    await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false));
    expect(undo.title).toMatch(/「SerialNumber」 지움/);

    fireEvent.click(undo);
    expect(await screen.findByText(/되돌렸습니다: 「SerialNumber」 지움/)).toBeTruthy();
    await waitFor(() => expect(within(tree).getByText('SerialNumber')).toBeTruthy());
    const names = (await store.getEnvironment('pkg_1')).submodels![0]!.submodelElements!.map((e) => e.idShort);
    expect(names).toContain('SerialNumber');

    await waitFor(() => expect((redo as HTMLButtonElement).disabled).toBe(false));
    expect((undo as HTMLButtonElement).disabled).toBe(true);
  });

  it('Ctrl+Z works too — only outside input fields', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('SerialNumber'));
    const inspector = document.querySelector('.inspector') as HTMLElement;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(inspector).getByRole('button', { name: '삭제' }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '되돌리기' }) as HTMLButtonElement).disabled).toBe(false),
    );

    // Important: Undo enables as soon as the delete is recorded, but the delete's save may still be running — and the
    //    shortcut is ignored while the app is busy (on purpose: no undo in the middle of a save). Pressing once and
    //    waiting failed on a slow CI runner. Press again until the element is back; presses during the undo are ignored
    //    for the same reason, so it cannot undo twice.
    await waitFor(
      () => {
        if (!within(tree).queryByText('SerialNumber')) fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
        expect(within(tree).getByText('SerialNumber')).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });
});

describe('In-app help — instead of a manual (2026-10-08)', () => {
  beforeEach(() => {
    localStorage.removeItem('aas.start.v1');
    localStorage.removeItem('aas.tour.v1');
  });

  it('Help expands the current screen topic first, is searchable, and closes with Esc', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    fireEvent.click(screen.getByRole('button', { name: '? 도움말' }));
    const panel = screen.getByRole('dialog', { name: '도움말' });
    // A file is open, so "Editing values" is expanded at the top
    expect(within(panel).getByText('지금 화면')).toBeTruthy();
    expect(within(panel).getByText('요소 하나 — 트리에서 고르고 값을 바꾼 뒤 「저장」')).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('도움말 찾기'), { target: { value: '가상 PLC' } });
    expect(within(panel).getByText('현장 값 수집')).toBeTruthy();
    expect(within(panel).queryByText('내 계정')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '도움말' })).toBeNull();
    // F1 opens it too
    fireEvent.keyDown(window, { key: 'F1' });
    expect(screen.getByRole('dialog', { name: '도움말' })).toBeTruthy();
  });

  it('the tour finds every button it points to — if the screen changes and a button disappears, this catches it', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    fireEvent.click(screen.getByRole('button', { name: '? 도움말' }));
    fireEvent.click(screen.getByRole('button', { name: '▶ 화면 둘러보기' }));
    const card = screen.getByRole('dialog', { name: '화면 둘러보기' });
    const { fileTour } = await import('../src/help.js');
    expect(within(card).getByText(`1 / ${fileTour().length}`)).toBeTruthy();
    expect(within(card).getByText('트리')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: '다음' }));
    expect(within(card).getByText(`2 / ${fileTour().length}`)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: '건너뛰기' }));
    expect(screen.queryByRole('dialog', { name: '화면 둘러보기' })).toBeNull();
    expect(localStorage.getItem('aas.tour.v1')).toContain('file');
  });

  it('getting-started list — items check themselves when done, and can be reopened from help after closing', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const list = screen.getByRole('complementary', { name: '시작하기' });
    // A file is open, so the first item is done
    expect(await within(list).findByText('1 / 4')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: /^검사 결과 보기/ }));
    expect(await screen.findByRole('dialog', { name: '지적 목록' })).toBeTruthy();
    expect(await within(screen.getByRole('complementary', { name: '시작하기' })).findByText('2 / 4')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: '시작하기 목록 닫기' }));
    expect(screen.queryByRole('complementary', { name: '시작하기' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '? 도움말' }));
    fireEvent.click(screen.getByRole('button', { name: '시작하기 목록 보기' }));
    expect(screen.getByRole('complementary', { name: '시작하기' })).toBeTruthy();
  });
});
