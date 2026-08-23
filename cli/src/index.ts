#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { PracticeError } from '@arshdelight/pop-sdk';
import { runInit } from './cmd/init.js';
import { runConfig } from './cmd/config.js';
import { runRemote } from './cmd/remote.js';
import { runLs } from './cmd/ls.js';
import { runNew } from './cmd/new.js';
import { runEdit } from './cmd/edit.js';
import { runShow } from './cmd/show.js';
import { runLogin, runLogout, runMe } from './cmd/login.js';
import { runWeb } from './web.js';
import { runBlobAdd } from './cmd/blob.js';
import { runPush } from './cmd/push.js';
import { runPull } from './cmd/pull.js';
import { runSearch } from './cmd/search.js';
import { runSubmit, runUnpublish, runDelete } from './cmd/lifecycle.js';
import { runUpdate } from './cmd/update.js';
import { runSpec } from './cmd/spec.js';
import { CLI_VERSION, POP_SPEC_VERSION } from './version.js';

function printVersion(): number {
  console.log(`pop-cli  ${CLI_VERSION}`);
  console.log(`pop-spec ${POP_SPEC_VERSION}  (via @arshdelight/pop-sdk)`);
  return 0;
}

const USAGE = `pop — local registry for POP (Protocol of Practice)

usage:
  pop version | --version        show CLI + pop-spec versions
  pop update                    self-update via npm (checks the registry's latest)
  pop spec                      print pop-spec.md (bundled with the SDK; no network)
  pop init [path]                initialize a data directory (default: %APPDATA%\\pop / ~/.pop)
  pop config                     show data dir, remote, registry summary
  pop remote set <url>           set the remote provider (e.g. https://practihub.com)
  pop remote show | remove       inspect / clear the remote
  pop ls [-a] [--json]           list direct pops (-a also lists indirect nodes)
  pop new <file.json>            create a pop from a JSON document
       | pop new --json '<text>'
       | pop new < file.json
  pop edit <hash> <file.json>     replace a direct pop (new hash; auto-revision + GC)
       | pop edit <hash> --json '<text>' | pop edit <hash> < file.json
       [--message <text>] [--no-revision] [--keep]
  pop show <hash> [--json] [--doc]   inspect one node (hash prefix OK)
  pop web [--port 4317] [--no-open]  browse direct pops in a local web UI
  pop login [--no-open]           OAuth login in the browser (--no-open prints the URL only)
  pop logout                      clear stored credentials (revokes on the server)
  pop me                          show the authenticated practihub user
  pop push [hash]                 upload pops to the remote (default: all direct; stored PRIVATE)
  pop pull [hash]                 fetch pops from the remote (default: all of mine)
  pop search [query...]           search pops on the remote (title-first; empty = browse)
       [--scope public|me|all] [--limit N] [--json]
  pop submit [hash]               submit pops for public review (default: all direct)
  pop unpublish [hash]            withdraw a submission / take one back out of public
  pop delete <hash>               remove your direct claim on the remote (hash required)
  pop blob add <file-or-url>     stage an attachment; emits the attachment entry
                                 (hashes the bytes, stores local blobs in the workspace)

options:
  --data-dir <path>              target data directory (same default as init)

the data directory is a POP workspace: nodes are content-addressed (nodes/*.md),
pop.json records the remote and registered direct roots; login credentials live
in pop.auth.json (kept out of pop.json so the workspace stays commit-safe).
`;

const COMMON = {
  'data-dir': { type: 'string' as const },
  help: { type: 'boolean' as const, short: 'h' },
};

function str(v: string | undefined): string | undefined {
  return v;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);

  if (cmd === 'version' || argv.includes('--version') || argv.includes('-v')) {
    return printVersion();
  }

  switch (cmd) {
    case 'init': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop init [path]'); return 0; }
      return runInit({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'config': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop config'); return 0; }
      return runConfig({ dataDir: str(values['data-dir']) });
    }
    case 'remote': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop remote set <url> | show | remove'); return 0; }
      return runRemote({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'ls': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, all: { type: 'boolean' as const, short: 'a' }, json: { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: pop ls [-a] [--json]'); return 0; }
      return runLs({ dataDir: str(values['data-dir']), all: values.all === true, json: values.json === true });
    }
    case 'new': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...COMMON, json: { type: 'string' as const }, file: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: pop new <file.json> | pop new --json \'<text>\' | pop new < file.json'); return 0; }
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
      if (values.help) { console.log('usage: pop edit <hash> <file.json> [--message <text>] [--no-revision] [--keep]'); return 0; }
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
      if (values.help || positionals.length === 0) { console.log('usage: pop show <hash> [--json] [--doc]'); return 0; }
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
      if (values.help) { console.log('usage: pop web [--port 4317] [--no-open]'); return 0; }
      const port = values.port ? Number(values.port) : 4317;
      return runWeb({ dataDir: str(values['data-dir']), port: Number.isInteger(port) && port > 0 ? port : 4317, open: values['no-open'] !== true });
    }
    case 'login': {
      const { values } = parseArgs({
        args: rest,
        options: { ...COMMON, 'no-open': { type: 'boolean' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: pop login [--no-open]'); return 0; }
      return runLogin({ dataDir: str(values['data-dir']), noOpen: values['no-open'] === true });
    }
    case 'logout': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop logout'); return 0; }
      return runLogout({ dataDir: str(values['data-dir']) });
    }
    case 'me': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop me'); return 0; }
      return runMe({ dataDir: str(values['data-dir']) });
    }
    case 'push': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop push [hash]'); return 0; }
      return runPush({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'pull': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop pull [hash]'); return 0; }
      return runPull({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'search': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...COMMON,
          scope: { type: 'string' as const, default: 'public' },
          limit: { type: 'string' as const },
          json: { type: 'boolean' as const },
        },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: pop search [query...] [--scope public|me|all] [--limit N] [--json]'); return 0; }
      const limit = values.limit ? Number(values.limit) : 20;
      return runSearch({
        dataDir: str(values['data-dir']),
        positional: positionals,
        scope: values.scope ?? 'public',
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20,
        json: values.json === true,
      });
    }
    case 'submit': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop submit [hash]   (default: all direct pops)'); return 0; }
      return runSubmit({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'unpublish': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop unpublish [hash]   (default: all direct pops)'); return 0; }
      return runUnpublish({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'delete': {
      const { values, positionals } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help || positionals.length === 0) { console.log('usage: pop delete <hash>   (explicit hash required)'); return 0; }
      return runDelete({ dataDir: str(values['data-dir']), positional: positionals });
    }
    case 'blob': {
      const sub = rest[0];
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        options: { ...COMMON, name: { type: 'string' as const } },
        allowPositionals: true,
      });
      if (values.help) { console.log('usage: pop blob add <file-or-url> [--name <name>]'); return 0; }
      if (sub === 'add') {
        return runBlobAdd({ dataDir: str(values['data-dir']), name: values.name, positional: positionals });
      }
      console.error('usage: pop blob add <file-or-url> [--name <name>]');
      return 1;
    }
    case 'spec': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop spec   (print the bundled pop-spec.md)'); return 0; }
      return runSpec({ dataDir: str(values['data-dir']) });
    }
    case 'update': {
      const { values } = parseArgs({ args: rest, options: COMMON, allowPositionals: true });
      if (values.help) { console.log('usage: pop update   (self-update via npm; checks the registry\'s latest)'); return 0; }
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
