// @vitest-environment jsdom
/**
 * 저작 UI 통합 검증.
 *
 * 화면만 따로 흉내 내지 않는다 — fetch를 **진짜 API 핸들러**(@aas/api + 인메모리 저장소 + 린터)에
 * 물려 두고 돌린다. 그래서 "지적을 눌렀더니 그 요소가 열린다"가 실제로 성립하는지 확인된다.
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
 * 🔴 기다리는 예산을 **둘 다** 늘린다. 하나만 늘리면 고쳐지지 않는다(2026-10-02 실측).
 *
 * 이 파일은 화면만 흉내 내는 것이 아니라 **진짜 API·린터·저장소**를 함께 돌린다.
 * 테스트 전체(50여 파일)를 한꺼번에 돌리면 CPU를 나눠 쓰느라 한 번씩 기본 1초를
 * 넘겨 떨어졌다 — 제품의 문제가 아니라 재는 자의 문제다.
 *
 * 처음엔 `asyncUtilTimeout`만 1초→5초로 늘렸는데, **테스트 한 건의 제한시간이
 * 마침 5초(vitest 기본)라서** 「1초 만에 못 찾음」이 「5초에 통째로 시간 초과」로
 * 바뀌었을 뿐이었다. 기다림은 테스트 예산보다 **넉넉히 작아야** 한다 —
 * 그래야 실패했을 때 "무엇을 못 찾았는지"가 나온다.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
configure({ asyncUtilTimeout: 5000 });

// jsdom 환경에서는 import.meta.url이 http URL이라 파일 경로를 만들 수 없다. 저장소 뿌리 기준 상대경로를 쓴다
const goldenBytes = new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx'));

/** jsdom에는 없다. 트리가 창 높이를 재는 데만 쓴다 */
class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

async function mountApi(
  damage?: (env: ReturnType<typeof readAasx>['environment']) => void,
  options: { extraPackage?: boolean; aid?: boolean; auth?: { tokens: string[]; readOnlyTokens: string[] } } = {},
) {
  const store = new InMemoryStore();
  await store.init();
  const pkg = readAasx(goldenBytes);
  damage?.(pkg.environment);
  if (options.aid) pkg.environment.submodels!.push(aidSubmodel() as never);
  await store.importPackage({ name: '01-롤포밍기.aasx', package: pkg });

  // 가져오기 시험용 — 서브모델이 비어 있는 새 장비 한 대
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
    // 가짜 수집 어댑터 — 실제 OPC UA 왕복은 packages/opcua가 맡는다
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
    // 가짜 설비 훑기 — 진짜 프로토콜 왕복은 packages/opcua/test/browse.test.ts가 맡는다
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
        // 요소 이름으로 쓸 수 없는 글자가 든 태그 — 담을 때 바뀌어야 한다
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
   * 쿠키 단지 — 브라우저가 알아서 하는 일을 흉내 낸다. 없으면 로그인해도 다음 요청이
   * 로그인 안 한 것으로 가서, 로그인 **뒤**의 화면(계정 관리 등)을 시험할 수 없다.
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
  // 동시 편집을 흉내 내려면 테스트가 저장소를 직접 만질 수 있어야 한다
  return store;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  // jsdom은 레이아웃을 계산하지 않아 높이가 0이다. 가상 스크롤이 창을 못 잡으므로 높이를 준다
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 900, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * 지적 목록은 **팝업**이다(2026-09-01) — 오른쪽 칸은 수집(OPC UA)이 쓴다.
 * 헤더의 「위반 N건」을 눌러야 목록이 뜬다.
 */
async function openFindings(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /위반 \d+건/ }));
}

