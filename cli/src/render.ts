import type { PNode, StepItem, StandardView } from '@arshdelight/pop-sdk';

/** Compact display hash: first 12 hex chars of the payload */
export function shortHash(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 12);
}

export function nodeTag(node: PNode): string {
  return node.type === 'practice' ? `practice·${node.op}` : 'action';
}

/** Render a standard view's header line, e.g. "● Name  [practice·seq]  abc123def456" */
export function viewHeader(view: StandardView): string {
  const tag = view.type === 'practice' ? `practice·${view.op}` : 'action';
  return `● ${view.name}  [${tag}]  ${shortHash(view.hash)}`;
}

/** Render aggregate steps as an indented tree (depth from the view, normalized to 0) */
export function renderSteps(steps: StepItem[], nodes: Map<string, PNode>): string[] {
  const lines: string[] = [];
  for (const s of steps) {
    const n = nodes.get(s.refHash);
    const tag = n ? `[${nodeTag(n)}]` : '';
    const note = s.note ? `  (${s.note})` : '';
    const desc = s.description !== undefined ? `  — ${s.description}` : '';
    lines.push(`${'  '.repeat(s.depth)}${s.name}  ${tag}  ${shortHash(s.refHash)}${note}${desc}`);
  }
  return lines;
}
