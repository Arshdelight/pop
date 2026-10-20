#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { PracticeError } from '@arshdelight/pop-sdk';
import { runInit } from './cmd/init.js';
import { runConfig } from './cmd/config.js';
import { runRepair } from './cmd/repair.js';
import { runMigrate } from './cmd/migrate.js';
import { runLs } from './cmd/ls.js';
import { runLint } from './cmd/lint.js';
import { runNew } from './cmd/new.js';
import { runEdit } from './cmd/edit.js';
import { runGc } from './cmd/gc.js';
import { runShow } from './cmd/show.js';
import { runWeb } from './web.js';
import { runBlobAdd } from './cmd/blob.js';
import { runSearch } from './cmd/search.js';
import { runSimilar } from './cmd/similar.js';
import { runEmbed } from './cmd/embed.js';
import { runNote } from './cmd/note.js';
import { runRemove } from './cmd/remove.js';
import { runClaim, runUnclaim } from './cmd/claim.js';
import { runFix } from './cmd/fix.js';
import { runUpdate } from './cmd/update.js';
import { runSpec } from './cmd/spec.js';
import { runSkill } from './cmd/skill.js';
import { runLogin, runLogout, runMe } from './cmd/login.js';
import { runRemote } from './cmd/remote.js';
import { runPush } from './cmd/push.js';
import { runPull } from './cmd/pull.js';
import { runClone } from './cmd/clone.js';
import { runFetch } from './cmd/fetch.js';
import { runPractice } from './cmd/practice.js';
import { runPublish } from './cmd/publish.js';
import { runHistory } from './cmd/history.js';
import { runBranch } from './cmd/branch.js';
import { runSwitch } from './cmd/switch.js';
import { runMerge } from './cmd/merge.js';
import { runLog } from './cmd/log.js';
import { CLI_VERSION, POP_SPEC_VERSION } from './version.js';

function printVersion(): number {
  console.log(`practi   ${CLI_VERSION}`);
  console.log(`pop-spec ${POP_SPEC_VERSION}  (via @arshdelight/pop-sdk)`);
  return 0;
}