/** 묶음 만들기 화면에서 회사 바로 밑에 첫 후보 파일을 넣는다 — 트리 방식(2026-09-08) */
/**
 * 헤더 메뉴 안의 항목을 누른다.
 *
 * 🔴 2026-10-02에 헤더를 묶음 메뉴로 접었다 — 「새로 만들기」·「파일 목록」·「규칙」 따위가
 *    「파일▾」·「설정▾」 안으로 들어갔다. 테스트도 사람과 같은 길을 밟는다: 메뉴를 열고 고른다.
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

describe('저작 UI', () => {
  it('파일을 열면 트리와 린트 결과가 함께 뜬다', async () => {
    await mountApi();
    render(<App />);

    expect(await screen.findByText('DigitalNameplate')).toBeTruthy();
    expect(screen.getByText('OperationalData')).toBeTruthy();
    // 골든 파일은 위반 0건이다 (헤더 배지로 확인 — 지적 칸 제목도 같은 문구를 쓴다)
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });

  it('지적을 누르면 그 요소가 트리에서 열리고 속성 칸에 뜬다', async () => {
    // 첫 Property의 semanticId를 지워 KOSMO-SME-3을 만든다
    await mountApi((env) => {
      const target = env.submodels![0]!.submodelElements![0]!;
      delete (target as { semanticId?: unknown }).semanticId;
    });
    render(<App />);

    await openFindings();
    const finding = await screen.findByText('semanticId가 없습니다.');
    fireEvent.click(finding);

    // 속성 칸이 그 요소로 바뀐다 — 지적과 트리가 같은 좌표계를 쓴다는 증거
    const inspector = document.querySelector('.inspector') as HTMLElement;
    await waitFor(() => {
      expect(within(inspector).getByRole('heading').textContent).toBe('URIOfTheProduct');
    });
    expect(within(inspector).getByText('/submodels/0/submodelElements/0')).toBeTruthy();
  });

  it('AAS 지적을 누르면 AssetInformation이 열린다 — 예전엔 갈 곳이 없었다', async () => {
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
    // 지적이 가리키는 값이 화면에서 확인된다(선택 상자와 설명 목록 양쪽에 나타난다)
    expect(within(inspector).getAllByText('Instance').length).toBeGreaterThan(0);
  });

  it('CD 지적도 트리에서 열린다 — ConceptDescription 그룹 아래에 있다', async () => {
    await mountApi();
    render(<App />);

    // 골든 파일의 알려진 경고(CD idShort 중복) — 같은 규칙(KOSMO-CD-5)은 한 묶음으로 접힌다.
    // 묶음 안의 대상(ManufacturerName)을 눌러 그 요소로 간다
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

  it('용어(CD) 정의를 화면에서 고쳐 저장하면 서버를 거쳐 다시 나타난다', async () => {
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

  it('「고치기」를 누르면 위반이 사라지고 무엇을 고쳤는지 보여 준다', async () => {
    await mountApi((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
      env.submodels![1]!.kind = 'Instance';
    });
    render(<App />);

    const button = await screen.findByRole('button', { name: /^자동 고치기/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    // 바로 고치지 않는다 — 미리보기 팝업에서 항목별 전/후를 보고 반영한다(2026-09-11)
    const dialog = await screen.findByRole('dialog', { name: '자동 고치기 미리보기' });
    expect(within(dialog).getAllByRole('row').length).toBeGreaterThan(1);
    expect(within(dialog).getByText('Type')).toBeTruthy(); // assetKind 후
    // 지우는 교정(AASd-120)은 후 칸이 「—」가 아니라 「(지움)」 — 비어 보이지 않게
    expect(within(dialog).getAllByText('(지움)').length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /고른 \d+건 반영/ }));

    expect(await screen.findByText(/교정 \d+건/)).toBeTruthy();
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });

  it('미리보기에서 체크를 끈 항목은 고치지 않는다 — 고른 것만 반영', async () => {
    await mountApi((env) => {
      env.assetAdministrationShells![0]!.assetInformation.assetKind = 'Instance';
      env.submodels![1]!.kind = 'Instance';
    });
    render(<App />);
    // 위반 2건 + 골든 파일의 고칠 수 있는 경고들 — 단추 숫자는 그 합이다
    const button = await screen.findByRole('button', { name: /^자동 고치기 \d+건$/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    const dialog = await screen.findByRole('dialog', { name: '자동 고치기 미리보기' });
    // 전/후가 표에 보인다 — assetKind Instance → Type
    expect(within(dialog).getAllByText('Instance', { exact: true }).length).toBeGreaterThan(0);
    // 전부 끄고 assetKind 하나만 켠다 — kind=Instance 위반은 그대로 남아야 한다
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

  it('값을 고쳐 저장하면 서버를 거쳐 트리에 다시 나타난다', async () => {
    await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('URIOfTheProduct'));
    const editor = screen.getByLabelText('값') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'https://example.com/새-제품' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    // 화면 상태를 믿지 않고 서버에서 다시 읽어 온 값이 보여야 한다
    expect(await screen.findByText('https://example.com/새-제품')).toBeTruthy();
  });

  it('고칠 수 없는 지적은 이유를 남긴다', async () => {
    await mountApi((env) => {
      // Property 값 비우기 — KOSMO-SME-4는 사람이 채워야 한다(자동 교정 대상 아님).
      // DigitalNameplate·HandoverDocumentation은 규칙에서 면제라 OperationalData에서 고른다
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

describe('헤더 — 다음에 누를 것이 하나여야 한다', () => {
  it('파일이 없으면 편집·제출 줄이 없고, 열면 나타난다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByRole('button', { name: /^자동 고치기/ })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'AASX 내려받기' })).toBeTruthy();

    // 로고를 누르면 처음 화면 — 파일에 하는 동작은 사라진다
    fireEvent.click(within(header).getByRole('button', { name: /처음 화면으로|AAS Studio/ }));
    expect(within(header).queryByRole('button', { name: /^자동 고치기/ })).toBeNull();
    expect(within(header).queryByRole('button', { name: 'AASX 내려받기' })).toBeNull();
    expect(within(header).getByRole('button', { name: /^파일/ })).toBeTruthy();
  });

  it('위반이 있으면 「자동 고치기」가, 없으면 「AASX 내려받기」가 파란 버튼이다', async () => {
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

  it('위반이 남은 채 내려받으려 하면 먼저 묻고, 취소하면 받지 않는다', async () => {
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

describe('요소·서브모델 추가와 삭제', () => {
  it('선택한 컬렉션 아래에 요소를 만들고 지운다', async () => {
    await mountApi();
    render(<App />);

    // TechnicalData의 GeneralInformation(SMC)을 고른다
    fireEvent.click(await screen.findByText('GeneralInformation'));
    fireEvent.click(await screen.findByRole('button', { name: '요소 추가' }));

    fireEvent.change(screen.getByLabelText('새 요소 이름 (idShort)'), { target: { value: 'TestProbe' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));

    // 서버를 거쳐 다시 읽은 트리에 나타난다.
    // 지적 칸에도 같은 이름이 뜨므로(새 요소는 semanticId가 없다) 트리 안으로 좁혀 찾는다
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).getByText('TestProbe')).toBeTruthy());

    // 새 요소는 semanticId가 없으므로 린터가 지적한다 — 「고치기」로 이어지는 흐름이다
    await openFindings();
    await waitFor(() => {
      expect(screen.getAllByText('semanticId가 없습니다.').length).toBeGreaterThan(0);
    });
    // 팝업을 닫고 트리로 돌아온다
    fireEvent.click(screen.getByRole('button', { name: '지적 목록 닫기' }));

    vi.stubGlobal('confirm', () => true);
    fireEvent.click(within(tree).getByText('TestProbe'));
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(within(tree).queryByText('TestProbe')).toBeNull());
  });

  it('idShort가 명명 규칙에 어긋나면 추가를 막는다 (AASd-002)', async () => {
    await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('GeneralInformation'));
    fireEvent.click(await screen.findByRole('button', { name: '요소 추가' }));
    fireEvent.change(screen.getByLabelText('새 요소 이름 (idShort)'), { target: { value: '한글이름' } });

    expect(screen.getByText(/영문자로 시작하는 2자 이상/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '추가' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('서브모델을 만들면 규칙을 지킨 채로 생기고 AAS 참조까지 붙는다', async () => {
    await mountApi();
    render(<App />);

    await screen.findByText('DigitalNameplate');
    clickMenuItem('서브모델', '서브모델 추가');
    fireEvent.change(screen.getByLabelText('이름 (idShort)'), { target: { value: 'SafetyData' } });

    // 서버(린터 정책)에서 받은 iriBase로 id를 제안한다
    expect(
      screen.getByText('https://www.smart-factory.kr/ids/sm/RollFormingMachine/SafetyData/1/0'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    expect(await screen.findByText('SafetyData')).toBeTruthy();

    // 만들자마자 위반이 늘지 않아야 한다 — kind·semanticId·administration을 갖춰 만든다
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });
});

describe('서브모델 가져오기', () => {
  it('다른 파일에서 서브모델을 가져오면 CD까지 따라온다', async () => {
    await mountApi(undefined, { extraPackage: true });
    render(<App />);

    // 두 번째 파일(빈 장비)로 옮긴 뒤 가져온다
    await screen.findByText('DigitalNameplate');
    const picker = document.querySelector('header select') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'pkg_2' } });
    // 빈 장비라 서브모델은 없다. AAS 노드는 언제나 있다(지적이 갈 자리)
    await waitFor(() => {
      const tree = document.querySelector('.tree') as HTMLElement;
      expect(within(tree).queryByText('DigitalNameplate')).toBeNull();
      expect(within(tree).getByText('NewMachine')).toBeTruthy();
    });

    // 헤더의 「가져오기」 — 패널 안에도 같은 이름의 단추가 있다
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

    // 새 장비 이름으로 id가 다시 지어지고 CD가 함께 온다
    expect(await screen.findByText(/ConceptDescription \d+건 동반/)).toBeTruthy();
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).getByText('DigitalNameplate')).toBeTruthy());

    // 가져온 것 때문에 새 **위반**이 생기지 않는다.
    // (AASd-120은 경고다 — 원본에 있던 SML 자식 idShort가 따라온 것이고,
    //  KOSMO 제출은 막지 않지만 상호운용이 깨진다는 사실을 알린다)
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

describe('semanticId 직접 입력 (M4 축소판)', () => {
  it('입력하는 자리에서 검증하고, 저장하면 파일에 남는다', async () => {
    await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('SerialNumber'));
    const input = screen.getByLabelText('semanticId') as HTMLInputElement;

    // 허용 목록 밖 — 그 자리에서 막는다
    fireEvent.change(input, { target: { value: 'https://example.com/x' } });
    await openFindings();
    expect(await screen.findByText(/허용 목록 밖입니다/)).toBeTruthy();

    // IDTA 공식 IRI는 규정 충돌이라 경고
    fireEvent.change(input, { target: { value: 'https://admin-shell.io/zvei/nameplate/3/0/X' } });
    expect(screen.getByText(/KOSMO Validator는 이를 거부/)).toBeTruthy();

    // 파일에 있는 IRDI를 넣으면 통과
    fireEvent.change(input, { target: { value: '0112/2///61987#ABA951#009' } });
    expect(screen.getByText('표준 사전 IRDI 형식입니다.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'semanticId 저장' }));

    // 서버를 거쳐 다시 읽어도 남아 있다
    await waitFor(() => {
      const inspector = document.querySelector('.inspector') as HTMLElement;
      expect(within(inspector).getAllByText('0112/2///61987#ABA951#009').length).toBeGreaterThan(0);
    });
  });

  it('파일에 없는 id를 넣으면 CD가 없다고 알려 준다', async () => {
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

describe('동시 편집 충돌', () => {
  it('다른 곳에서 먼저 바뀌었으면 덮어쓰지 않고 알린다', async () => {
    const store = await mountApi();
    render(<App />);

    fireEvent.click(await screen.findByText('SerialNumber'));

    // 화면이 들고 있는 리비전이 낡도록, 다른 사람이 같은 서브모델을 고친 상황을 만든다
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

    // 남의 편집이 살아 있어야 한다 — 덮어쓰지 않았다는 증거
    const after = (await store.getIdentifiable(packageId, 'Submodel', nameplate.id))!;
    expect((after.content as { category?: string }).category).toBe('PARAMETER');

    // 다시 읽으면 최신 리비전을 받아 이어서 편집할 수 있다
    fireEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    await waitFor(() =>
      expect(screen.queryByText(/다른 곳에서 이 서브모델이 먼저 바뀌었습니다/)).toBeNull(),
    );
  });
});

/** AID 서브모델 — IDTA-02017 구조 그대로(EndpointMetadata.base · forms.href) */
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

