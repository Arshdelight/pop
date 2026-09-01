import { type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createdRoot, freePort, init, spawnWeb, tempDataDir, untilHealthy } from './helpers.js';

/**
 * POST /api/run 端点：spawn 真 CLI 的 web server（tsx 直跑 src），用 node fetch 打真 HTTP。
 * 覆盖安全闸（方法/Origin/content-type/白名单）与 new 全链路、并发互斥、未登录命令的退出码。
 */

const ACTION = { name: 'Boil water', content: 'Heat the drinking water to boiling.' };
const TREE = {
  name: 'Make tea',
  description: 'From kettle to cup',
  children: [
    ACTION,
    { name: 'Pour', content: 'Pour along the wall to 70% full.' },
  ],
};

async function run(base: string, body: unknown, origin?: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}/api/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

describe('POST /api/run: action endpoint for DIY frontends', () => {
  const dir = tempDataDir();
  let child: ChildProcess;
  let base: string;
  let originBase: string;

  beforeAll(async () => {
    await init(dir);
    const port = await freePort();
    child = spawnWeb(dir, port);
    base = await untilHealthy(port, child);
    originBase = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    child?.kill();
  });

  it('rejects non-POST, foreign/missing Origin, wrong content-type, unknown cmd', async () => {
    expect((await fetch(`${base}/api/run`)).status).toBe(405); // GET, no body

    const noOrigin = await run(base, { cmd: 'me' });
    expect(noOrigin.status).toBe(403);

    const foreign = await run(base, { cmd: 'me' }, 'http://evil.example');
    expect(foreign.status).toBe(403);

    const badType = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: originBase },
      body: 'x',
    });
    expect(badType.status).toBe(415);

    const unknown = await run(base, { cmd: 'update' }, originBase); // whitelisted out on purpose
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/unknown cmd/);
  });

  it('new runs end to end: exit code + captured output, doc lands in /api/directs', async () => {
    const origin = originBase;
    const r = await run(base, { cmd: 'new', args: { json: JSON.stringify(TREE) } }, origin);
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(r.json.out).toMatch(/^created:\s+sha256:/m);

    const root = createdRoot(r.json.out);
    const docs = await (await fetch(`${base}/api/directs`)).json();
    expect(docs.docs.some((d: { hash: string }) => d.hash === root)).toBe(true);
  });

  it('missing args.json is a 400, not a command crash', async () => {
    const origin = originBase;
    const r = await run(base, { cmd: 'new', args: {} }, origin);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/args\.json/);
  });

  it('two concurrent news both succeed (serialized by the run queue)', async () => {
    const origin = originBase;
    const [a, b] = await Promise.all([
      run(base, { cmd: 'new', args: { json: JSON.stringify({ ...ACTION, name: 'A' }) } }, origin),
      run(base, { cmd: 'new', args: { json: JSON.stringify({ ...ACTION, name: 'B' }) } }, origin),
    ]);
    expect(a.json.code).toBe(0);
    expect(b.json.code).toBe(0);
    // each response carries only its own command's output — the queue never interleaves captures
    const rootA = createdRoot(a.json.out);
    const rootB = createdRoot(b.json.out);
    expect(rootA).not.toBe(rootB);
    expect(a.json.out).not.toContain(rootB);
    expect(b.json.out).not.toContain(rootA);
  });

  it('me without credentials reports the CLI exit code, not an HTTP error', async () => {
    const origin = originBase;
    const r = await run(base, { cmd: 'me' }, origin);
    expect(r.status).toBe(200);
    expect(r.json.code).not.toBe(0);
    expect(r.json.err).toMatch(/login/i);
  });
});
