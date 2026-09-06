#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { PracticeError } from '@arshdelight/pop-sdk';
import { runInit } from './cmd/init.js';
import { runConfig } from './cmd/config.js';
import { runRepair } from './cmd/repair.js';
import { runMigrate } from './cmd/migrate.js';
import { runLs } from './cmd/ls.js';
import { runNew } from './cmd/new.js';
import { runEdit } from './cmd/edit.js';
import { runGc } from './cmd/gc.js';
import { runShow } from './cmd/show.js';
import { runWeb } from './web.js';
import { runBlobAdd } from './cmd/blob.js';
import { runSearch } from './cmd/search.js';
import { runNote } from './cmd/note.js';
import { runRemove } from './cmd/remove.js';
import { runClaim, runUnclaim } from './cmd/claim.js';
import { runUpdate } from './cmd/update.js';
import { runSpec } from './cmd/spec.js';
import { runSkill } from './cmd/skill.js';
import { CLI_VERSION, POP_SPEC_VERSION } from './version.js';

function printVersion(): number {
  console.log(`practi   ${CLI_VERSION}`);
  console.log(`pop-spec ${POP_SPEC_VERSION}  (via @arshdelight/pop-sdk)`);
  return 0;
}

const USAGE = `practi — local registry for POP (Protocol of Practice)

usage:
  practi blob add <file-or-url> [--name <name>]
                                 (hashes the bytes, stores local blobs in the workspace)
  practi claim <hash>              register an existing stored node as a direct pop (indirect → direct)
  practi config                     show data dir and registry summary
  practi edit <hash> <file.json>    replace a direct POP (new hash; auto-revision + GC)
       | practi edit <hash> --json '<text>' | practi edit <hash> < file.json
       [--message <text>] [--no-revision] [--keep]
  practi gc [--apply]               free orphan blobs — attachment bytes on disk that no
                                 stored node references (dry-run by default; --apply removes)
  practi init [path]                initialize a data directory (default: ~/.practi)
  practi ls [-a] [--json]           list direct pops (-a also lists indirect nodes)
  practi migrate [path] [--keep]      move the workspace to a new data directory
                                 (cut: the old directory is removed after per-file
                                 verification; --keep retains it as <dir>.bak-<timestamp>;
                                 no arg = ~/.practi; a path is recorded in
                                 ~/.practi-home and becomes the default)
  practi note add|list|edit|delete  local learning notes pinned to node hashes (sidecar
                                 notes.json, never uploaded — learning/reproduction focus)
  practi new <file.json>            create a POP from a JSON document (local)
       | practi new --json '<text>'
       | practi new < file.json
  practi remove <hash>              take a direct pop out of the local directory (registry op;
                                 GCs nodes unreachable from the rest — shared indirect nodes survive)
  practi repair                     backfill missing claim timestamps from node file times
                                 (idempotent; stamped claims are never touched)
  practi search [query...]          search the local workspace (title/content substring match;
       [--limit N] [--json]         pure-hex queries also match hash prefixes; empty query
                                 = browse direct roots)
  practi show <hash> [--json] [--doc]   inspect one node (hash prefix OK)
  practi skill install               install the bundled use-practi skill (default: ~/.agents/skills)
  practi skill update                refresh the installed use-practi skill (--dir to override)
  practi skill uninstall             remove the installed use-practi skill
  practi skill import <dir>          replay a practi skill export directory back into a POP (sidecar required;
                                  foreign skills enter POP by authoring, not import)
  practi skill export <ref> [--dir]  project a POP as an installable skill directory (SKILL.md + sidecar)
  practi spec                       print pop-spec.md (bundled with the SDK; no network)
  practi unclaim <hash>             take a referenced direct pop back to indirect (fails when
                                 unreferenced — that would orphan it; delete with "remove")
  practi update                     self-update via npm (checks the registry's latest)
  practi version | --version        show CLI + pop-spec versions
  practi web [--port 4317] [--no-open]  browse direct pops in a local web UI

options:
  --data-dir <path>              target data directory (same default as init)

the data directory is a POP workspace: nodes are content-addressed (nodes/*.md),
practi.json records the registered direct roots; notes live in notes.json.
`;

const COMMON = {
  'data-dir': { type: 'string' as const },
  help: { type: 'boolean' as const, short: 'h' },
};

