#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { PracticeError } from '@arshdelight/pop-sdk';
import { runInit } from './cmd/init.js';
import { runConfig } from './cmd/config.js';
import { runLint } from './cmd/lint.js';
import { runNew } from './cmd/new.js';
import { runCommit } from './cmd/commit.js';
import { runExport } from './cmd/export.js';
import { runGc } from './cmd/gc.js';
import { runShow } from './cmd/show.js';
import { runWeb } from './web.js';
import { runBlobAdd } from './cmd/blob.js';
import { runSearch } from './cmd/search.js';
import { runSimilar } from './cmd/similar.js';
import { runEmbed } from './cmd/embed.js';
import { runNote } from './cmd/note.js';
import { runSkill } from './cmd/skill.js';
import { runFix } from './cmd/fix.js';
import { runUpdate } from './cmd/update.js';
import { runSpec } from './cmd/spec.js';
import { runLogin, runLogout, runMe } from './cmd/login.js';
import { runRemote } from './cmd/remote.js';
import { runPush } from './cmd/push.js';
import { runPull } from './cmd/pull.js';
import { runClone } from './cmd/clone.js';
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

const USAGE = `practi — practice folders for POP (Protocol of Practice), with a practihub bridge

a practice is a self-contained folder:
  <name>.json   the pop — a plain document, edit it with any editor
  .practi/      the history (like .git): chain.json (commits + branches)
                and the content-addressed pool of every revision

usage (run inside a practice folder unless noted):
  practi new <name> [--base <file.json>] [-m <msg>]  birth a practice folder in cwd;
                                 --base seeds the first revision from a pop document
                                 (hub-side copy is born by the first push)
  practi commit [-m <msg>] [--amend]   snapshot the working file as a new revision
                                 (local only; nothing to commit when it matches the
                                 head; --amend replaces the head instead)
  practi export <hash> [-o <file>]     write any revision back out as a document
                                 (the current one is the working file already)
  practi push [--force]          sync the practice to the hub (first push creates it;
                                 divergence errors, --force overwrites and the hub
                                 drops unreachable objects)
  practi pull                    reconcile with the hub: fetch missing revisions,
                                 fast-forward the branch, update the working file
  practi clone <owner>/<name>[@branch] [--dir <path>]
                                 clone a hub practice into a local practice folder
  practi branch [name] [-d <name>] [--from <hash>]
                                 list / create / delete branches (* marks the current one)
  practi switch <branch>         switch branches (working file follows the head; refuses
                                 when it has uncommitted changes)
  practi merge <branch>          fast-forward, else a pointer move (same-tree commits
                                 are identical)
  practi log [--branch <b>] [--limit N] [--json]
                                 the commit history (tip first)
  practi history reword <seq> -m <msg> | squash <seq> | drop <seq> | reset <seq>
                                 rewrite the local commit chain (git-style);
                                 push reconciles with the hub — divergence needs --force
  practi export is the read-back door; the working file is the write door

inside a practice folder also:
  practi show <hash> [--json] [--doc]   inspect one revision node (hash prefix OK)
  practi search [query...] [--json]     search this practice's revisions
  practi note add|list|edit|delete      local learning notes pinned to node hashes
                                 (.practi/notes.json, never uploaded)
  practi lint                           quality hints on the current branch head
  practi blob add <file-or-url>         store an attachment's bytes in the pool
  practi gc [--apply]                   free orphan blobs (dry-run by default)
  practi web [--port 4317]              browse this practice in a local web UI

anywhere:
  practi init [path]             create the config home (credentials + remote)
  practi login [--no-open]       OAuth sign-in to the hub (browser consent)
  practi logout | me | remote set <url> | remove
  practi config                  show config home and remote
  practi fix <file.json> [--dry-run]   migrate a POP 1.x document file to 2.0
  practi spec                    print pop-spec.md (bundled with the SDK)
  practi skill install | update | uninstall | import <dir> | export <ref>
  practi update                  self-update via npm
  practi version | --version     show CLI + pop-spec versions

options:
  --dir <path>                   target a practice folder from outside it

the config home (default ~/.practi) keeps practi.json (remote) and
practi.auth.json (OAuth credentials) — practices themselves are plain
folders, wherever you keep your documents.
`;

const COMMON = {
  'data-dir': { type: 'string' as const },
  help: { type: 'boolean' as const, short: 'h' },
};

function str(v: string | undefined): string {
  return v as string;
}

