import fs from 'node:fs';

/**
 * The bundled protocol spec (pop-spec.md ships inside this package under spec/).
 * Consumers render the exact spec their installed SDK implements — no repo or
 * network fetch; the spec-sync test keeps the copy and POP_SPEC_VERSION aligned.
 */

/** File URL of the bundled pop-spec.md (dist/spec.js → ../spec/pop-spec.md) */
export const SPEC_FILE = new URL('../spec/pop-spec.md', import.meta.url);

/** Read the bundled spec markdown (node-side; server rendering, tooling, docs) */
export function readSpec(): string {
  return fs.readFileSync(SPEC_FILE, 'utf8');
}
