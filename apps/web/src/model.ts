/**
 * 트리 구성과 위치 계산 — 화면이 없어도 성립하는 순수 로직.
 *
 * 여기서 가장 중요한 것은 **린터가 가리키는 위치와 UI가 여는 노드가 같아야 한다**는 점이다.
 * 지적을 눌렀는데 그 요소가 열리지 않으면 린터의 값어치가 반으로 준다(docs/PROGRESS.md §5).
 * 그래서 노드마다 두 가지 주소를 함께 만든다.
 *   pointer     — Environment JSON Pointer. 린터 finding.pointer와 맞댄다
 *   idShortPath — IDTA Part 2 경로. API로 값을 고칠 때 쓴다
 *
 * 2026-10-13 컴포넌트화 — 주제별로 model/ 에 나눴다(타입 · 트리 · 지적 · semanticId · 연결 가지). 쓰는 쪽은 예전처럼 이 파일에서 가져온다.
 */
export * from './model/types.js';
export * from './model/tree.js';
export * from './model/findings.js';
export * from './model/semantic.js';
export * from './model/linked.js';
