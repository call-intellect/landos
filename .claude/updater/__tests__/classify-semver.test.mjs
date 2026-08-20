import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semverCompare, globToRegex, classify, parsePolicyYaml } from '../update.mjs';

test('(f) semver compares numerically, 0.10.0 > 0.9.0', () => {
  assert.ok(semverCompare('0.10.0', '0.9.0') > 0);
  assert.ok(semverCompare('0.7.0', '0.6.0') > 0);
  assert.ok(semverCompare('0.6.0', '0.7.0') < 0);
  assert.equal(semverCompare('0.7.0', '0.7.0'), 0);
  assert.ok(semverCompare('1.0.0', '0.99.99') > 0);
  assert.ok(semverCompare('0.10.0', '0.10.0') === 0);
});

test('glob * matches any char including slash', () => {
  assert.ok(globToRegex('.claude/skills/**').test('.claude/skills/foo/bar.md'));
  assert.ok(globToRegex('*.md').test('a/b/c.md'));
  assert.ok(globToRegex('kit.manifest.yaml').test('kit.manifest.yaml'));
  assert.ok(!globToRegex('*.md').test('a/b/c.txt'));
  assert.ok(!globToRegex('kit.manifest.yaml').test('kitXmanifestXyaml'));
});

test('classify priority: theirs > merge > ours, default merge_required', () => {
  const p = {
    ours_replaceable: ['*.md'],
    merge_required: ['CLAUDE.md'],
    theirs_never_touch: ['plans/**'],
  };
  assert.equal(classify('CLAUDE.md', p), 'merge_required');
  assert.equal(classify('README.md', p), 'ours_replaceable');
  assert.equal(classify('plans/notes.md', p), 'theirs_never_touch');
  assert.equal(classify('unknown.bin', p), 'merge_required');
});

test('parsePolicyYaml reads three shelves from a yaml manifest block', () => {
  const yaml = [
    'kit_version: "0.6.0"',
    'built_at: "2026-07-16T00:00:00Z"',
    '',
    'update_policy:',
    '  ours_replaceable:',
    '    - ".claude/skills/**"',
    '    - "README.md"',
    '  merge_required:',
    '    - "CLAUDE.md"',
    '    - ".gitignore"',
    '  theirs_never_touch:',
    '    - "plans/**"',
    '    - "second-brain/05_history/**"',
  ].join('\n');
  const p = parsePolicyYaml(yaml);
  assert.deepEqual(p.ours_replaceable, ['.claude/skills/**', 'README.md']);
  assert.deepEqual(p.merge_required, ['CLAUDE.md', '.gitignore']);
  assert.deepEqual(p.theirs_never_touch, ['plans/**', 'second-brain/05_history/**']);
});
