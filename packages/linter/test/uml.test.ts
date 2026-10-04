/**
 * 가이던스용 UML 클래스 다이어그램.
 *
 * 근거: KTL 규정 §13 주의사항 3 — 모든 서브모델에 UML Diagram 첨부.
 * 🔴 모양의 근거는 **실제 제출 가이던스**(01-롤포밍기 V4.0 「그림 14~20」)다.
 *    여기서 지키는 것은 "그려진다"가 아니라 **그 문서의 그림과 같은 규칙으로 그려진다**이다.
 */
import { readAasx } from '@aas/aasx';
import { overviewUml, submodelUml } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const environment = readAasx(
  new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')),
).environment;
const find = (idShort: string) => environment.submodels!.find((s) => s.idShort === idShort)!;

describe('서브모델 UML — 문서의 그림 규칙', () => {
  const svg = submodelUml(find('DigitalNameplate'));

  it('프레임 탭에 `SMT <서브모델명>`을 적는다', () => {
    expect(svg).toContain('SMT DigitalNameplate');
  });

  it('약칭 스테레오타입을 쓴다 (SM · SMC · SML)', () => {
    expect(svg).toContain('«SM»');
    expect(svg).toContain('«SML»');
    expect(svg).toContain('«SMC»');
    // 종류 이름을 그대로 쓰지 않는다 — 문서는 약칭이다
    expect(svg).not.toContain('«SubmodelElementCollection»');
  });

  it('🔴 잎은 상자가 아니라 **속성 줄**로 나온다 — `+ 이름 : 타입 = "값"`', () => {
    expect(svg).toContain('+ SerialNumber : xs:string = &quot;EXM-RFL-2026-00127&quot;');
    expect(svg).toContain('+ ManufacturerName : MLP =');
    // Property가 제 상자를 갖지 않는다
    expect(svg).not.toContain('«Property»');
  });

  it('담는 요소는 부모의 속성 줄에도 나오고 제 상자도 갖는다', () => {
    expect(svg).toContain('+ Markings : SML'); // 부모의 속성 줄
    expect(svg).toContain('>Markings<'); // 제 상자 이름
  });

  it('🔴 다중도는 **부모**가 정한다 — 리스트의 자식이면 1..*', () => {
    // 문서: SM ◆—0..1— Markings(SML) ◆—1..*— Marking(SMC)
    expect(svg).toContain('>0..1<');
    expect(svg).toContain('>1..*<');
  });

  it('🔴 리스트 자식은 대표 하나만, 색인 꼬리를 뗀 이름으로', () => {
    // 파일에는 MarkingsEntry_0이지만 문서는 Marking으로 적는다
    expect(svg).toContain('>Marking<');
    expect(svg).not.toContain('MarkingsEntry_0');
  });

  it('긴 값은 잘라 준다 — 상자가 종이를 넘으면 문서에 못 쓴다', () => {
    expect(svg).toContain('...');
  });

  it('🔴 흰 바탕·검정 선 — 문서는 흰 종이다', () => {
    expect(svg).toContain('fill: #ffffff');
    expect(svg).toContain('#1b1b1b');
  });

  it('합성 마름모와 프레임을 그린다', () => {
    expect(svg).toContain('class="diamond"');
    expect(svg).toContain('class="frame"');
  });

  it('크기가 붙어 있어야 문서에 붙일 수 있다', () => {
    expect(svg).toMatch(/width="\d+" height="\d+"/);
  });

  it('MultiLanguageProperty의 언어 목록을 자식 상자로 그리지 않는다', () => {
    expect(svg).not.toContain('«undefined»');
  });

  it('글자에 든 <, & 를 그대로 넣지 않는다 (SVG가 깨진다)', () => {
    const out = submodelUml({ idShort: 'A<B&C', modelType: 'Submodel' } as never);
    expect(out).toContain('A&lt;B&amp;C');
  });

  it('속성이 많으면 잘라 내되 몇 개를 잘랐는지 적는다', () => {
    const few = submodelUml(find('DigitalNameplate'), { maxAttributes: 3 });
    expect(few).toMatch(/그 밖 \d+개/);
  });
});

describe('깊은 구조', () => {
  it('OperationalData의 3단 구조가 그려진다', () => {
    const svg = submodelUml(find('OperationalData'));
    for (const name of ['OperationalData', 'MaintenanceMonitoring', 'ConditionStatus']) {
      expect(svg).toContain(`>${name}<`);
    }
    expect(svg).toContain('+ RollWearStatus : xs:string = &quot;Normal&quot;');
  });
});

describe('🔴 서브모델을 끝까지 펼친다 (2026-09-21)', () => {
  /**
   * 예전 기본 깊이 3은 **실제 파일을 잘랐다**. 사용자가 가이던스 문서의 그림과
   * 우리 그림이 다르다고 지적해 실측한 결과 골든 7종 중 3종이 안쪽을 잃고 있었다.
   * 특히 TechnicalData는 담는 상자만 남고 **사양 값이 한 개도 나오지 않았다**.
   */
  const boxCount = (svg: string): number => (svg.match(/class="cls"/g) ?? []).length;

  it.each(environment.submodels!.map((sm) => sm.idShort!))(
    '%s — 기본 옵션이 담는 요소를 하나도 잘라내지 않는다',
    (idShort) => {
      const submodel = find(idShort);
      expect(boxCount(submodelUml(submodel))).toBe(
        boxCount(submodelUml(submodel, { maxDepth: 99 })),
      );
    },
  );

  it('TechnicalData에 실제 사양 값이 나온다 — 예전에는 0개였다', () => {
    const svg = submodelUml(find('TechnicalData'));
    // 맨 안쪽(4단) 잎들. 깊이 3에서는 이 상자들이 통째로 없었다.
    expect(svg).toContain('+ RollDiameter : xs:double = &quot;150.0&quot;');
    expect(svg).toContain('+ RatedMotorPower : xs:double = &quot;30.0&quot;');
  });

  it('HandoverDocumentation이 문서 낱장의 속성까지 내려간다', () => {
    const svg = submodelUml(find('HandoverDocumentation'));
    for (const name of ['DocumentIds', 'DocumentClassifications', 'DocumentVersions']) {
      expect(svg).toContain(`>${name}<`);
    }
    expect(svg).toContain('+ DocumentIdentifier : xs:string = &quot;DOC-03-01-0001&quot;');
  });
});

describe('전체 구성도', () => {
  const svg = overviewUml(environment);

  it('AAS가 뿌리이고 서브모델이 매달린다', () => {
    expect(svg).toContain('«AAS»');
    expect(svg).toContain('RollFormingMachine');
    for (const submodel of environment.submodels!) {
      expect(svg).toContain(`+ ${submodel.idShort} : SM`);
    }
  });
});
