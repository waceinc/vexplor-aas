/** Small types passed between screens — shared by several files after App.tsx was split (2026-10-13) */
import type { TreeNode } from '../model.js';

/**
 * Input form open in the middle pane.
 * 'submodel' add submodel · 'import' import from another file · 'new' create new · 'docs' document materials ·
 * 'aid' create collection link · 'bundle' reference bundle · TreeNode add an element under that node
 */
export type Adding = 'submodel' | 'import' | 'new' | 'docs' | 'aid' | 'bundle' | TreeNode;