const USAGE = `practi — local registry for POP (Protocol of Practice), with a practihub bridge

usage:
  practi blob add <file-or-url> [--name <name>]
                                 (hashes the bytes, stores local blobs in the workspace)
  practi branch [name] [--from <hash>] | -d <name>
                                 branches of the current practice (local chain; * marks
                                 the current branch; --from starts at a registered
                                 revision); -d deletes the pointer (main is kept)
  practi claim <hash>              register an existing stored node as a pop of the workspace (indirect → direct)
  practi clone <owner>/<name>[@branch] [--dir <path>]
                                 clone a hub practice into a local practice repo (full
                                 chain; --dir makes it a standalone directory repo).
                                 From there: log / publish a changed pop / push
  practi config                     show data dir and registry summary
  practi edit <hash> <file.json>    replace a pop of the workspace (new hash; recorded in the
       | practi edit <hash> --json '<text>' | practi edit <hash> < file.json
       local commit ledger commits.json). Publish moves a pop into a
       [--message <text>] [--keep]    practice; the practice keeps its own history
  practi embed status|pull|build|prune  optional offline vector model (bge-small-zh-v1.5,
                                 ~24MB int8 ONNX). pull fetches it, build embeds every
                                 stored node (incrementally), status reports coverage.
                                 Nothing here is required: without a model practi is
                                 lexical-only, and search --semantic says so
  practi gc [--apply]               free orphan blobs — attachment bytes on disk that no
                                 stored node references (dry-run by default; --apply removes)
  practi fetch <owner>/<name> <hash>
                                 pull one revision of that instance into your local registry
                                 (direct; full sha256 hash — no prefix guessing). Content
                                 access is repo-scoped: public instances are fetchable by
                                 anyone, private ones only by their owners
  practi fix <file.json> | <hash> | --all
                                 migrate POP 1.x documents to 2.0: strip the removed history
                                 fields (revisions/refines), re-validate, report the new hash.
                                 <hash> re-stores a workspace node and re-binds direct/claims;
                                 --all sweeps every direct pop; --dry-run previews
  practi history amend [<pop|file>] [-m <msg>] | reword <seq> -m <msg>
       | practi history squash <seq> | drop <seq> | reset <seq>
                                 rewrite the practice's local commit chain (git-style);
                                 push reconciles with the hub — divergence needs --force
  practi instance …                RETIRED: practice new <name> creates a local
                                 practice (the hub copy is born by the first push);
                                 commands locate it by cwd / --dir / --practice
  practi log [--branch <b>] [--limit N] [--json]
                                 the current practice's commit history (tip first)
  practi ls [-a] [--json]           list direct pops (-a also lists indirect nodes)
  practi lint [--json] [--limit N]  audit recording quality across every direct pop: the
                                 same W_* hints new prints once, on demand for the
                                 whole workspace. Read-only, never blocking (always exits 0)
  practi login [--no-open] [--reauth]   OAuth sign-in to the hub (browser consent; --no-open
                                 prints the URL for headless use, --reauth re-credentials)
  practi logout                     revoke and drop stored credentials
  practi me                         show the signed-in account, role and scopes
  practi merge <branch>             merge a branch into the current one: fast-forward when the
                                 tip's parent chain reaches the current head, otherwise a
                                 pointer move (same-tree commits are identical)
  practi migrate [path] [--keep]      move the workspace to a new data directory
                                 (cut: the old directory is removed after per-file
                                 verification; --keep retains it as <dir>.bak-<timestamp>;
                                 no arg = ~/.practi; a path is recorded in
                                 ~/.practi-home and becomes the default)
  practi note add|list|edit|delete|promote  local learning notes pinned to node hashes
                                 (sidecar notes.json, never uploaded). promote turns a
                                 note into a draft document of its owning direct root —
                                 a draft only, never an automatic edit
  practi new <file.json>            create a POP from a JSON document (in the workspace's
       | practi new --json '<text>'   pops area; publish moves it into a practice)
       | practi new < file.json
  practi publish <pop-ref | file.json> [--to <practice>] [-m <msg>] [--keep]
                                 a pop becomes the practice's new revision and goes to the
                                 hub in one call (the hub copy is born if needed); --keep
                                 keeps the pop in the workspace, default removes it
  practi pull [--dir <path> | --practice <name>]
                                 reconcile the practice with the hub: fetch missing
                                 revisions, fast-forward the branch pointer
  practi remote set <url> | remove  point practi at a hub (no implicit default; hub commands
                                 need a remote)
  practi remove <hash>              take a direct pop out of the local directory (registry op;
                                 GCs nodes unreachable from the rest — shared indirect nodes survive)
  practi repair                     backfill missing claim timestamps from node file times
                                 (idempotent; stamped claims are never touched)
  practi search [query...]          search the local workspace: every stored node is
       [--limit N] [--json]         indexed (name / description / content / declared
       [--notes] [--semantic]       inputs+outputs / loop prose), ranked title-first, each hit
                                 showing why it was recalled. Multiple words are AND (each
                                 must match, possibly in a different field); field:value
                                 scopes one word. Pure-hex queries also match hash prefixes.
                                 --notes also indexes local notes; --semantic fuses vector
                                 recall (needs practi embed pull + embed build first, else
                                 it says so and is ignored). Empty query = browse roots
  practi show <hash> [--json] [--doc]   inspect one node (hash prefix OK)
  practi similar <hash>             content neighbours of a node: same topic, other wording
       [--limit N] [--json]         (literal character-bigram similarity — no semantics;
                                 the subtree is what gets compared)
  practi skill install               install the bundled use-practi skill (default: ~/.agents/skills)
  practi skill update                refresh the installed use-practi skill (--dir to override)
  practi skill uninstall             remove the installed use-practi skill
  practi skill import <dir>          replay a practi skill export directory back into a POP (sidecar required;
                                  foreign skills enter POP by authoring, not import)
  practi skill export <ref> [--dir]  project a POP as an installable skill directory (SKILL.md + sidecar)
  practi spec                       print pop-spec.md (bundled with the SDK; no network)
  practi switch <branch>            switch the bound instance's current branch (local pointer;
                                 bring the content into the workspace with 'practi pull')
  practi unclaim <hash>             take a referenced direct pop back to indirect (fails when
                                 unreferenced — that would orphan it; delete with "remove")
  practi update                     self-update via npm (checks the registry's latest)
  practi version | --version        show CLI + pop-spec versions
  practi web [--port 4317] [--no-open]  browse direct pops in a local web UI

options:
  --data-dir <path>              target data directory (same default as init)

the data directory is a POP workspace: nodes are content-addressed (nodes/*.md),
practi.json records the registered direct roots plus the remote/instance binding;
notes live in notes.json, the local commit log in commits.json. Hub commands need
'practi login' + 'practi remote set'.
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
    case 'lint': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, json: { type: 'boolean' as const }, limit: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi lint [--json] [--limit N]');
        console.log('       audit recording quality across every direct pop: the same W_* hints');
        console.log('       `practi new` prints once, but for the whole workspace, on demand.');
        console.log('       read-only and never blocking (exit code is always 0) — it is a to-do');
        console.log('       list, not a gate. --limit caps how many nodes are listed (default 20).');
        return 0;
      }
      const lintLimit = values.limit ? Number(values.limit) : 20;
      return runLint({
        dataDir: str(values['data-dir']),
        json: values.json === true,
        limit: Number.isInteger(lintLimit) && lintLimit > 0 ? Math.min(lintLimit, 200) : 20,
      });
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
          out: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi note add|list|edit|delete|promote   (see `practi note` help)');
        return 0;
      }
      return runNote({
        dataDir: str(values['data-dir']),
        positional: positionals,
        message: values.message,
        json: values.json === true,
        out: values.out,
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
      return await runNew({ dataDir: str(values['data-dir']), json: values.json, file: values.file, positional: positionals });
    }
    case 'edit': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          json: { type: 'string' as const },
          file: { type: 'string' as const },
          message: { type: 'string' as const, short: 'm' },
          keep: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi edit <hash> <file.json> | --json \'<text>\' | < file.json [--message] [--keep]'); return 0; }
      return runEdit({
        dataDir: str(values['data-dir']),
        json: values.json,
        file: values.file,
        message: values.message,
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
    case 'embed': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, json: { type: 'boolean' as const }, notes: { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi embed status|pull|build|prune [--json] [--notes]');
        console.log('       optional offline vector model (bge-small-zh-v1.5, ~24MB int8 ONNX).');
        console.log('       pull downloads it into <data-dir>/models/, build embeds every stored node');
        console.log('       (incrementally — only new hashes are embedded), status reports coverage.');
        console.log('       nothing here is required: without a model practi is lexical-only.');
        return 0;
      }
      return await runEmbed({
        dataDir: str(values['data-dir']),
        positional: positionals,
        json: values.json === true,
        notes: values.notes === true,
      });
    }
    case 'search': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          limit: { type: 'string' as const },
          json: { type: 'boolean' as const },
          notes: { type: 'boolean' as const },
          semantic: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi search [query...] [--limit N] [--json] [--notes] [--semantic]');
        console.log('       words are ANDed — every word must match somewhere, and the words may');
        console.log('       match in different fields (name / description / content / declared');
        console.log('       inputs+outputs / loop). Quote a phrase to search it whole.');
        console.log('       field:value scopes one word — name: desc: content: flow: loop: op: hash:');
        console.log('       pure-hex queries also match node hash prefixes;');
        console.log('       if strict matching finds nothing, results fall back to partial match (labeled).');
        console.log('       --notes also indexes your local notes (off by default); hits show "note".');
        console.log('       --semantic fuses vector recall with the lexical ranking (needs');
        console.log('       `practi embed pull` + `practi embed build`; otherwise it says so and is ignored).');
        console.log('       empty query = browse direct roots');
        return 0;
      }
      const limit = values.limit ? Number(values.limit) : 20;
      return await runSearch({
        dataDir: str(values['data-dir']),
        positional: positionals,
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20,
        json: values.json === true,
        notes: values.notes === true,
        semantic: values.semantic === true,
      });
    }
    case 'similar': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          limit: { type: 'string' as const },
          json: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi similar <hash> [--limit N] [--json]');
        console.log('       content neighbours: the target subtree is treated as a query and every');
        console.log('       stored node is scored against it (character-bigram + latin-word relevance,');
        console.log('       literal — not semantics, so a paraphrase sharing no wording will not surface).');
        console.log('       score 1.0 = identical content; each hit lists the shared terms that carried it.');
        return 0;
      }
      if (positionals.length === 0) {
        console.error('usage: practi similar <hash> [--limit N] [--json]');
        return 1;
      }
      const simLimit = values.limit ? Number(values.limit) : 10;
      return runSimilar({
        dataDir: str(values['data-dir']),
        ref: positionals[0],
        limit: Number.isInteger(simLimit) && simLimit > 0 ? Math.min(simLimit, 50) : 10,
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
      if (values.help) {
        console.log('usage: practi skill install|update|uninstall [--dir <skills-dir>]   (default dir: ~/.agents/skills)');
        console.log('       practi skill import <skill-dir> [--data-dir <dir>]          replay a `practi skill export` directory (sidecar required)');
        console.log('       practi skill export <ref> [--dir <out-dir>] [--data-dir <dir>]  POP → skill directory');
        return 0;
      }
      if (action === undefined) {
        console.error('usage: practi skill install|update|uninstall [--dir <skills-dir>]   (default dir: ~/.agents/skills)');
        console.error('       practi skill import <skill-dir> [--data-dir <dir>]          replay a `practi skill export` directory (sidecar required)');
        console.error('       practi skill export <ref> [--dir <out-dir>] [--data-dir <dir>]  POP → skill directory');
        return 1;
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
    case 'login': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, 'no-open': { type: 'boolean' as const }, reauth: { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi login [--no-open] [--reauth]   (OAuth sign-in to the hub)'); return 0; }
      return runLogin({ dataDir: str(values['data-dir']), noOpen: values['no-open'] === true, reauth: values.reauth === true });
    }
    case 'logout': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi logout   (revoke and drop stored credentials)'); return 0; }
      return runLogout({ dataDir: str(values['data-dir']) });
    }
    case 'me': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi me   (show the signed-in account)'); return 0; }
      return runMe({ dataDir: str(values['data-dir']) });
    }
    case 'remote': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi remote set <url> | remove   (default: https://practihub.com)'); return 0; }
      return runRemote({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'push': {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          force: { type: 'boolean' as const },
          dir: { type: 'string' as const },
          practice: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi push [--force] [--dir <path> | --practice <name>]   (local practice → hub; first push creates it; divergence errors, --force overwrites and the hub drops unreachable objects)');
        return 0;
      }
      return await runPush({ dataDir: str(values['data-dir']), positional: [], dir: values.dir, practice: values.practice, force: values.force === true });
    }
    case 'publish': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          to: { type: 'string' as const },
          dir: { type: 'string' as const },
          message: { type: 'string' as const, short: 'm' },
          keep: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi publish <pop-ref | file.json> [--to <practice>] [-m <msg>] [--keep]   (a pop becomes the practice\'s new revision and goes to the hub in one call; --keep keeps the pop in your workspace)');
        return 0;
      }
      return await runPublish({
        dataDir: str(values['data-dir']),
        positional: positionals,
        to: values.to,
        dir: values.dir,
        message: values.message,
        keep: values.keep === true,
      });
    }
    case 'history': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          dir: { type: 'string' as const },
          practice: { type: 'string' as const },
          message: { type: 'string' as const, short: 'm' },
          file: { type: 'string' as const },
          json: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi history amend [<pop-ref|file>] [-m <msg>] | reword <seq> -m <msg> | squash <seq> | drop <seq> | reset <seq>   (rewrite the local commit chain; push reconciles with the hub)');
        return 0;
      }
      return await runHistory({
        dataDir: str(values['data-dir']),
        positional: positionals,
        dir: values.dir,
        practice: values.practice,
        message: values.message,
        file: values.file,
        json: values.json,
      });
    }
    case 'practice': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi practice new <name> [--dir <path>] | list | remove <name>   (create/list/remove local practice instances; first push births them on the hub)');
        return 0;
      }
      return runPractice({ dataDir: str(values['data-dir']), positional: positionals, dir: values.dir });
    }
    case 'fix': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, all: { type: 'boolean' as const }, 'dry-run': { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi fix <file.json> | <hash> | --all [--dry-run]   (strip POP 1.x history fields — revisions/refines — and re-validate under POP 2.0)');
        return 0;
      }
      return runFix({ dataDir: str(values['data-dir']), positional: positionals, all: values.all === true, dryRun: values['dry-run'] === true });
    }
    case 'pull': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const }, practice: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi pull [--dir <path> | --practice <name>]   (reconcile the practice with the hub: fetch missing revisions, fast-forward)'); return 0; }
      return await runPull({ dataDir: str(values['data-dir']), positional: [], dir: values.dir, practice: values.practice });
    }
    case 'clone': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi clone <owner>/<name>[@branch] [--dir <path>]   (clone a practice instance as a local practice repo — full chain, ready to publish)'); return 0; }
      return await runClone({ dataDir: str(values['data-dir']), positional: positionals, dir: values.dir });
    }
    case 'fetch': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi fetch <owner>/<name> <hash>   (pull one revision of that instance into your local registry, full sha256 hash)'); return 0; }
      return await runFetch({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'instance': {
      if (rest.join(' ').includes('help')) {
        console.log('practi instance was retired by the two-software model (2026-10-20):');
        console.log('  instance create → `practi practice new <name>` (local first; the hub copy is born by the first push)');
        console.log('  instance bind   → retired: commands locate the practice by cwd / --dir / --practice');
        console.log('  instance show   → `practi practice list` and `practi log`');
        return 0;
      }
      console.error('error: `practi instance` was retired — use `practi practice new <name>` (local instances), --practice <name> / --dir <path> to locate, `practi push` to put one on the hub');
      return 1;
    }
    case 'branch': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          from: { type: 'string' as const },
          delete: { type: 'string' as const, short: 'd' },
          dir: { type: 'string' as const },
          practice: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi branch [name] [-d <name>]   (list / create / delete branches of the practice; * marks the current branch)');
        return 0;
      }
      return runBranch({ dataDir: str(values['data-dir']), positional: positionals, from: values.from, deleteBranch: values.delete, dir: values.dir, practice: values.practice });
    }
    case 'switch': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const }, practice: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi switch <branch>   (switch the practice\'s current branch)'); return 0; }
      return runSwitch({ dataDir: str(values['data-dir']), positional: positionals, dir: values.dir, practice: values.practice });
    }
    case 'merge': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const }, practice: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi merge <branch>   (fast-forward, else move the pointer — same-tree commits are identical)'); return 0; }
      return runMerge({ dataDir: str(values['data-dir']), positional: positionals, dir: values.dir, practice: values.practice });
    }
    case 'log': {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          branch: { type: 'string' as const },
          limit: { type: 'string' as const },
          json: { type: 'boolean' as const },
          dir: { type: 'string' as const },
          practice: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi log [--branch <b>] [--limit N] [--json]   (the practice\'s commit history, tip first)'); return 0; }
      const logLimit = values.limit ? Number(values.limit) : undefined;
      return runLog({
        dataDir: str(values['data-dir']),
        positional: [],
        branch: values.branch,
        limit: logLimit !== undefined && Number.isInteger(logLimit) && logLimit > 0 ? logLimit : undefined,
        json: values.json === true,
        dir: values.dir,
        practice: values.practice,
      });
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
