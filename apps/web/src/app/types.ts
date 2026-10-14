/** 화면 사이에 오가는 작은 타입들 — App.tsx 를 나누며 여러 파일이 같이 쓰게 된 것(2026-10-13) */
import type { TreeNode } from '../model.js';

/**
 * 가운데 칸에 열려 있는 입력 양식.
 * 'submodel' 서브모델 추가 · 'import' 다른 파일에서 가져오기 · 'new' 새로 만들기 · 'docs' 문서용 자료 ·
 * 'aid' 수집 연결 만들기 · 'bundle' 레퍼런스 번들 · TreeNode 그 노드 밑에 요소 추가
 */
export type Adding = 'submodel' | 'import' | 'new' | 'docs' | 'aid' | 'bundle' | TreeNode;
