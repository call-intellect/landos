import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { applyUpdate } from '../update.mjs';

const POLICY = {
  ours_replaceable: ['*.md', 'kit.manifest.yaml'],
  merge_required: ['CLAUDE.md'],
  theirs_never_touch: ['plans/**'],
};

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'vibeos-apply-'));
  return { dir, base: join(dir, 'base'), ours: join(dir, 'ours'), neu: join(dir, 'new') };
}

function put(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(dir, rel) {
  return readFileSync(join(dir, rel), 'utf8');
}

function cleanup(ws) {
  rmSync(ws.dir, { recursive: true, force: true });
}

test('(a) unchanged file is replaced with Y', () => {
  const ws = makeWorkspace();
  try {
    put(ws.base, 'notes.md', 'v1\n');
    put(ws.ours, 'notes.md', 'v1\n');
    put(ws.neu, 'notes.md', 'v2\n');
    const res = applyUpdate(ws.ours, ws.base, ws.neu, POLICY);
    assert.equal(read(ws.ours, 'notes.md'), 'v2\n');
    assert.ok(res.replaced.includes('notes.md'));
    assert.ok(!res.merged.includes('notes.md'));
  } finally {
    cleanup(ws);
  }
});

test('(b) changed file, non-overlapping edit is merged, both edits survive', () => {
  const ws = makeWorkspace();
  try {
    const base = 'h1\nh2\nh3\nh4\nh5\nh6\nh7\n';
    put(ws.base, 'CLAUDE.md', base);
    put(ws.ours, 'CLAUDE.md', 'OURS\nh2\nh3\nh4\nh5\nh6\nh7\n');
    put(ws.neu, 'CLAUDE.md', 'h1\nh2\nh3\nh4\nh5\nh6\nTHEIRS\n');
    const res = applyUpdate(ws.ours, ws.base, ws.neu, POLICY);
    const merged = read(ws.ours, 'CLAUDE.md');
    assert.ok(merged.includes('OURS'), 'edit of the user survives');
    assert.ok(merged.includes('THEIRS'), 'edit from Y is applied');
    assert.ok(!merged.includes('<<<<<<<'), 'no conflict markers');
    assert.ok(res.merged.includes('CLAUDE.md'));
    assert.ok(!res.kept_yours.includes('CLAUDE.md'));
  } finally {
    cleanup(ws);
  }
});

test('(c) changed file, conflicting edit keeps OURS untouched and lists it', () => {
  const ws = makeWorkspace();
  try {
    put(ws.base, 'README.md', 'line1\nMID\nline3\n');
    const ours = 'line1\nOURS-MID\nline3\n';
    put(ws.ours, 'README.md', ours);
    put(ws.neu, 'README.md', 'line1\nTHEIRS-MID\nline3\n');
    const res = applyUpdate(ws.ours, ws.base, ws.neu, POLICY);
    assert.equal(read(ws.ours, 'README.md'), ours, 'user file is byte-for-byte preserved');
    assert.ok(res.kept_yours.includes('README.md'));
    assert.ok(!res.merged.includes('README.md'));
    assert.ok(!res.replaced.includes('README.md'));
  } finally {
    cleanup(ws);
  }
});

test('(d) theirs_never_touch is never modified', () => {
  const ws = makeWorkspace();
  try {
    put(ws.base, 'plans/mine.md', 'seed\n');
    put(ws.ours, 'plans/mine.md', 'user content\n');
    put(ws.neu, 'plans/mine.md', 'kit would overwrite\n');
    const res = applyUpdate(ws.ours, ws.base, ws.neu, POLICY);
    assert.equal(read(ws.ours, 'plans/mine.md'), 'user content\n');
    assert.ok(!res.replaced.includes('plans/mine.md'));
    assert.ok(!res.merged.includes('plans/mine.md'));
    assert.ok(!res.kept_yours.includes('plans/mine.md'));
    assert.ok(!res.deleted.includes('plans/mine.md'));
  } finally {
    cleanup(ws);
  }
});

test('(e) rename: unchanged file absent in Y is deleted; user-changed one is kept', () => {
  const ws = makeWorkspace();
  try {
    put(ws.base, 'OLD.md', 'old\n');
    put(ws.ours, 'OLD.md', 'old\n');
    put(ws.base, 'KEEP.md', 'orig\n');
    put(ws.ours, 'KEEP.md', 'user-edited\n');
    put(ws.neu, 'TOUR.md', 'new home\n');
    const res = applyUpdate(ws.ours, ws.base, ws.neu, POLICY);
    assert.ok(!existsSync(join(ws.ours, 'OLD.md')), 'unchanged removed file is deleted');
    assert.ok(res.deleted.includes('OLD.md'));
    assert.ok(existsSync(join(ws.ours, 'KEEP.md')), 'user-changed removed file is kept');
    assert.ok(!res.deleted.includes('KEEP.md'));
    assert.ok(res.added.includes('TOUR.md'));
  } finally {
    cleanup(ws);
  }
});

test('new file present in Y but not in project is added', () => {
  const ws = makeWorkspace();
  try {
    put(ws.base, 'a.md', 'a\n');
    put(ws.ours, 'a.md', 'a\n');
    put(ws.neu, 'a.md', 'a\n');
    put(ws.neu, 'brand-new.md', 'fresh\n');
    const res = applyUpdate(ws.ours, ws.base, ws.neu, POLICY);
    assert.equal(read(ws.ours, 'brand-new.md'), 'fresh\n');
    assert.ok(res.added.includes('brand-new.md'));
  } finally {
    cleanup(ws);
  }
});

test('(g) file/directory type mismatch is skipped, not a crash; user data untouched', () => {
  const ws = makeWorkspace();
  try {
    put(ws.base, 'conf.md', 'base\n');
    put(join(ws.ours, 'conf.md'), 'inner.txt', 'user data\n');
    put(ws.neu, 'conf.md', 'new\n');
    const res = applyUpdate(ws.ours, ws.base, ws.neu, POLICY);
    assert.ok(res.skipped.includes('conf.md'), 'type mismatch is skipped, not thrown');
    assert.equal(read(join(ws.ours, 'conf.md'), 'inner.txt'), 'user data\n', 'user directory content is untouched');
  } finally {
    cleanup(ws);
  }
});
