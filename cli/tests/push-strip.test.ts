import { describe, expect, it } from 'vitest';
import { stripAttachmentUrls } from '../src/cmd/push.js';

describe('push: strip attachment urls (hub policy E_ATTACH_URL)', () => {
  it('removes url from every node; originals untouched (local provenance kept)', () => {
    const leaf = { name: 'A', content: '', attachments: [{ name: 'a.png', hash: 'sha256:ab', url: 'https://cdn.example.com/a.png', mime: 'image/png', size: 3 }] };
    const original = leaf.attachments[0];
    const doc = stripAttachmentUrls({ name: 'R', children: [leaf] });
    const stripped = (doc.children as typeof leaf[])[0].attachments![0];
    expect('url' in stripped).toBe(false);
    expect(stripped).toEqual({ name: 'a.png', hash: 'sha256:ab', mime: 'image/png', size: 3 });
    expect(original.url).toBe('https://cdn.example.com/a.png'); // 工作区原件不动
  });

  it('passes url-free trees through structurally unchanged', () => {
    const doc = { name: 'R', children: [{ name: 'B', content: 'x' }] };
    expect(stripAttachmentUrls(doc)).toEqual(doc);
  });
});
