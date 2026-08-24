import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The bundled protocol spec (pop-spec.md ships inside this package under spec/).
 * Consumers render the exact spec their installed SDK implements — no repo or
 * network fetch; the spec-sync test keeps the copy and POP_SPEC_VERSION aligned.
 */

/** File URL of the bundled pop-spec.md (dist/spec.js → ../spec/pop-spec.md) */
export const SPEC_FILE = new URL('../spec/pop-spec.md', import.meta.url);

/**
 * Read the bundled spec markdown (node-side; server rendering, tooling, docs).
 * Hands fs a plain string path: bundlers (Turbopack dev) rewrite the
 * `new URL(asset, import.meta.url)` pattern into a cross-realm URL object
 * that fs.readFileSync's instanceof check rejects.
 */
export function readSpec(): string {
  return fs.readFileSync(fileURLToPath(SPEC_FILE.href), 'utf8');
}
