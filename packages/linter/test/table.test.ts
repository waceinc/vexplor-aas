/**
 * Submodel element detail tables (regulation §13, note 5).
 *
 * Important: half of these tests are not "it builds a table" but **"it does not build one when it must not"**.
 *    The regulation says tables for IDTA standard template submodels are to be **omitted**.
 */
import { readAasx } from '@aas/aasx';
import {
  planFor,
  submodelInfo,
  submodelTable,
  submodelTables,
  smtTableCaption,
  submodelTablesHtml,
  tableCsv,
  tableHtml,
} from '@aas/linter';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const environment = readAasx(
  new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')),
).environment;
const find = (idShort: string) => environment.submodels!.find((s) => s.idShort === idShort)!;

describe('Deciding what to build', () => {
  /**
   * Important: the criterion was set by comparing against **the table layout of the actual submitted guidance (roll forming machine 01, V4.0)**.
   * In that document, only the two submodels without own-IRI elements have no table.
   */
  it('submodels containing equipment-specific elements (own IRIs) get a table', () => {
    for (const name of [
      'TechnicalData',
      'OperationalData',
      'HierarchicalStructures',
      'MaintenanceInstructions',
      'RollFormingSafety',
    ]) {
      expect(planFor(find(name)).kind).toBe('table');
    }
  });

  it('Important: no table without equipment-specific elements — the regulation says to omit it', () => {
    for (const name of ['DigitalNameplate', 'HandoverDocumentation']) {
      const plan = planFor(find(name));
      expect(plan.kind).toBe('info');
      expect(plan.reason).toContain('생략');
      expect(plan.specificCount).toBe(0);
    }
  });

  it('Important: not decided by name — even with an IDTA standard name, mixed-in equipment-specific content gets a table', () => {
    // MaintenanceInstructions and HierarchicalStructures are IDTA standard names,
    // but the real document has tables for them (because they contain equipment-specific content)
    expect(planFor(find('MaintenanceInstructions')).specificCount).toBeGreaterThan(0);
  });
});

describe('IDTA SMT table format — same shape as the real document', () => {
  const tables = submodelTables(environment, find('OperationalData'));

  it('each container element gets one table', () => {
    const names = tables.map((table) => table.idShort);
    expect(names).toContain('OperationalData');
    expect(names).toContain('MaintenanceMonitoring');
    expect(names).toContain('ConditionStatus');
  });

  it('the 5 header rows match the document (idShort · Class · semanticId · Parent · Explanation)', () => {
    const one = tables.find((table) => table.idShort === 'ConditionStatus')!;
    expect(one.className).toBe('SubmodelElementCollection');
    expect(one.semantic.idType).toBe('[IRI]');
    expect(one.parent).toBe('SMC "MaintenanceMonitoring"');
    expect(one.explanation).toBe('Condition Status');
  });

  it('the submodel itself has Parent `-`', () => {
    expect(tables[0]!.parent).toBe('-');
  });

  it('child rows have the form `[Prop]name` · `[type]value`', () => {
    const one = tables.find((table) => table.idShort === 'ConditionStatus')!;
    const row = one.children.find((child) => child.label === '[Prop]RollWearStatus')!;
    expect(row.value).toBe('[string]Normal');
    expect(row.semantic.definition).toBe('Roll Wear Status');
    expect(row.semantic.korean).toBe('롤 마모 상태');
    expect(row.cardinality).toBe('0..1');
  });

  it('container elements are written as `[-]N elements`', () => {
    const root = tables[0]!;
    const row = root.children.find((child) => child.label === '[SMC]MaintenanceMonitoring')!;
    expect(row.value).toBe('[-]2 elements');
  });

  it('IRDIs are marked [IRDI] and own IRIs [IRI]', () => {
    const technical = submodelTables(environment, find('TechnicalData'));
    const list = technical.find((table) => table.idShort === 'TechnicalPropertyAreas')!;
    expect(list.semantic.idType).toBe('[IRDI]');
  });

  it('Important: the IDTA origin link comes from supplementalSemanticIds — never invented', () => {
    const maintenance = submodelTables(environment, find('MaintenanceInstructions'));
    const tool = maintenance.find((table) => table.idShort === 'MaintenanceToolList')!;
    expect(tool.semantic.idtaOrigin).toContain('admin-shell.io');
  });

  it('HTML output is a table', () => {
    const html = submodelTablesHtml(tables);
    expect(html).toContain('idShort:');
    expect(html).toContain('[SME type]idShort');
    expect(html).toContain('border-collapse');
  });

  it('Important: every table gets a caption — same form as the document, above the table', () => {
    const html = submodelTablesHtml(tables, { from: 15, submodelName: 'OperationalData' });
    // matches the real guidance caption format, e.g. Table 5 TechnicalData - GeneralInformation
    expect(html).toContain('표 15 OperationalData - OperationalData');
    expect(html).toContain('표 16 OperationalData - MaintenanceMonitoring');
    // the caption comes before the table
    expect(html.indexOf('표 15 OperationalData')).toBeLessThan(html.indexOf('<table'));
  });

  it('numbering continues — one sequence across the whole document', () => {
    const first = smtTableCaption(1, 'TechnicalData', tables[0]!);
    expect(first).toBe(`표 1 TechnicalData - ${tables[0]!.idShort}`);
  });
});

describe('Table contents', () => {
  const rows = submodelTable(environment, find('OperationalData'));

  it('hierarchy is preserved — showing the structure is the point', () => {
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.some((row) => row.depth === 0)).toBe(true);
    expect(rows.some((row) => row.depth > 0)).toBe(true);
    expect(rows[0]!.path).not.toContain('.');
  });

  it('example values are included — the regulation requires "clear example data"', () => {
    expect(rows.some((row) => row.example !== '')).toBe(true);
  });

  it('description and semanticId are included (qualitative evaluation items)', () => {
    expect(rows.some((row) => row.description !== '')).toBe(true);
    expect(rows.every((row) => row.semanticId !== '')).toBe(true);
  });

  it('Important: container elements get no data type — it would be misleading', () => {
    const container = rows.find((row) => row.modelType === 'SubmodelElementCollection')!;
    expect(container.dataType).toBe('');
  });

  it('HTML pastes as a table — plain text alone is useless', () => {
    const html = tableHtml(rows);
    expect(html).toContain('<table');
    expect(html).toContain('<th>idShort</th>');
    expect(html).toContain('border-collapse');
  });

  it('Important: CSV gets a BOM — without it Excel garbles Hangul', () => {
    expect(tableCsv(rows).charCodeAt(0)).toBe(0xfeff);
  });

  it('escapes double quotes in CSV', () => {
    const csv = tableCsv([
      {
        depth: 0,
        path: 'X',
        idShort: 'X',
        modelType: 'Property',
        dataType: 'string',
        unit: '',
        example: '그는 "예"라고 했다',
        semanticId: '',
        description: '',
      },
    ]);
    expect(csv).toContain('"그는 ""예""라고 했다"');
  });
});

describe('Info for submodels whose table is omitted', () => {
  const info = submodelInfo(find('DigitalNameplate'));

  it('fills only what can be read from the file', () => {
    expect(info.elementCount).toBeGreaterThan(0);
    expect(info.dictionaries.length).toBeGreaterThan(0);
  });

  it('Important: unknowns are never invented — left as slots for a person to fill', () => {
    // the template origin link must be checked by a person on the IDTA Content Hub (note 2)
    expect(info.templateLink).toBe('');
    expect(info.toWrite.join(' ')).toContain('템플릿 원본 링크');
    expect(info.toWrite.join(' ')).toContain('용어사전 버전');
  });
});
