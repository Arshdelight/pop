import { defaultDataDir, loadState, saveState } from '../state.js';

export interface RemoteOpts {
  dataDir?: string;
  positional: string[];
}

export function runRemote(opts: RemoteOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  const action = opts.positional[0] ?? 'show';

  switch (action) {
    case 'set': {
      const url = opts.positional[1];
      if (!url) {
        console.error('usage: pop remote set <url>   e.g. pop remote set https://practihub.com');
        return 1;
      }
      if (!/^https?:\/\/\S+$/i.test(url)) {
        console.error(`error: "${url}" is not an http(s) URL`);
        return 1;
      }
      state.remote = { url: url.replace(/\/+$/, '') };
      saveState(dataDir, state);
      console.log(`remote set: ${state.remote.url}`);
      return 0;
    }
    case 'remove': {
      delete state.remote;
      saveState(dataDir, state);
      console.log('remote removed');
      return 0;
    }
    case 'show': {
      console.log(state.remote ? state.remote.url : '(not set)');
      return 0;
    }
    default:
      console.error(`usage: pop remote set <url> | show | remove`);
      return 1;
  }
}