/** AssetInformation 행은 이름과 종류가 같아 글자로는 집기 어렵다. 위치로 집는다 */
const assetInfoRow = (): HTMLElement | null =>
  document.querySelector('[data-pointer="/assetAdministrationShells/0/assetInformation"]');

describe('AssetInformation 편집', () => {
  it('assetKind를 고치면 린터 지적이 그 자리에서 생기고 사라진다', async () => {
    await mountApi();
    render(<App />);

    // 트리에서 AssetInformation을 고른다 — 위치로 집는다(같은 글자가 여러 곳에 있다)
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(assetInfoRow()).toBeTruthy());
    fireEvent.click(assetInfoRow()!);

    const kind = screen.getByLabelText('assetKind') as HTMLSelectElement;
    expect(kind.value).toBe('Type');

    fireEvent.change(kind, { target: { value: 'Instance' } });
    expect(screen.getByText(/형식\(Type\) 단위입니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    // 저장하면 서버가 린트해 지적이 올라온다
    await openFindings();
    expect(await screen.findByText(/assetKind가 Type이 아닙니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '지적 목록 닫기' }));

    // 되돌리면 사라진다
    fireEvent.click(assetInfoRow()!);
    fireEvent.change(screen.getByLabelText('assetKind'), { target: { value: 'Type' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => {
      const header = document.querySelector('header') as HTMLElement;
      expect(within(header).getByText('위반 0건')).toBeTruthy();
    });
  });

  it('globalAssetId를 지우고 저장하면 KOSMO-AAS-5가 뜬다', async () => {
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

describe('수집 화면 (M8)', () => {
  it('AID가 없으면 만들 길을 준다 — 안내로 끝내지 않는다', async () => {
    await mountApi();
    render(<App />);
    expect(await screen.findByText(/수집 연결.*이 없습니다|아직 수집 연결/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '수집' })).toBeNull();
    expect(screen.getByRole('button', { name: '수집 연결 만들기' })).toBeTruthy();
  });

  it('🔴 수집 연결 만들기 — 표만 채우면 AID가 생기고 수집이 된다', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));

    fireEvent.change(screen.getByLabelText('접속 주소'), {
      target: { value: 'opc.tcp://192.168.0.50:4840' },
    });
    // 손입력은 부차 경로다 — 기본은 「설비에서 불러오기」이므로 한 번 눌러 칸을 연다
    fireEvent.click(screen.getByRole('button', { name: '+ 손으로 입력' }));
    // 이름을 모델 요소(SerialNumber)와 맞춘다 — live 내보내기의 조건
    fireEvent.change(screen.getByLabelText('태그 1 이름'), { target: { value: 'SerialNumber' } });
    fireEvent.change(screen.getByLabelText('태그 1 주소'), { target: { value: 'ns=1;s=Serial' } });
    fireEvent.click(screen.getByRole('button', { name: /^만들기/ }));

    // 이름이 모두 맞으면 경고 없이 한 줄로 끝난다
    const toast = await screen.findByText(/수집 연결을 만들었습니다/);
    expect(toast.textContent).not.toMatch(/⚠/);

    // 🔴 파일에 진짜 AID가 생겼고 parseAid가 도로 읽을 수 있다
    const environment = await store.getEnvironment('pkg_1');
    const aid = environment.submodels!.find((sm) => sm.idShort === 'AssetInterfacesDescription');
    expect(aid).toBeTruthy();
    expect(JSON.stringify(aid)).toContain('opc.tcp://192.168.0.50:4840');

    // 화면에도 수집 표가 뜬다
    expect(await screen.findByRole('button', { name: '수집' })).toBeTruthy();
  });

  it('연결 상태가 점·글자로 보인다 — 수집 전에는 추측하지 않는다', async () => {
    await mountApi(undefined, { aid: true });
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // 아직 한 번도 안 붙어 봤다 — "수집 전"
    expect(await screen.findByText('수집 전')).toBeTruthy();

    // 수집해 보면 결과가 그대로 상태가 된다 (가짜 어댑터라 성공)
    fireEvent.click(screen.getByRole('button', { name: '수집' }));
    expect(await screen.findByText('연결됨')).toBeTruthy();
  });

  it('연결을 지울 수 있다 — 만들기·바꾸기만 있고 지우기가 없으면 안 된다', async () => {
    const store = await mountApi(undefined, { aid: true });
    render(<App />);
    await screen.findByText('DigitalNameplate');
    // AID가 있으니 수집 표와 「연결 지우기」가 보인다
    const remove = await screen.findByRole('button', { name: '연결삭제' });

    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    fireEvent.click(remove);

    expect(await screen.findByText('수집 연결을 지웠습니다.')).toBeTruthy();
    // 파일에서 진짜 사라졌고, 빈 상태로 돌아간다
    const environment = await store.getEnvironment('pkg_1');
    expect(
      environment.submodels!.find((sm) => sm.idShort === 'AssetInterfacesDescription'),
    ).toBeUndefined();
    expect(await screen.findByRole('button', { name: '수집 연결 만들기' })).toBeTruthy();
  });

  /** 모델에 없는 태그 하나를 넣는 데까지 — 두 경로가 여기서 갈린다 */
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
    // 입력 중에도 경고가 보인다 — 모델에 없는 이름이다
    expect(screen.getByText(/1개는 모델에 없는 이름/)).toBeTruthy();
  };

  it('🔴 자리를 함께 만들면 반쪽 연결이 되지 않는다 (기본 동작)', async () => {
    await fillOneUnknownTag();
    fireEvent.click(screen.getByRole('button', { name: /^만들기/ }));

    // 모델에 없던 항목이 OperationalData에 서고, 그래서 이름이 어긋나지 않는다
    const toast = await screen.findByText(/요소 1개 새로 세움/);
    expect(toast.textContent).not.toMatch(/⚠/);
  });

  it('🔴 설비에서 훑어 담으면 NodeId를 치지 않는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    fireEvent.click(await screen.findByRole('button', { name: '수집 연결 만들기' }));

    // 주소를 넣기 전에는 훑을 수 없다 — 어디로 붙을지 모른다
    expect(screen.getByRole('button', { name: '설비에서 불러오기' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('접속 주소'), {
      target: { value: 'opc.tcp://192.168.0.50:4840' },
    });
    fireEvent.click(screen.getByRole('button', { name: '설비에서 불러오기' }));

    // 찾은 태그가 지금 값과 함께 뜬다 — "이게 그 태그가 맞나"를 여기서 확인한다
    expect(await screen.findByText(/태그 2개/)).toBeTruthy();
    expect(screen.getByText('1200.5')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '전체 선택' }));
    fireEvent.click(screen.getByRole('button', { name: /고른 2개 담기/ }));

    // 주소가 그대로 태그 표에 들어간다 — 손으로 친 것이 아니다
    await waitFor(() =>
      expect((screen.getByLabelText('태그 1 주소') as HTMLInputElement).value).toBe(
        'ns=1;s=Machine.MotorSpeed',
      ),
    );
    expect((screen.getByLabelText('태그 1 이름') as HTMLInputElement).value).toBe('MotorSpeed');
    // 🔴 요소 이름으로 못 쓰는 글자(-)는 밑줄로 바뀐다 — 안 그러면 만들기에서 막힌다
    expect((screen.getByLabelText('태그 2 이름') as HTMLInputElement).value).toBe('Alarm_Active');
  });

  it('자리 만들기를 끄면 이름이 안 맞는다고 알려 준다', async () => {
    await fillOneUnknownTag();
    // 켜져 있는 기본값을 끈다 — 모델을 손대고 싶지 않은 사람의 경로
    // 자리 만들기는 「자세히」 안에 접혀 있다 — 펴서 끈다
    fireEvent.click(screen.getByText(/자세히 — 모델에 없는 항목의 자리/));
    fireEvent.click(screen.getByRole('checkbox', { name: /자리도 함께 만들기/ }));
    fireEvent.click(screen.getByRole('button', { name: /^만들기/ }));

    expect(await screen.findByText(/⚠ 모델과 이름이 안 맞는 태그 1개/)).toBeTruthy();
  });

  it('AID가 있으면 인터페이스와 주소를 보여 준다', async () => {
    await mountApi(undefined, { aid: true });
    render(<App />);

    expect(await screen.findByText('롤포밍기 제어반')).toBeTruthy();
    expect(screen.getByText('OPCUA')).toBeTruthy();
    expect(screen.getByText('opc.tcp://192.168.0.10:4840')).toBeTruthy();
    expect(screen.getByText('ns=1;s=Machine.MotorSpeed')).toBeTruthy();
  });

  it('「지금 수집」을 누르면 값이 들어오고, 모델은 그대로다', async () => {
    const store = await mountApi(undefined, { aid: true });
    render(<App />);

    const before = JSON.stringify(await store.getEnvironment('pkg_1'));
    fireEvent.click(await screen.findByRole('button', { name: '수집' }));

    expect(await screen.findByText(/수집 2건/)).toBeTruthy();
    // 표에 최근 값이 뜬다 (트리에도 false가 있어 수집 표 안으로 좁힌다)
    const table = document.querySelector('.collection') as HTMLElement;
    await waitFor(() => expect(within(table).getByText('1310.75')).toBeTruthy());
    expect(within(table).getByText('false')).toBeTruthy();

    // 🔴 수집은 편집이 아니다 — 모델은 그대로
    expect(JSON.stringify(await store.getEnvironment('pkg_1'))).toBe(before);

    // 🔴 AID를 넣으면 위반이 하나 뜬다: AID의 표준 semanticId(admin-shell.io)를
    // KOSMO가 화이트리스트 밖으로 본다(규정 충돌 ①). 수집 때문에 생긴 게 아니라
    // AID를 넣은 순간부터 있던 것이고, 「고치기」가 이관 대장을 남기며 해결한다
    await openFindings();
    expect(await screen.findByText(/semanticId가 허용 목록 밖입니다/)).toBeTruthy();
  });
});