function str(v: string | undefined): string {
  return v as string;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);

  if (cmd === 'version' || argv.includes('--version') || argv.includes('-v')) {
    return printVersion();
  }

  switch (cmd) {
    case 'gc': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, apply: { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi gc [--apply]   (free orphan blobs; dry-run by default)'); return 0; }
      return runGc({ dataDir: str(values['data-dir']), apply: values.apply === true });
    }
    case 'init': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi init [path]'); return 0; }
      return runInit({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'config': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi config'); return 0; }
      return runConfig({ dataDir: str(values['data-dir']) });
    }
    case 'repair': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi repair   (backfill missing claim timestamps; idempotent)'); return 0; }
      return runRepair({ dataDir: str(values['data-dir']) });
    }
    case 'migrate': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, keep: { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi migrate [path] [--keep]   (cut: the old directory is removed after per-file verification; --keep retains it as <dir>.bak-<timestamp>; no arg = ~/.practi, a path is recorded in ~/.practi-home as the default)'); return 0; }
      return runMigrate({ dataDir: str(values['data-dir']), positional: positionals, keep: values.keep === true });
    }
    case 'ls': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, all: { type: 'boolean' as const, short: 'a' }, json: { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi ls [-a] [--json]'); return 0; }
      return runLs({ dataDir: str(values['data-dir']), all: values.all === true, json: values.json === true });
    }
    case 'note': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          message: { type: 'string' as const, short: 'm' },
          json: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi note add|list|edit|delete   (see `practi note` help)');
        return 0;
      }
      return runNote({
        dataDir: str(values['data-dir']),
        positional: positionals,
        message: values.message,
        json: values.json === true,
      });
    }
    case 'new': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          json: { type: 'string' as const },
          file: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi new <file.json> | practi new --json \'<text>\' | practi new < file.json'); return 0; }
      return runNew({ dataDir: str(values['data-dir']), json: values.json, file: values.file, positional: positionals });
    }
    case 'edit': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          json: { type: 'string' as const },
          file: { type: 'string' as const },
          message: { type: 'string' as const },
          'no-revision': { type: 'boolean' as const },
          keep: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi edit <hash> <file.json> | --json \'<text>\' | < file.json [--message] [--no-revision] [--keep]'); return 0; }
      return runEdit({
        dataDir: str(values['data-dir']),
        json: values.json,
        file: values.file,
        message: values.message,
        noRevision: values['no-revision'] === true,
        keep: values.keep === true,
        positional: positionals,
      });
    }
    case 'show': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, json: { type: 'boolean' as const }, doc: { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi show <hash> [--json] [--doc]'); return 0; }
      if (positionals.length === 0) { console.error('usage: practi show <hash> [--json] [--doc]'); return 1; }
      return runShow({ dataDir: str(values['data-dir']), hash: positionals[0], json: values.json === true, doc: values.doc === true });
    }
    case 'web': {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          port: { type: 'string' as const },
          open: { type: 'boolean' as const, default: true },
          'no-open': { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi web [--port 4317] [--no-open]'); return 0; }
      const port = values.port ? Number(values.port) : 4317;
      return runWeb({ dataDir: str(values['data-dir']), port: Number.isInteger(port) && port > 0 ? port : 4317, open: values['no-open'] !== true });
    }
    case 'remove': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: COMMON,
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi remove <hash>   (local directory; unreachable nodes are GCed)');
        return 0;
      }
      if (positionals.length === 0) {
        console.error('usage: practi remove <hash>   (local directory; unreachable nodes are GCed)');
        return 1;
      }
      return runRemove({
        dataDir: str(values['data-dir']),
        positional: positionals,
      });
    }
    case 'claim': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi claim <hash>   (register an existing stored node as a direct pop)'); return 0; }
      if (positionals.length === 0) { console.error('usage: practi claim <hash>'); return 1; }
      return runClaim({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'unclaim': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi unclaim <hash>   (take a referenced direct pop back to indirect)'); return 0; }
      if (positionals.length === 0) { console.error('usage: practi unclaim <hash>'); return 1; }
      return runUnclaim({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'search': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          limit: { type: 'string' as const },
          json: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi search [query...] [--limit N] [--json]'); console.log('       (searches the local workspace; empty query = browse direct roots)'); return 0; }
      const limit = values.limit ? Number(values.limit) : 20;
      return runSearch({
        dataDir: str(values['data-dir']),
        positional: positionals,
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20,
        json: values.json === true,
      });
    }
    case 'blob': {
      const sub = rest[0];
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        options: { ...COMMON, name: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi blob add <file-or-url> [--name <name>]'); return 0; }
      if (sub === 'add') {
        return runBlobAdd({ dataDir: str(values['data-dir']), name: values.name, positional: positionals });
      }
      console.error('usage: practi blob add <file-or-url> [--name <name>]');
      return 1;
    }
    case 'skill': {
      const sub = rest[0];
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        options: { ...COMMON, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      const known = ['install', 'update', 'uninstall', 'import', 'export'] as const;
      const action = known.find((k) => k === sub);
      if (values.help || action === undefined) {
        console.log('usage: practi skill install|update|uninstall [--dir <skills-dir>]   (default dir: ~/.agents/skills)');
        console.log('       practi skill import <skill-dir> [--data-dir <dir>]          replay a `practi skill export` directory (sidecar required)');
        console.log('       practi skill export <ref> [--dir <out-dir>] [--data-dir <dir>]  POP → skill directory');
        return sub !== undefined && !values.help ? 1 : 0;
      }
      return runSkill({ action, dir: values.dir, dataDir: str(values['data-dir']), positional: positionals[0] });
    }
    case 'spec': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi spec   (print the bundled pop-spec.md)'); return 0; }
      return runSpec({ dataDir: str(values['data-dir']) });
    }
    case 'update': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi update   (self-update via npm; checks the registry\'s latest)'); return 0; }
      return await runUpdate({ dataDir: str(values['data-dir']) });
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(USAGE);
      return 1;
  }
}

(async () => {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof PracticeError) {
      console.error(`error [${e.code}]: ${e.message}`);
      if (e.hint) console.error(`  hint: ${e.hint}`);
    } else if (e instanceof Error) {
      console.error(`error: ${e.message}`);
    } else {
      console.error(`error: ${String(e)}`);
    }
    process.exitCode = 1;
  }
})();
