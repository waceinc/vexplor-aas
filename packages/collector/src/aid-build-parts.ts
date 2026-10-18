/**
 * Building blocks shared by the AID builder (aid-build.ts) and its security part (aid-build-security.ts).
 *
 * Important: kosmo-first pair — every element gets our own IRI (cd/{idShort}) as semanticId and the IDTA or W3C term
 *    as supplemental. Using the IDTA term directly made a freshly built AID violate KOSMO-SME-3 13 times (observed).
 *    Readers of the AID therefore look at supplemental semanticIds too (aid.ts).
 */
export class AidBuildError extends Error {}

export const ref = (value: string) => ({
  type: 'ExternalReference',
  keys: [{ type: 'GlobalReference', value }],
});

export const pair = (iriBase: string, idShort: string, term: string) => ({
  semanticId: ref(`${iriBase}/cd/${idShort}/1/0`),
  supplementalSemanticIds: [ref(term)],
});

export const smc = (iriBase: string, idShort: string, term: string, value: unknown[]) => ({
  modelType: 'SubmodelElementCollection',
  idShort,
  ...pair(iriBase, idShort, term),
  value,
});

export const prop = (iriBase: string, idShort: string, term: string, value: string) => ({
  modelType: 'Property',
  idShort,
  ...pair(iriBase, idShort, term),
  valueType: 'xs:string',
  value,
});

/** A list of references to elements of the same submodel (the AID `security` list points into `securityDefinitions`) */
export const referenceList = (iriBase: string, idShort: string, term: string, targets: readonly (readonly string[])[], submodelId: string) => ({
  modelType: 'SubmodelElementList',
  idShort,
  ...pair(iriBase, idShort, term),
  orderRelevant: false,
  typeValueListElement: 'ReferenceElement',
  value: targets.map((path) => ({
    modelType: 'ReferenceElement',
    value: {
      type: 'ModelReference',
      keys: [{ type: 'Submodel', value: submodelId }, ...path.map((value) => ({ type: 'SubmodelElementCollection', value }))],
    },
  })),
});
