/**
 * UML class diagrams for the guidance document.
 *
 * Basis: KTL regulation §13, note 3 — attach a UML diagram for every submodel.
 * Important: the shape is based on **the actual submitted guidance** (roll forming machine 01, V4.0, "Figures 14-20").
 *    What is guarded here is not "it renders" but **it renders by the same rules as that document's figures**.
 */
import { readAasx } from '@aas/aasx';
import { overviewUml, submodelUml } from '@aas/linter';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const environment = readAasx(
  new Uint8Array(readFileSync('tests/fixtures/01-롤포밍기-공34.aasx')),
).environment;
const find = (idShort: string) => environment.submodels!.find((s) => s.idShort === idShort)!;

describe('Submodel UML — the document figure rules', () => {
  const svg = submodelUml(find('DigitalNameplate'));

  it('writes `SMT <submodel name>` on the frame tab', () => {
    expect(svg).toContain('SMT DigitalNameplate');
  });

  it('uses abbreviated stereotypes (SM · SMC · SML)', () => {
    expect(svg).toContain('«SM»');
    expect(svg).toContain('«SML»');
    expect(svg).toContain('«SMC»');
    // full type names are not used — the document uses abbreviations
    expect(svg).not.toContain('«SubmodelElementCollection»');
  });

  it('Important: leaves appear as **attribute lines**, not boxes — `+ name : type = "value"`', () => {
    expect(svg).toContain('+ SerialNumber : xs:string = &quot;EXM-RFL-2026-00127&quot;');
    expect(svg).toContain('+ ManufacturerName : MLP =');
    // a Property does not get its own box
    expect(svg).not.toContain('«Property»');
  });

  it('container elements appear as an attribute line in the parent and also get their own box', () => {
    expect(svg).toContain('+ Markings : SML'); // attribute line in the parent
    expect(svg).toContain('>Markings<'); // name of its own box
  });

  it('Important: multiplicity is set by the **parent** — a list child is 1..*', () => {
    // document: SM ◆—0..1— Markings(SML) ◆—1..*— Marking(SMC)
    expect(svg).toContain('>0..1<');
    expect(svg).toContain('>1..*<');
  });

  it('Important: only one representative list child, named without the index suffix', () => {
    // the file has MarkingsEntry_0, but the document writes Marking
    expect(svg).toContain('>Marking<');
    expect(svg).not.toContain('MarkingsEntry_0');
  });

  it('truncates long values — a box wider than the page is unusable in the document', () => {
    expect(svg).toContain('...');
  });

  it('Important: white background, black lines — the document is white paper', () => {
    expect(svg).toContain('fill: #ffffff');
    expect(svg).toContain('#1b1b1b');
  });

  it('draws composition diamonds and the frame', () => {
    expect(svg).toContain('class="diamond"');
    expect(svg).toContain('class="frame"');
  });

  it('has explicit dimensions so it can be pasted into a document', () => {
    expect(svg).toMatch(/width="\d+" height="\d+"/);
  });

  it('does not draw a MultiLanguageProperty language list as child boxes', () => {
    expect(svg).not.toContain('«undefined»');
  });

  it('does not emit raw <, & from text (it would break the SVG)', () => {
    const out = submodelUml({ idShort: 'A<B&C', modelType: 'Submodel' } as never);
    expect(out).toContain('A&lt;B&amp;C');
  });

  it('truncates many attributes but states how many were cut', () => {
    const few = submodelUml(find('DigitalNameplate'), { maxAttributes: 3 });
    expect(few).toMatch(/그 밖 \d+개/);
  });
});

describe('Deep structure', () => {
  it('renders the 3-level structure of OperationalData', () => {
    const svg = submodelUml(find('OperationalData'));
    for (const name of ['OperationalData', 'MaintenanceMonitoring', 'ConditionStatus']) {
      expect(svg).toContain(`>${name}<`);
    }
    expect(svg).toContain('+ RollWearStatus : xs:string = &quot;Normal&quot;');
  });
});

describe('Important: submodels are expanded all the way down (2026-09-21)', () => {
  /**
   * The old default depth of 3 **truncated real files**. A user pointed out that our figures differed
   * from the guidance document's; measuring showed 3 of the 7 golden submodels were losing their inner levels.
   * TechnicalData in particular kept only the container boxes and **showed not a single spec value**.
   */
  const boxCount = (svg: string): number => (svg.match(/class="cls"/g) ?? []).length;

  it.each(environment.submodels!.map((sm) => sm.idShort!))(
    '%s — default options cut off no container elements',
    (idShort) => {
      const submodel = find(idShort);
      expect(boxCount(submodelUml(submodel))).toBe(
        boxCount(submodelUml(submodel, { maxDepth: 99 })),
      );
    },
  );

  it('TechnicalData shows real spec values — previously there were 0', () => {
    const svg = submodelUml(find('TechnicalData'));
    // innermost (level 4) leaves. At depth 3 these boxes were missing entirely.
    expect(svg).toContain('+ RollDiameter : xs:double = &quot;150.0&quot;');
    expect(svg).toContain('+ RatedMotorPower : xs:double = &quot;30.0&quot;');
  });

  it('HandoverDocumentation goes down to the attributes of individual documents', () => {
    const svg = submodelUml(find('HandoverDocumentation'));
    for (const name of ['DocumentIds', 'DocumentClassifications', 'DocumentVersions']) {
      expect(svg).toContain(`>${name}<`);
    }
    expect(svg).toContain('+ DocumentIdentifier : xs:string = &quot;DOC-03-01-0001&quot;');
  });
});

describe('Overview diagram', () => {
  const svg = overviewUml(environment);

  it('the AAS is the root with submodels hanging off it', () => {
    expect(svg).toContain('«AAS»');
    expect(svg).toContain('RollFormingMachine');
    for (const submodel of environment.submodels!) {
      expect(svg).toContain(`+ ${submodel.idShort} : SM`);
    }
  });
});
