import { defaultDataDir, DEFAULT_REMOTE_URL, loadState, saveState } from '../state.js';
import { loadCredentials, deleteCredentials } from '../credentials.js';
import { cliResource, revokeToken } from '../oauth.js';

export interface RemoteOpts {
  dataDir?: string;
  positional: string[];
}

/** practi remote set / remove。看当前挂靠用 `practi config`（remote show 已砍——与 config 重复）。 */
export async function runRemote(opts: RemoteOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  const action = opts.positional[0];

  switch (action) {
    case 'set': {
      const url = opts.positional[1];
      if (!url) {
        console.error('usage: practi remote set <url>   e.g. practi remote set https://practihub.com');
        return 1;
      }
      if (!/^https?:\/\/\S+$/i.test(url)) {
        console.error(`error: "${url}" is not an http(s) URL`);
        return 1;
      }
      state.remote = { url: url.replace(/\/+$/, '') };
      saveState(dataDir, state);
      console.log(`remote set: ${state.remote.url}`);
      // 换 hub 时，旧 hub 签发的凭据对新 remote 无用：revoke（best-effort，打给旧 hub）并清除
      const creds = loadCredentials(dataDir);
      if (creds && creds.resource && creds.resource !== cliResource(state.remote.url)) {
        const oldOrigin = creds.resource.replace(/\/cli$/, '');
        if (oldOrigin) await revokeToken(oldOrigin, creds.client_id, creds.refresh_token, 'refresh_token');
        deleteCredentials(dataDir);
        console.log(`note: cleared credentials issued by ${oldOrigin} — run \`practi login\` against ${state.remote.url}`);
      }
      return 0;
    }
    case 'remove': {
      delete state.remote;
      saveState(dataDir, state);
      console.log(`remote removed — falls back to the official hub (${DEFAULT_REMOTE_URL})`);
      // 与 set 同规：换回官方 hub 时，自建 hub 签发的凭据已无用——revoke（best-effort）并清除
      const creds = loadCredentials(dataDir);
      if (creds && creds.resource && creds.resource !== cliResource(DEFAULT_REMOTE_URL)) {
        const oldOrigin = creds.resource.replace(/\/cli$/, '');
        if (oldOrigin) await revokeToken(oldOrigin, creds.client_id, creds.refresh_token, 'refresh_token');
        deleteCredentials(dataDir);
        console.log(`note: cleared credentials issued by ${oldOrigin} — run \`practi login\` against ${DEFAULT_REMOTE_URL}`);
      }
      return 0;
    }
    default:
      console.error('error: missing action — set or remove');
      console.error('usage: practi remote set <url> | remove   (see the current remote with `practi config`)');
      return 1;
  }
}
