import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFromDoc } from '../src/doc.js';
import { initWorkspace, loadWorkspace, storeBlob } from '../src/store.js';
import { SIDECAR_FILE, SKILL_FILE, exportSkill, importSkill } from '../src/skill.js';
import { tempDir } from './helpers.js';

/* Skill ⇄ POP conversion: replay-only import, lossless round-trip, drift policy */

function writeSkill(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, SKILL_FILE),
    '---\nname: demo-skill\ndescription: A demo skill\nx-vendor: teapot\nx-count: 3\n---\n\n# Demo\n\nDo the thing.\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n', 'utf8');
}

describe('importSkill (foreign skills are rejected)', () => {
  it('rejects a directory without a sidecar: import is the inverse of export, not a skill importer', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const skillDir = tempDir();
    writeSkill(skillDir);

    try {
      importSkill(loadWorkspace(wsDir), skillDir);
      throw new Error('expected E_NO_SIDECAR');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_NO_SIDECAR');
      expect((e as Error).message).toMatch(/pop\.doc\.json/);
      // 指引必须指向「重新撰写」而非机械压平
      expect((e as { hint?: string }).hint).toMatch(/author/i);
    }
  });

  it('rejects a missing SKILL.md', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const empty = tempDir();
    expect(() => importSkill(loadWorkspace(wsDir), empty)).toThrowError(/SKILL\.md/);
  });

  it('media syntax shown in inline/fenced code is documentation, not a reference (E_MEDIA_REF must not fire)', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    // 直接走文档导入（无 sidecar 的技能目录已不再被 importSkill 接受）
    const { count } = createFromDoc(loadWorkspace(wsDir), {
      type: 'action',
      name: 'media-doc',
      content: 'Syntax: `![caption](attachment-name)` resolves node-locally.\n\n```\n"content": "The result:\\n\\n![pour demo](pour-demo.mp4)"\n```\n',
    });
    expect(count).toBe(1);
  });
});

describe('exportSkill + round-trip', () => {
  const buildDoc = () => ({
    type: 'practice',
    name: 'Make tea',
    description: 'From kettle to cup',
    op: 'seq',
    children: [
      {
        type: 'action',
        name: 'Boil water',
        content: 'Heat until boiling.',
        outputs: [{ name: 'boiling water', spec: '100°C' }],
      },
      {
        type: 'action',
        name: 'Pour',
        description: 'Fill the cup',
        content: 'Pour along the wall to 70% full.',
        metadata: { 'x-demo': 'teapot' },
        inputs: [{ name: 'boiling water' }],
        attachments: [{ name: 'photo.jpg', hash: 'sha256:dac6f451810bc38390a3b6e278d686b332a77cf21b2ea95145ad73722b77035d', size: 11 }],
      },
    ],
  });

  it('round-trips byte-identically via the sidecar (op/flow/metadata survive)', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const ws = loadWorkspace(wsDir);
    storeBlob(wsDir, Buffer.from('photo-bytes', 'utf8')); // A5 向量字节
    const { root } = createFromDoc(ws, buildDoc());
    const wsFresh = loadWorkspace(wsDir);

    const outDir = tempDir();
    const res = exportSkill(wsFresh, root, outDir);
    expect(res.rootHash).toBe(root);
    expect(res.files).toEqual(['photo.jpg']);
    expect(fs.readFileSync(path.join(outDir, 'photo.jpg'), 'utf8')).toBe('photo-bytes');
    expect(fs.existsSync(path.join(outDir, SKILL_FILE))).toBe(true);
    expect(fs.existsSync(path.join(outDir, SIDECAR_FILE))).toBe(true);

    // 未改动的导出目录 → sidecar 精确复放，hash 与原文档一致（无损往返）
    const wsDir2 = tempDir();
    initWorkspace(wsDir2);
    const back = importSkill(loadWorkspace(wsDir2), outDir);
    expect(back.sidecarUsed).toBe(true);
    expect(back.drift).toBe(false);
    expect(back.root).toBe(root);

    // 附件文件随目录旅行：回放时重新入新工作区的 blob 库（跨机器往返的关键一环）
    const outDir2 = tempDir();
    const again = exportSkill(loadWorkspace(wsDir2), back.root, outDir2);
    expect(again.rootHash).toBe(root);
    expect(fs.readFileSync(path.join(outDir2, 'photo.jpg'), 'utf8')).toBe('photo-bytes');
  });

  it('replay refuses a sidecar attachment whose file left the directory', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const ws = loadWorkspace(wsDir);
    storeBlob(wsDir, Buffer.from('photo-bytes', 'utf8'));
    const { root } = createFromDoc(ws, buildDoc());
    const outDir = tempDir();
    exportSkill(loadWorkspace(wsDir), root, outDir);
    fs.rmSync(path.join(outDir, 'photo.jpg'));

    const wsDir2 = tempDir();
    initWorkspace(wsDir2);
    try {
      importSkill(loadWorkspace(wsDir2), outDir);
      throw new Error('expected E_BLOB_MISSING');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_BLOB_MISSING');
    }
  });

  it('replay refuses an attachment file that disagrees with its pointer', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const ws = loadWorkspace(wsDir);
    storeBlob(wsDir, Buffer.from('photo-bytes', 'utf8'));
    const { root } = createFromDoc(ws, buildDoc());
    const outDir = tempDir();
    exportSkill(loadWorkspace(wsDir), root, outDir);
    fs.writeFileSync(path.join(outDir, 'photo.jpg'), 'tampered', 'utf8');

    const wsDir2 = tempDir();
    initWorkspace(wsDir2);
    try {
      importSkill(loadWorkspace(wsDir2), outDir);
      throw new Error('expected E_BLOB_CORRUPT');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_BLOB_CORRUPT');
    }
  });

  it('drift policy A: hand-edited SKILL.md warns and the body wins (new hash)', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const ws = loadWorkspace(wsDir);
    storeBlob(wsDir, Buffer.from('photo-bytes', 'utf8'));
    const { root } = createFromDoc(ws, buildDoc());
    const wsFresh = loadWorkspace(wsDir);

    const outDir = tempDir();
    exportSkill(wsFresh, root, outDir);
    const skillMd = path.join(outDir, SKILL_FILE);
    fs.writeFileSync(skillMd, fs.readFileSync(skillMd, 'utf8') + '\nHand-edited line.\n', 'utf8');

    const warns: string[] = [];
    const wsDir2 = tempDir();
    initWorkspace(wsDir2);
    const back = importSkill(loadWorkspace(wsDir2), outDir, { warn: (m) => warns.push(m) });
    expect(back.sidecarUsed).toBe(false);
    expect(back.drift).toBe(true);
    expect(warningsMentionDrift(warns)).toBe(true);
    expect(back.root).not.toBe(root);
    // 正文为准：手改内容出现在新文档里
    const node = loadWorkspace(wsDir2).nodes.get(back.root);
    expect(node?.content).toContain('Hand-edited line.');
  });

  it('refuses to overwrite an existing SKILL.md in the output dir', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const ws = loadWorkspace(wsDir);
    storeBlob(wsDir, Buffer.from('photo-bytes', 'utf8'));
    const { root } = createFromDoc(ws, buildDoc());
    const wsFresh = loadWorkspace(wsDir);
    const outDir = tempDir();
    exportSkill(wsFresh, root, outDir);
    expect(() => exportSkill(wsFresh, root, outDir)).toThrowError(/already contains/);
  });
});

function warningsMentionDrift(warns: string[]): boolean {
  return warns.some((w) => /out of sync/.test(w));
}