/** 退役命令统一存根：说清去哪了 */
function retired(cmd: string): number {
  const pointers: Record<string, string> = {
    edit: 'the working file IS the edit — open <name>.json with any editor, then `practi commit -m "..."`',
    ls: 'practices are folders — use your file manager; `practi log` shows a practice\'s revisions',
    list: 'practices are folders — browse them in your file manager',
    remove: 'a practice folder is self-contained — deleting the folder removes the practice (the hub copy stays)',
    claim: 'the pops registry retired — content lives in practice folders now',
    unclaim: 'the pops registry retired — content lives in practice folders now',
    publish: 'two steps now: `practi commit -m "..."` then `practi push`',
    fetch: 'clone brings the full chain; fetch retired',
    repair: 'the claims ledger retired — nothing to repair',
    migrate: 'the config home is tiny — move the folder and point $PRACTI_HOME at it',
    instance: 'retired by the practice-folder model (2026-10-20)',
    practice: 'commands are flat now: `practi new <name>` / `practi log` / ... (the practice prefix retired)',
  };
  console.error(`\`practi ${cmd}\` was retired — ${pointers[cmd] ?? 'see practi --help'}`);
  return 1;
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
        options: { ...COMMON, apply: { type: 'boolean' as const }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi gc [--apply]   (free orphan blobs; dry-run by default)'); return 0; }
      return runGc({ dir: str(values.dir), apply: values.apply === true });
    }
    case 'init': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi init [path]   (create the config home: credentials + remote)'); return 0; }
      return runInit({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'config': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi config'); return 0; }
      return runConfig({ dataDir: str(values['data-dir']) });
    }
    case 'lint': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, json: { type: 'boolean' as const }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi lint   (quality hints on the current branch head; read-only, exit 0)');
        return 0;
      }
      return runLint({ dir: str(values.dir), json: values.json === true });
    }
    case 'new': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, base: { type: 'string' as const }, message: { type: 'string' as const, short: 'm' }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi new <name> [--base <file.json>] [-m <msg>]   (birth a practice folder in cwd)'); return 0; }
      return await runNew({ positional: positionals, base: values.base, message: values.message });
    }
    case 'commit': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, message: { type: 'string' as const, short: 'm' }, amend: { type: 'boolean' as const }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi commit [-m <msg>] [--amend]   (snapshot the working file; local only)'); return 0; }
      if (positionals.length > 0) {
        console.error('error: commit takes no arguments — the working file <name>.json is what gets committed');
        return 1;
      }
      return await runCommit({ positional: positionals, message: values.message, amend: values.amend === true, dir: values.dir });
    }
    case 'export': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, out: { type: 'string' as const, short: 'o' }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi export <hash> [-o <file>]   (write a revision back out as a document)'); return 0; }
      return runExport({ positional: positionals, out: values.out, dir: values.dir });
    }
    case 'show': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, json: { type: 'boolean' as const }, doc: { type: 'boolean' as const }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi show <hash> [--json] [--doc]'); return 0; }
      if (positionals.length === 0) { console.error('usage: practi show <hash> [--json] [--doc]'); return 1; }
      return runShow({ hash: positionals[0], json: values.json === true, doc: values.doc === true, dir: values.dir });
    }
    case 'web': {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          port: { type: 'string' as const },
          open: { type: 'boolean' as const, default: true },
          'no-open': { type: 'boolean' as const },
          dir: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi web [--port 4317] [--no-open]   (browse this practice locally)'); return 0; }
      const port = values.port ? Number(values.port) : 4317;
      return runWeb({ dir: str(values.dir), port: Number.isInteger(port) && port > 0 ? port : 4317, open: values['no-open'] !== true });
    }
    case 'blob': {
      const sub = rest[0];
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        options: { ...COMMON, name: { type: 'string' as const }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi blob add <file-or-url> [--name <name>]   (store attachment bytes in this practice)'); return 0; }
      if (sub === 'add') {
        return runBlobAdd({ name: values.name, dir: values.dir, positional: positionals });
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
        console.log('       practi skill import <skill-dir>          replay a `practi skill export` directory (sidecar required)');
        console.log('       practi skill export <ref> [--dir <out-dir>]  project a revision as an installable skill directory');
        return 0;
      }
      if (action === undefined) {
        console.error('usage: practi skill install|update|uninstall [--dir <skills-dir>]   (default dir: ~/.agents/skills)');
        return 1;
      }
      return runSkill({ action, dir: values.dir, positional: positionals[0] });
    }
    case 'spec': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi spec   (print the bundled pop-spec.md)'); return 0; }
      return runSpec({});
    }
    case 'update': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: practi update   (self-update via npm; checks the registry\'s latest)'); return 0; }
      return await runUpdate({});
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
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi push [--force] [--dir <path>]   (practice → hub; first push creates it; divergence errors, --force overwrites)');
        return 0;
      }
      return await runPush({ dir: values.dir, force: values.force === true });
    }
    case 'pull': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi pull [--dir <path>]   (reconcile with the hub: fetch missing revisions, fast-forward)'); return 0; }
      return await runPull({ dir: values.dir });
    }
    case 'clone': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi clone <owner>/<name>[@branch] [--dir <path>]   (clone a hub practice into a local folder)'); return 0; }
      return await runClone({ positional: positionals, dir: values.dir });
    }
    case 'branch': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          from: { type: 'string' as const },
          delete: { type: 'string' as const, short: 'd' },
          dir: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi branch [name] [-d <name>]   (list / create / delete branches; * marks the current branch)');
        return 0;
      }
      return runBranch({ positional: positionals, from: values.from, deleteBranch: values.delete, dir: values.dir });
    }
    case 'switch': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi switch <branch>   (switch branches; the working file follows the head)'); return 0; }
      return runSwitch({ positional: positionals, dir: values.dir });
    }
    case 'merge': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi merge <branch>   (fast-forward, else pointer move)'); return 0; }
      return runMerge({ positional: positionals, dir: values.dir });
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
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: practi log [--branch <b>] [--limit N] [--json]   (the commit history, tip first)'); return 0; }
      const logLimit = values.limit ? Number(values.limit) : undefined;
      return runLog({
        branch: values.branch,
        limit: logLimit !== undefined && Number.isInteger(logLimit) && logLimit > 0 ? logLimit : undefined,
        json: values.json === true,
        dir: values.dir,
      });
    }
    case 'history': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          dir: { type: 'string' as const },
          message: { type: 'string' as const, short: 'm' },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi history reword <seq> -m <msg> | squash <seq> | drop <seq> | reset <seq>   (rewrite the local chain; push reconciles)');
        return 0;
      }
      return await runHistory({ positional: positionals, dir: values.dir, message: values.message });
    }
    case 'fix': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, 'dry-run': { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi fix <file.json> [--dry-run]   (strip POP 1.x history fields — revisions/refines — from a document file)');
        return 0;
      }
      return runFix({ positional: positionals, dryRun: values['dry-run'] === true });
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
          dir: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi search [query...] [--limit N] [--json] [--notes] [--semantic]   (search this practice\'s revisions)');
        return 0;
      }
      const limit = values.limit ? Number(values.limit) : 20;
      return await runSearch({
        positional: positionals,
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20,
        json: values.json === true,
        notes: values.notes === true,
        semantic: values.semantic === true,
        dir: values.dir,
      });
    }
    case 'similar': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          limit: { type: 'string' as const },
          json: { type: 'boolean' as const },
          dir: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi similar <hash> [--limit N] [--json]   (content neighbours within this practice)');
        return 0;
      }
      if (positionals.length === 0) {
        console.error('usage: practi similar <hash> [--limit N] [--json]');
        return 1;
      }
      const simLimit = values.limit ? Number(values.limit) : 10;
      return runSimilar({
        ref: positionals[0],
        limit: Number.isInteger(simLimit) && simLimit > 0 ? Math.min(simLimit, 50) : 10,
        json: values.json === true,
        dir: values.dir,
      });
    }
    case 'note': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          message: { type: 'string' as const, short: 'm' },
          json: { type: 'boolean' as const },
          dir: { type: 'string' as const },
        },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi note add|list|edit|delete   (local notes pinned to node hashes; see `practi note` help)');
        return 0;
      }
      return runNote({
        positional: positionals,
        message: values.message,
        json: values.json === true,
        dir: values.dir,
      });
    }
    case 'embed': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, json: { type: 'boolean' as const }, notes: { type: 'boolean' as const }, dir: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) {
        console.log('usage: practi embed status|pull|build|prune [--json] [--notes]   (optional offline vector model, scoped to this practice)');
        return 0;
      }
      return await runEmbed({
        positional: positionals,
        json: values.json === true,
        notes: values.notes === true,
        dir: values.dir,
      });
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    case 'edit':
    case 'ls':
    case 'list':
    case 'remove':
    case 'claim':
    case 'unclaim':
    case 'publish':
    case 'fetch':
    case 'repair':
    case 'migrate':
    case 'instance':
    case 'practice':
      return retired(cmd);
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
