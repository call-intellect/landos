import { execFileSync } from 'node:child_process';

function run(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(root: string): boolean {
  return run(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}
export function workingTreeDirty(root: string): boolean {
  const s = run(root, ['status', '--porcelain']);
  return s === null ? false : s.length > 0;
}
export function changedSince(root: string, commit: string | null): number {
  if (!commit) return 0;
  const s = run(root, ['diff', '--name-only', commit]);
  return s ? s.split('\n').filter(Boolean).length : 0;
}
