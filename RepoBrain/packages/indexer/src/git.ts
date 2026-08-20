import { execFileSync } from 'node:child_process';

function run(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(root: string): boolean {
  return run(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function headCommit(root: string): string | null {
  return run(root, ['rev-parse', 'HEAD']);
}

export function workingTreeDirty(root: string): boolean {
  const s = run(root, ['status', '--porcelain']);
  return s === null ? false : s.length > 0;
}

export function changedSince(root: string, commit: string | null): number {
  if (!commit) return 0;
  const s = run(root, ['diff', '--name-only', commit]);
  if (!s) return 0;
  return s.split('\n').filter(Boolean).length;
}

export interface FileGitMeta {
  last_commit: string | null;
  last_date: string | null; // ISO
  churn: number;
}

/**
 * Per-file git metadata. Best-effort — returns nulls/0 when there is no git history
 * (e.g. untracked files or a repo with no commits). Note: this spawns git per file; a
 * batched implementation is a planned perf improvement for large repos.
 */
export function fileGitMeta(root: string, relPath: string, churnWindowDays: number): FileGitMeta {
  const info = run(root, ['log', '-1', '--format=%H%x00%cI', '--', relPath]);
  let last_commit: string | null = null;
  let last_date: string | null = null;
  if (info) {
    const [h, d] = info.split('\0');
    last_commit = h || null;
    last_date = d || null;
  }
  const churnStr = run(root, [
    'rev-list',
    '--count',
    `--since=${churnWindowDays} days ago`,
    'HEAD',
    '--',
    relPath,
  ]);
  const churn = churnStr ? parseInt(churnStr, 10) || 0 : 0;
  return { last_commit, last_date, churn };
}