describe('로그인 벽 (2026-10-02)', () => {
  const auth = { tokens: ['공장-토큰'], readOnlyTokens: [] };

  it('🔴 인증이 켜진 서버에서는 벽이 먼저 선다 — 파일이 보이면 안 된다', async () => {
    await mountApi(undefined, { auth });
    setToken(undefined);
    render(<App />);

    // 계정이 하나도 없는 서버라 「관리자 만들기」 쪽이 선다(계정이 있으면 「로그인」)
    expect(await screen.findByRole('button', { name: '관리자 만들기' })).toBeTruthy();
    expect(screen.queryByText('01-롤포밍기.aasx')).toBeNull();
    expect(screen.queryByText('DigitalNameplate')).toBeNull();
  });

  it('🔴 API 키를 쥐고 있으면 로그인 화면 없이 들어간다 — 기존 연동을 쫓아내지 않는다', async () => {
    await mountApi(undefined, { auth });
    setToken('공장-토큰');
    render(<App />);

    expect(await screen.findByText('DigitalNameplate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull();
    setToken(undefined);
  });

  it('🔴 인증이 꺼진 서버에서는 로그인 화면을 띄우지 않는다 — 넣을 계정이 없다', async () => {
    await mountApi();          // 토큰도 계정도 없다
    setToken(undefined);
    render(<App />);

    expect(await screen.findByText('DigitalNameplate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull();
  });

  it('계정이 하나도 없는 서버(토큰만 켠)에서는 첫 관리자 만들기가 뜬다', async () => {
    await mountApi(undefined, { auth });
    setToken(undefined);
    render(<App />);

    // setupNeeded라 「관리자 만들기」 단추가 선다
    expect(await screen.findByRole('button', { name: '관리자 만들기' })).toBeTruthy();
    expect(screen.getByLabelText(/비밀번호 확인/)).toBeTruthy();
  });
});

describe('설정 메뉴 · 계정 관리 (2026-10-04)', () => {
  const auth = { tokens: ['공장-토큰'], readOnlyTokens: [] };
  const PASSWORD = '열자가넘는비밀번호입니다';

  /** 첫 관리자를 화면으로 만들고 들어간다 */
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

  it('설정은 톱니가 아니라 글자다 — 이 화면에서 ⚙는 「설비」 표시다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByRole('button', { name: /^설정/ })).toBeTruthy();
    expect(within(header).queryByRole('button', { name: /^⚙/ })).toBeNull();
  });

  it('🔴 관리자가 화면에서 사람을 더한다 — 전에는 누를 자리가 없었다', async () => {
    await enterAsAdmin();
    clickMenuItem('설정', '계정 관리');
    const dialog = await screen.findByRole('dialog', { name: '계정' });

    // 지금은 나 하나
    expect(await within(dialog).findByText('owner')).toBeTruthy();

    const form = within(dialog).getByRole('button', { name: '계정 만들기' }).closest('form') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('로그인 이름'), { target: { value: 'kim' } });
    fireEvent.change(within(form).getByLabelText('표시 이름'), { target: { value: '김편집' } });
    fireEvent.change(within(form).getByLabelText('처음 비밀번호'), { target: { value: PASSWORD } });
    fireEvent.click(within(form).getByRole('button', { name: '계정 만들기' }));

    expect(await within(dialog).findByText('계정을 만들었습니다.')).toBeTruthy();
    expect(within(dialog).getByText('김편집')).toBeTruthy();
  });

  it('서버가 거절하면 그 까닭을 그대로 보인다 — 짧은 비밀번호', async () => {
    await enterAsAdmin();
    clickMenuItem('설정', '계정 관리');
    const dialog = await screen.findByRole('dialog', { name: '계정' });
    const form = within(dialog).getByRole('button', { name: '계정 만들기' }).closest('form') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('로그인 이름'), { target: { value: 'kim' } });
    fireEvent.change(within(form).getByLabelText('처음 비밀번호'), { target: { value: '짧다' } });
    fireEvent.click(within(form).getByRole('button', { name: '계정 만들기' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('10자');
  });

  it('마지막 관리자는 잠기지 않는다 — 잠그면 아무도 계정을 다룰 수 없다', async () => {
    await enterAsAdmin();
    clickMenuItem('설정', '계정 관리');
    const dialog = await screen.findByRole('dialog', { name: '계정' });
    await within(dialog).findByText('owner');
    fireEvent.click(within(dialog).getByRole('button', { name: '잠그기' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('마지막 관리자');
  });
});

describe('첨부 파일', () => {
  /**
   * 🔴 이것이 제출물의 실체다. HandoverDocumentation의 매뉴얼 PDF가 AASX 안에 실제로
   * 들어가야 하고, 지금까지는 화면에서 넣을 길이 없었다(값=경로만 고칠 수 있었다).
   */
  it('File 요소에 파일을 붙이면 패키지 안에 들어가고 value가 그 파트를 가리킨다', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // HandoverDocumentation → … → DigitalFilesEntry_0 까지 펼친다
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

    // 붙기 전에는 "붙어 있음"이 파일명만 보여 준다(값은 있으나 패키지에는 파트가 없다)
    const inspector = document.querySelector('.inspector') as HTMLElement;
    expect(within(inspector).getByText(/첨부 파일/)).toBeTruthy();

    const before = (await store.packageFiles('pkg_1')).length;
    const chooser = within(inspector).getByLabelText('첨부 파일') as HTMLInputElement;
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], '설치매뉴얼.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(chooser, { target: { files: [pdf] } });

    // 화면이 사실을 알려 준다
    expect(await screen.findByText(/설치매뉴얼\.pdf.*붙였습니다/)).toBeTruthy();

    // 🔴 진짜로 패키지에 들어갔는가 — 화면 문구가 아니라 저장소를 본다
    const after = await store.packageFiles('pkg_1');
    expect(after.length).toBe(before + 1);
    const added = after.find((file) => file.part.includes('설치매뉴얼.pdf'));
    expect(added).toBeTruthy();
    expect(added!.contentType).toBe('application/pdf');
    expect([...added!.data.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);

    // 모델의 File.value도 그 파트를 가리켜야 한다 — 안 그러면 파일만 떠 있는 꼴이다
    const environment = await store.getEnvironment('pkg_1');
    const found = JSON.stringify(environment).includes(`file://${added!.part}`);
    expect(found).toBe(true);
  });
});

describe('순서 바꾸기 · 복제 — 트리에서 바로 (끌어서 놓기 · 우클릭 메뉴 · Alt+↑↓)', () => {
  const namesOf = async (store: Awaited<ReturnType<typeof mountApi>>): Promise<(string | undefined)[]> =>
    (await store.getEnvironment('pkg_1')).submodels![0]!.submodelElements!.map((e) => e.idShort);

  it('트리 행에서 Alt+↓면 파일 안 순서가 바뀌고 선택은 그 요소를 따라간다', async () => {
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
    // 선택이 따라갔다 — 속성 칸 제목이 그대로 SerialNumber
    await waitFor(() => expect(within(inspector).getByRole('heading', { name: 'SerialNumber' })).toBeTruthy());
  });

  it('끌어서 다른 형제 아래에 놓으면 그 자리로 간다', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    const source = (within(tree).getByText('SerialNumber').closest('.row') as HTMLElement);
    const target = (within(tree).getByText('YearOfConstruction').closest('.row') as HTMLElement);
    const before = await namesOf(store);

    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => undefined };
    fireEvent.dragStart(source, { dataTransfer });
    // 대상 행의 아래쪽 절반에 올린다 → 「그 아래에」
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

  it('우클릭 메뉴 「사본 만들기」는 담는 요소에만 — Markings_2가 바로 아래에 생기고 그것이 선택된다', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    // 낱개 Property에는 사본이 없다 — 같은 값의 X_2가 생길 뿐이라 뜻이 없다(사용자 2026-09-09)
    fireEvent.contextMenu((within(tree).getByText('SerialNumber').closest('.row') as HTMLElement));
    const leafMenu = await screen.findByRole('menu', { name: 'SerialNumber 메뉴' });
    expect(within(leafMenu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      '↑ 한 칸 위로',
      '↓ 한 칸 아래로',
      '삭제',
    ]);
    fireEvent.keyDown(window, { key: 'Escape' });

    // 담는 요소(SML) — 두 번째 인증 마크 묶음처럼 구조째 하나 더
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

describe('이름(idShort) 바꾸기', () => {
  it('요소 이름을 바꾸면 트리와 파일에 함께 반영된다', async () => {
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

    // 🔴 화면만이 아니라 파일이 바뀌었는가
    const environment = await store.getEnvironment('pkg_1');
    expect(JSON.stringify(environment)).toContain('"SerialNo"');
  });

  it('🔴 형제와 이름이 겹치면 막는다 — 겹치면 엉뚱한 요소가 조용히 고쳐진다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('SerialNumber'));

    const inspector = document.querySelector('.inspector') as HTMLElement;
    fireEvent.change(within(inspector).getByLabelText('이름'), {
      target: { value: 'YearOfConstruction' }, // 같은 서브모델에 이미 있다
    });
    fireEvent.click(within(inspector).getByRole('button', { name: '이름 바꾸기' }));

    expect(await screen.findByText(/이미 「YearOfConstruction」이\(가\) 있습니다/)).toBeTruthy();
    // 원래 이름이 그대로 남아 있어야 한다
    expect(within(tree).getByText('SerialNumber')).toBeTruthy();
  });

  it('🔴 리스트 자식에는 이름 칸을 주지 않는다 (AASd-120)', async () => {
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

describe('트리에서 찾기', () => {
  it('이름으로 걸러 준다 — 거기까지 가는 길도 함께 남는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    fireEvent.change(screen.getByLabelText('트리에서 찾기'), { target: { value: 'serial' } });

    const tree = document.querySelector('.tree') as HTMLElement;
    // 서브모델의 Property와 같은 이름의 ConceptDescription이 함께 걸린다 — 둘 다 맞는 결과다
    await waitFor(() => expect(within(tree).getAllByText('SerialNumber').length).toBeGreaterThan(0));
    // 걸린 것과 조상만 남는다 — 형제는 사라진다
    expect(within(tree).queryByText('YearOfConstruction')).toBeNull();
    expect(within(tree).getByText('DigitalNameplate')).toBeTruthy(); // 길
    // 몇 건인지 알려 준다
    const search = document.querySelector('.search') as HTMLElement;
    expect(within(search).getByText(/\d+건/)).toBeTruthy();
  });

  it('값과 semanticId로도 찾는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const box = screen.getByLabelText('트리에서 찾기');
    fireEvent.change(box, { target: { value: 'EXM-RFL-2026' } }); // 값
    const tree = document.querySelector('.tree') as HTMLElement;
    await waitFor(() => expect(within(tree).getByText('SerialNumber')).toBeTruthy());

    fireEvent.change(box, { target: { value: '0173-1#02' } }); // semanticId
    await waitFor(() => expect(within(tree).queryAllByText(/./).length).toBeGreaterThan(0));
    expect(screen.queryByText('없음')).toBeNull();
  });

  it('못 찾으면 없다고 말한다 — 빈 트리만 보여 주지 않는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    fireEvent.change(screen.getByLabelText('트리에서 찾기'), {
      target: { value: '있을리없는이름' },
    });
    expect(await screen.findByText('없음')).toBeTruthy();
  });

  it('지우면 원래 트리로 돌아온다', async () => {
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

describe('새로 만들기 — 설비와 공정', () => {
  /**
   * 🔴 빈 AAS를 만들지 않는다는 것이 요점이다. KOSMO는 서브모델 4종을 요구하고
   * 총 개수를 6~8종으로 묶는다 — 만들자마자 위반 0건이어야 한다.
   */
  it('만들면 규칙을 지킨 뼈대가 나온다 (위반 0건)', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.change(screen.getByLabelText('설비 이름'), { target: { value: 'PressMachine' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));

    expect(await screen.findByText(/새 설비 「PressMachine」/)).toBeTruthy();
    // 태어나자마자 통과해야 한다
    const header = document.querySelector('header') as HTMLElement;
    await waitFor(() => expect(within(header).getByText('위반 0건')).toBeTruthy());

    const tree = document.querySelector('.tree') as HTMLElement;
    for (const required of ['DigitalNameplate', 'HandoverDocumentation', 'TechnicalData', 'OperationalData']) {
      expect(within(tree).getByText(required)).toBeTruthy();
    }
    expect(within(tree).getByText('PressMachine')).toBeTruthy(); // AAS
  });

  it('설비 고유 서브모델을 더 넣을 수 있다', async () => {
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
    // 7종이 되어도 범위(6~8) 안이다
    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByText('위반 0건')).toBeTruthy();
  });

  /**
   * 공정 — 여러 설비로 이루어진 단위.
   *
   * 🔴 요점은 **설비 파일을 고르기만 하면 매달리는가**이다. 이름과 Asset 주소를 손으로
   * 옮겨 적게 하면 거기서 오타가 나고, 그 값이 두 파일을 잇는 유일한 끈이라 조용히 끊긴다.
   */
  it('공정을 만들면 「무엇으로 이루어졌나」가 나온다', async () => {
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

    // 계층 패널이 진입점을 보여 준다
    const panel = await screen.findByText('공정·설비 구성');
    expect(panel).toBeTruthy();
    const hierarchy = document.querySelector('.hierarchy') as HTMLElement;
    expect(within(hierarchy).getByText('WeldingProcess')).toBeTruthy();
    expect(within(hierarchy).getByText(/아직 아무것도 들어 있지 않습니다/)).toBeTruthy();
  });

  it('올려 둔 설비를 골라 넣으면 목록에 나온다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingProcess' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/새 묶음 「WeldingProcess」/);

    const hierarchy = document.querySelector('.hierarchy') as HTMLElement;
    // 만든 뒤에도 같은 트리 편집기 — 회사 줄의 「＋ 설비」 → 올려 둔 골든 파일 고르기 → 넣기
    addFirstCandidate(hierarchy);

    await waitFor(() =>
      expect(
        within(document.querySelector('.hierarchy') as HTMLElement).getByText('RollFormingMachine'),
      ).toBeTruthy(),
    );
    // 매달아도 규칙 위반이 생기지 않는다
    const header = document.querySelector('header') as HTMLElement;
    await waitFor(() => expect(within(header).getByText('위반 0건')).toBeTruthy());
  });

  it('만들기 화면에서 설비를 골라 한 번에 넣는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });

    // 열려 있는 설비가 후보로 나온다
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    addFirstCandidate(parts);

    // 트리 자체가 미리보기다 — 회사 밑에 설비가 보인다
    expect(parts.textContent).toContain('WeldingLine');
    expect(parts.textContent).toContain('RollFormingMachine');

    fireEvent.click(screen.getByRole('button', { name: '만들기' }));

    // 만들면서 함께 들어간다 — 빈 공정을 먼저 보게 하지 않는다
    expect(await screen.findByText(/1건과 함께 만들었습니다/)).toBeTruthy();
    await waitFor(() =>
      expect(
        within(document.querySelector('.hierarchy') as HTMLElement).getByText('RollFormingMachine'),
      ).toBeTruthy(),
    );
  });

  /**
   * 🔴 「올려 둔 파일 없음」에서 막히던 자리(사용자 2026-09-09).
   * 후보 목록은 **이미 서버에 올라간 것**만 보여 준다 — 처음 쓰는 사람은 올린 파일이 하나도 없다.
   * 그 줄에서 바로 PC 폴더의 .aasx를 올릴 수 있어야 한다.
   */
  it('구성 트리에서 PC 폴더의 .aasx를 그 자리에서 올려 넣는다', async () => {
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
    // 버튼이 그 줄에 있다 — 누르면 열리는 것은 OS 파일 상자라 여기서는 숨은 input을 직접 흉내 낸다
    expect(within(parts).getByRole('button', { name: 'PC에서 가져오기' })).toBeTruthy();
    const chooser = parts.querySelector('.build-adder input[type="file"]') as HTMLInputElement;
    fireEvent.change(chooser, { target: { files: [new File([goldenBytes], '02-절단기.aasx')] } });

    // 올린 파일이 후보에 붙고, **고른 상태로** 돌아온다 — 사람이 다시 찾아 고르지 않는다
    await waitFor(() => expect(select.options.length).toBe(before + 1));
    await waitFor(() => expect(select.value).not.toBe(''));

    fireEvent.click(within(parts).getByRole('button', { name: '넣기' }));
    expect(parts.textContent).toContain('RollFormingMachine');
  });

  it('🔴 첫 화면에서 공정을 만들고 「PC에서 가져오기」로 올려도 만들던 트리가 남는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    // 로고로 첫 화면에 나와서 만든다 — 첫 화면의 폼은 busy가 되면 세 칸 화면으로 갈아타며 사라졌다(2026-09-09 제보)
    fireEvent.click(screen.getByTitle('처음 화면으로'));
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WaceFactory' } });

    const parts = document.querySelector('.pick-parts') as HTMLElement;
    fireEvent.click(within(parts).getByRole('button', { name: '＋ 공정' }));
    fireEvent.change(screen.getByLabelText('공정 이름'), { target: { value: 'PressLine' } });
    fireEvent.click(within(parts).getByRole('button', { name: '넣기' }));
    expect(parts.textContent).toContain('PressLine');
    fireEvent.click(within(parts).getAllByRole('button', { name: '＋ 설비' })[1]!); // 공정 줄의 것

    const chooser = parts.querySelector('.build-adder input[type="file"]') as HTMLInputElement;
    fireEvent.change(chooser, { target: { files: [new File([goldenBytes], '02-절단기.aasx')] } });

    // 올라간 뒤에도 폼·공정·입력 줄이 그대로이고, 올린 파일이 골라져 있다
    const select = () => document.querySelector('.pick-parts .build-adder select') as HTMLSelectElement | null;
    await waitFor(() => expect(select()?.value).toBeTruthy());
    expect(screen.getByLabelText('① 이름 (회사·공정·라인)')).toHaveProperty('value', 'WaceFactory');
    expect((document.querySelector('.pick-parts') as HTMLElement).textContent).toContain('PressLine');
    fireEvent.click(within(document.querySelector('.pick-parts') as HTMLElement).getByRole('button', { name: '넣기' }));
    expect((document.querySelector('.pick-parts') as HTMLElement).textContent).toContain('RollFormingMachine');
  });

  it('HierarchicalStructures 줄에 "이건 무엇"이 붙는다 — 설비 파일은 부품, 회사 파일은 구성도', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    const tree = () => document.querySelector('.tree') as HTMLElement;
    const hsRow = () => (within(tree()).getByText('HierarchicalStructures').closest('.row') as HTMLElement).textContent ?? '';
    expect(hsRow()).not.toContain('부품 구성'); // 설비 파일에는 안 단다(사용자 2026-09-09)

    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WaceFactory' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText('공정·설비 구성');
    await waitFor(() => expect(hsRow()).toContain('회사·공정 구성도'));
  });

  it('회사 파일의 ▦ 공정·⚙ 설비·맨 위 AAS 줄에도 「⋯」 메뉴가 있다 — 등록 편의(사용자 2026-09-09)', async () => {
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

  it('㉯ 자식 설비를 펼치면 그 서브모델이 그 자리에서 보인다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // 골든 설비를 넣은 공정을 만든다
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    addFirstCandidate(parts);
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/1건과 함께 만들었습니다/);

    // 펼친다 — 파일 구조는 그대로고 화면에서만 이어 붙는다
    const hierarchy = document.querySelector('.hierarchy') as HTMLElement;
    await waitFor(() => expect(within(hierarchy).getByText('RollFormingMachine')).toBeTruthy());
    fireEvent.click(hierarchy.querySelector('.hier-toggle') as HTMLElement);

    const detail = await waitFor(() => {
      const found = hierarchy.querySelector('.hier-sublist');
      if (!found) throw new Error('아직');
      return found as HTMLElement;
    });
    // 설비의 서브모델이 그대로 보인다
    expect(within(detail).getByText('DigitalNameplate')).toBeTruthy();
    expect(within(detail).getByText('TechnicalData')).toBeTruthy();
    expect(within(hierarchy).getByText('이 설비 파일 열기 →')).toBeTruthy();
  });

  it('공정 트리가 「공정 → 장비 → 장비별 서브모델」로 그려진다', async () => {
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

    // 왼쪽 트리에 설비 가지가 생긴다 — 파일 구조가 아니라 화면에서 이어 붙인 것이다
    const tree = document.querySelector('.tree') as HTMLElement;
    const asset = await waitFor(() => {
      const row = [...tree.querySelectorAll('[data-model-type="LinkedAsset"]')].find((r) =>
        r.textContent?.includes('RollFormingMachine'),
      );
      if (!row) throw new Error('아직');
      return row as HTMLElement;
    });

    // 펼치면 「BOM (n)」 접힘이 먼저, 그다음 그 설비의 서브모델이 나온다 — 부품은 접혀 있다(2026-09-08)
    fireEvent.click(asset);
    await waitFor(() => {
      const labels = [...tree.querySelectorAll('[role="treeitem"]')].map((r) => r.textContent ?? '');
      const at = labels.findIndex((t) => t.includes('RollFormingMachine') && t.includes('LinkedAsset'));
      const below = labels.slice(at + 1, at + 14).join(' ');
      expect(below).toContain('BOM ('); // 부품 서랍(접힘)
      expect(below).not.toContain('Uncoiler');
      expect(below).toContain('DigitalNameplate'); // 설비 자신의 서브모델
      expect(below).toContain('RollFormingSafety');
    });
    // 서랍을 펼치면 부품이 Part로 나온다
    const drawer = [...tree.querySelectorAll('[role="treeitem"]')].find((r) => r.textContent?.includes('BOM ('))!;
    fireEvent.click(drawer);
    await waitFor(() => {
      const labels = [...tree.querySelectorAll('[role="treeitem"]')].map((r) => r.textContent ?? '');
      expect(labels.some((t) => t.includes('Uncoiler') && t.includes('Part'))).toBe(true);
    });
  });

  it('파일 목록에서 파일마다 지울 수 있다', async () => {
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

  it('파일 목록에서 여러 개를 체크해 한 번에 지운다', async () => {
    await mountApi(undefined, { extraPackage: true });
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    expect(within(list).getByText('열린 파일 2건')).toBeTruthy();
    // 아무것도 안 골랐으면 눌리지 않는다
    const bulk = within(list).getByRole('button', { name: /고른 0건 지우기/ }) as HTMLButtonElement;
    expect(bulk.disabled).toBe(true);

    fireEvent.click(within(list).getByLabelText('전체 고르기'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(list).getByRole('button', { name: /고른 2건 지우기/ }));
    // 확인 문구에 둘 다 이름이 나온다
    await waitFor(() => expect(confirm.mock.calls.some((call) => /2건을 목록에서 지웁니다/.test(String(call[0])))).toBe(true));
    await screen.findByText(/파일 2건을 지웠습니다/);
    // 남은 것이 없으니 첫 화면
    expect(await screen.findByRole('button', { name: 'AASX 파일 열기' })).toBeTruthy();
    confirm.mockRestore();
  });

  it('편집기 「닫기」로 설비 추가 화면에 돌아올 수 있다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // 공정을 만들고 트리에서 뭔가 고른다 — 편집기가 가운데를 차지한다
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

    // 🔴 닫기가 없으면 설비 추가 화면으로 돌아올 방법이 없다(실측으로 잡힌 구멍)
    fireEvent.click(screen.getByRole('button', { name: /닫기 ✕/ }));
    expect(await screen.findByText('공정·설비 구성')).toBeTruthy();
  });

  it('서브모델을 고르면 값 표가 나오고, 한 번에 저장된다', async () => {
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
    // Property·MLP가 줄로 나온다
    expect(within(table).getByText('SerialNumber')).toBeTruthy();
    const inputs = table.querySelectorAll('input');
    expect(inputs.length).toBeGreaterThan(5);

    // 한 칸 고치면 단추가 "바뀐 1개 저장"으로 바뀌고, 저장하면 서버 값이 바뀐다
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

  it('🔴 장비명이 id에 들어간다 — 아무 글자나 받지 않는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('파일', '새로 만들기');
    fireEvent.change(screen.getByLabelText('설비 이름'), { target: { value: '프레스 기계' } });

    expect(screen.getByText(/영문으로 시작하고/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '만들기' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('규칙·규약 화면', () => {
  /**
   * 🔴 요점: **판정 근거를 보여 준다.** 그리고 이 도구가 합격을 정하지 않는다는 사실을
   *    맨 위에 둔다 — 제출처가 둘을 혼동하면 곤란하다.
   */
  it('지금 도는 규칙을 그대로 보여 준다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    clickMenuItem('설정', '규칙과 규약 보기');

    expect(await screen.findByText(/이 도구가 지키는 규칙과 규약/)).toBeTruthy();
    const panel = document.querySelector('.rules') as HTMLElement;
    // 규칙 id가 실제로 나온다
    expect(within(panel).getByText('AASd-120')).toBeTruthy();
    expect(within(panel).getByText('PKG-EMPTY-ARRAY')).toBeTruthy();
  });

  it('🔴 합격 판정 주체를 먼저 밝힌다 — 이 도구가 정하지 않는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    clickMenuItem('설정', '규칙과 규약 보기');

    const panel = (await screen.findByText(/합격은 누가 정하는가/)).closest('section')!;
    expect(within(panel).getByText('KOSMO Validator')).toBeTruthy();
    expect(within(panel).getByText(/미리 걸러 주는 사전 점검/)).toBeTruthy();
  });

  it('규정 충돌에서 무엇을 골랐는지 표시한다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');
    clickMenuItem('설정', '규칙과 규약 보기');
    await screen.findByText(/규정이 충돌할 때/);

    const panel = document.querySelector('.rules') as HTMLElement;
    expect(within(panel).getAllByText(/지금 이것/).length).toBe(5);
  });

  it('계층으로 걸러 볼 수 있다', async () => {
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
 * 파일 지우기.
 *
 * 🔴 요점은 **가리키는 곳이 있으면 먼저 알려 주는가**이다. 공정은 globalAssetId라는 끈
 * 하나로 설비를 가리킬 뿐이라, 설비를 지워도 공정 파일은 멀쩡해 보인다 —
 * 끊어진 사실이 화면 어디에도 나타나지 않는다.
 */
describe('파일 지우기', () => {
  it('확인을 받고 지운다', async () => {
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

  it('취소하면 지우지 않는다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    fireEvent.click(within(list).getAllByRole('button', { name: '지우기' })[0]!);

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.queryByText(/지웠습니다/)).toBeNull();
    // 트리가 그대로다
    expect(screen.getByText('DigitalNameplate')).toBeTruthy();
    confirm.mockRestore();
  });

  it('🔴 이 설비를 가리키는 공정이 있으면 지우기 전에 알려 준다', async () => {
    await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    // 이 설비를 넣은 공정을 하나 만든다
    clickMenuItem('파일', '새로 만들기');
    fireEvent.click(screen.getByRole('button', { name: '그룹(회사/공정)' }));
    fireEvent.change(screen.getByLabelText('① 이름 (회사·공정·라인)'), { target: { value: 'WeldingLine' } });
    const parts = document.querySelector('.pick-parts') as HTMLElement;
    addFirstCandidate(parts);
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await screen.findByText(/1건과 함께 만들었습니다/);

    // 그 설비로 돌아가 지우려 한다
    const header = document.querySelector('header') as HTMLElement;
    const select = within(header).getByRole('combobox') as HTMLSelectElement;
    const machine = [...select.options].find((o) => o.text.includes('롤포밍기'))!;
    fireEvent.change(select, { target: { value: machine.value } });
    await waitFor(() => expect(screen.getByText('DigitalNameplate')).toBeTruthy());

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    clickMenuItem('파일', '파일 목록');
    const list = document.querySelector('.file-list') as HTMLElement;
    // 목록에서 롤포밍기 줄의 지우기를 누른다
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

describe('되돌리기 — 실수했을 때 뒤로가기', () => {
  it('처음엔 꺼져 있고, 요소를 지우면 켜지며, 누르면 요소가 돌아오고 「다시 하기」가 켜진다', async () => {
    const store = await mountApi();
    render(<App />);
    await screen.findByText('DigitalNameplate');

    const undo = screen.getByRole('button', { name: '되돌리기' });
    const redo = screen.getByRole('button', { name: '다시 하기' });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    expect((redo as HTMLButtonElement).disabled).toBe(true);

    // 실수: SerialNumber를 지운다
    const tree = document.querySelector('.tree') as HTMLElement;
    fireEvent.click(within(tree).getByText('SerialNumber'));
    const inspector = document.querySelector('.inspector') as HTMLElement;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(inspector).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(within(tree).queryByText('SerialNumber')).toBeNull());

    // 버튼이 켜지고 무엇을 되돌리는지 title로 말한다
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

  it('Ctrl+Z로도 된다 — 입력 칸 밖에서만', async () => {
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

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(within(tree).getByText('SerialNumber')).toBeTruthy());
  });
});
