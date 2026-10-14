/**
 * Nameplate fields of one shell, as the equipment master and the join block need them (design §4.4, ERP §2.1).
 *
 * Lookup per field: semanticId first (standard IRDIs as found in the DigitalNameplate / TechnicalData templates of the
 * fixtures), then idShort. Every value is read, never derived — no year from the date of manufacture, no splitting of a
 * marking text at commas, no unit from a column name. Absent stays null and is listed in `missing`.
 */
import type { Environment } from '@aas/core';
import {
  findElement,
  findSubmodel,
  idShortOf,
  locatedChildren,
  numberOf,
  submodelsOf,
  textOf,
  topElements,
  type Json,
  type Located,
} from './elements.js';
import { unitOf } from './units.js';

export interface NameplateValues {
  manufacturer: string | null;
  productDesignation: string | null;
  productFamily: string | null;
  modelNumber: string | null;
  orderCode: string | null;
  serialNumber: string | null;
  yearOfConstruction: string | null;
  dateOfManufacture: string | null;
  productUri: string | null;
  markings: string[];
}

export interface NameplateRead {
  nameplate: NameplateValues;
  weight: { value: number | null; unit: string | null } | null;
  /** Column key → `Submodel/idShortPath` of the element the value came from */
  sourcePaths: Record<string, string>;
  /** Column keys without a value */
  missing: string[];
}

export const SERIAL_NUMBER_SEMANTIC_ID = '0112/2///61987#ABA951#009';

type ScalarKey = Exclude<keyof NameplateValues, 'markings'>;

interface FieldSpec {
  key: ScalarKey;
  /** Where to look, in order */
  submodels: readonly ('nameplate' | 'technical')[];
  semanticIds: readonly string[];
  idShorts: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { key: 'manufacturer', submodels: ['nameplate', 'technical'], semanticIds: ['0112/2///61987#ABA565#009'], idShorts: ['ManufacturerName'] },
  { key: 'productDesignation', submodels: ['nameplate', 'technical'], semanticIds: ['0112/2///61987#ABA567#009'], idShorts: ['ManufacturerProductDesignation'] },
  { key: 'productFamily', submodels: ['nameplate'], semanticIds: ['0112/2///61987#ABP464#002'], idShorts: ['ManufacturerProductFamily'] },
  { key: 'modelNumber', submodels: ['nameplate'], semanticIds: ['0112/2///61987#ABA300#008'], idShorts: ['ManufacturerProductType'] },
  { key: 'orderCode', submodels: ['technical', 'nameplate'], semanticIds: ['0173-1#02-AAO227#004'], idShorts: ['ManufacturerOrderCode', 'OrderCodeOfManufacturer'] },
  { key: 'serialNumber', submodels: ['nameplate'], semanticIds: [SERIAL_NUMBER_SEMANTIC_ID], idShorts: ['SerialNumber'] },
  { key: 'yearOfConstruction', submodels: ['nameplate'], semanticIds: ['0112/2///61987#ABP000#002'], idShorts: ['YearOfConstruction'] },
  { key: 'dateOfManufacture', submodels: ['nameplate'], semanticIds: ['0112/2///61987#ABB757#007'], idShorts: ['DateOfManufacture'] },
  { key: 'productUri', submodels: ['nameplate'], semanticIds: ['0112/2///61987#ABN590#002'], idShorts: ['URIOfTheProduct'] },
];

const MARKINGS = { semanticIds: ['0112/2///61360_7#AAS006#001'], idShorts: ['Markings'] };
const MARKING_NAME = { semanticIds: ['0112/2///61987#ABA231#009'], idShorts: ['MarkingName'] };
const WEIGHT = { semanticIds: ['0173-1#02-AAQ808#007'], idShorts: ['TotalWeight'] };

/** Nameplate-type submodels of the shell */
export function nameplateSubmodels(environment: Environment, shell: Json | undefined): { nameplate?: Json; technical?: Json } {
  const submodels = submodelsOf(environment, shell);
  const nameplate = findSubmodel(submodels, ['DigitalNameplate', 'Nameplate'], /nameplate/i);
  const technical = findSubmodel(submodels, ['TechnicalData'], /TechnicalData|AHX837/i);
  return { ...(nameplate ? { nameplate } : {}), ...(technical ? { technical } : {}) };
}

function sourcePath(submodel: Json, located: Located): string {
  return `${idShortOf(submodel) ?? ''}/${located.path.replace(/\./g, '/')}`;
}

/** The serial number only — used by the join block and readiness checks */
export function serialNumberOf(environment: Environment, shell: Json | undefined): string | null {
  const { nameplate } = nameplateSubmodels(environment, shell);
  if (!nameplate) return null;
  const found = findElement(topElements(nameplate), [SERIAL_NUMBER_SEMANTIC_ID], ['SerialNumber']);
  return textOf(found?.element, 'en');
}

export function readNameplate(environment: Environment, shell: Json | undefined, lang: string): NameplateRead {
  const submodels = nameplateSubmodels(environment, shell);
  const sourcePaths: Record<string, string> = {};
  const missing: string[] = [];
  // Built in column order so the JSON reads like the contract
  const nameplate: NameplateValues = {
    manufacturer: null,
    productDesignation: null,
    productFamily: null,
    modelNumber: null,
    orderCode: null,
    serialNumber: null,
    yearOfConstruction: null,
    dateOfManufacture: null,
    productUri: null,
    markings: [],
  };

  for (const field of FIELDS) {
    let value: string | null = null;
    for (const where of field.submodels) {
      const submodel = submodels[where];
      if (!submodel) continue;
      const found = findElement(topElements(submodel), field.semanticIds, field.idShorts);
      const text = textOf(found?.element, lang);
      if (found && text !== null) {
        value = text;
        sourcePaths[`nameplate.${field.key}`] = sourcePath(submodel, found);
        break;
      }
    }
    nameplate[field.key] = value;
    if (value === null) missing.push(`nameplate.${field.key}`);
  }

  if (submodels.nameplate) {
    const list = findElement(topElements(submodels.nameplate), MARKINGS.semanticIds, MARKINGS.idShorts);
    if (list) {
      for (const entry of locatedChildren(list)) {
        const name = findElement([entry], MARKING_NAME.semanticIds, MARKING_NAME.idShorts);
        const text = textOf(name?.element, lang);
        if (text !== null) nameplate.markings.push(text);
      }
      if (nameplate.markings.length > 0) sourcePaths['nameplate.markings'] = sourcePath(submodels.nameplate, list);
    }
  }
  if (nameplate.markings.length === 0) missing.push('nameplate.markings');

  let weight: NameplateRead['weight'] = null;
  const technical = submodels.technical;
  const weightElement = technical ? findElement(topElements(technical), WEIGHT.semanticIds, WEIGHT.idShorts) : undefined;
  const weightValue = numberOf(weightElement?.element);
  if (technical && weightElement && weightValue !== null) {
    weight = { value: weightValue, unit: unitOf(environment, weightElement.element) };
    sourcePaths['physical.weight.value'] = sourcePath(technical, weightElement);
    if (weight.unit === null) missing.push('physical.weight.unit');
  } else {
    missing.push('physical.weight.value', 'physical.weight.unit');
  }
  return { nameplate, weight, sourcePaths, missing };
}
