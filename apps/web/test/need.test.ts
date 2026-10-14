/**
 * 값 표의 「구분」 판정 — 필수 · 수집 · 선택 · 모름(components/inspector/need.ts).
 */
import { describe, expect, it } from 'vitest';
import type { SubmodelRequirement } from '../src/api.js';
import { needOf } from '../src/components/inspector/need.js';

const requirement: SubmodelRequirement = {
  submodelId: 'urn:sm',
  semanticId: 'urn:sem',
  elements: {
    ManufacturerName: { cardinality: 'One', required: true },
    SerialNumber: { cardinality: 'ZeroToOne', required: false },
    'Markings[].MarkingName': { cardinality: 'One', required: true },
  },
};

describe('값 표의 구분', () => {
  it('템플릿의 필수·선택을 그대로 쓴다 — 리스트 자식은 자리 번호를 지우고 맞춘다', () => {
    expect(needOf('ManufacturerName', 'ManufacturerName', requirement, undefined)).toBe('required');
    expect(needOf('SerialNumber', 'SerialNumber', requirement, undefined)).toBe('optional');
    expect(needOf('Markings[2].MarkingName', 'MarkingName', requirement, undefined)).toBe('required');
  });

  it('🔴 수집 연결에 같은 이름이 있으면 「수집」이 먼저다 — 필수여도 사람이 적을 칸이 아니다', () => {
    expect(needOf('ManufacturerName', 'ManufacturerName', requirement, new Set(['ManufacturerName']))).toBe('collected');
    // 템플릿이 없어도 수집 연결은 안다
    expect(needOf('MotorSpeed', 'MotorSpeed', undefined, new Set(['MotorSpeed']))).toBe('collected');
  });

  it('모르는 것은 지어내지 않는다 — 템플릿이 없거나 템플릿에 없는 항목은 모름', () => {
    expect(needOf('ManufacturerName', 'ManufacturerName', undefined, undefined)).toBe('unknown');
    expect(needOf('CustomField', 'CustomField', requirement, new Set())).toBe('unknown');
  });
});
