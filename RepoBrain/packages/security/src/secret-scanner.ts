/**
 * Secret scanning at index time (spec §7.3, §12.2).
 *
 * Pure TypeScript, no dependencies. Given file content, detect likely secrets and produce a
 * redacted copy. The indexer uses this BEFORE storing content: if `hasSecrets` is true, the
 * file body is not stored (skeleton only) and `has_secrets` is set, guaranteeing the
 * shareable graph artifact (spec §13) never contains secret values.
 */

export interface SecretFinding {
  type: string;
  line: number; // 1-based
  preview: string; // masked preview, safe to log
}

export interface ScanResult {
  findings: SecretFinding[];
  hasSecrets: boolean;
  redacted: string;
}

const REDACTION = '***REDACTED***';

/** High-signal, low-false-positive patterns. `redactGroup` names the capture to mask. */
interface Pattern {
  type: string;
  re: RegExp;
  redactGroup?: string;
}

const PATTERNS: Pattern[] = [
  { type: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    type: 'private_key_block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { type: 'github_pat', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { type: 'github_fine_grained_pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { type: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'openai_key', re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { type: 'google_api_key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { type: 'stripe_secret_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    // key: "value" / key = 'value' for secret-looking keys, high-entropy values only
    type: 'generic_secret_assignment',
    re: /(?<key>(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|auth[_-]?token))(?<sep>["']?\s*[:=]\s*)(?<quote>["'])(?<val>[^"'\n]{8,})\k<quote>/gi,
    redactGroup: 'val',
  },
];

/** Values that look like a secret assignment but are clearly placeholders/refs. */
const PLACEHOLDER =
  /^(?:changeme|change_me|password|secret|token|example|sample|dummy|test|placeholder|redacted|none|null|undefined|true|false|xxx+|\*+|<[^>]*>|your[_-].*|env\..*|process\.env.*)$/i;

/** Shannon entropy (bits/char) — used to gate generic assignments. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function isLikelySecretValue(val: string): boolean {
  if (PLACEHOLDER.test(val.trim())) return false;
  if (val.includes('${') || val.includes('process.env')) return false;
  // require some charset diversity + entropy, OR an obviously long token
  const entropy = shannonEntropy(val);
  const diverse = /[A-Za-z]/.test(val) && /[0-9]/.test(val);
  return entropy >= 3.2 || (diverse && val.length >= 20) || val.length >= 32;
}

/**
 * Scan content for secrets and return findings + a redacted copy.
 * Deterministic: same input → same output (no randomness).
 */
export function scanForSecrets(content: string): ScanResult {
  const findings: SecretFinding[] = [];
  // Collect [start, end) spans to redact, with the finding.
  const spans: { start: number; end: number }[] = [];

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(content)) !== null) {
      const full = m[0];
      if (full.length === 0) {
        p.re.lastIndex++;
        continue;
      }
      if (p.type === 'generic_secret_assignment') {
        const val = m.groups?.val ?? '';
        if (!isLikelySecretValue(val)) continue;
        // redact only the value span
        const valStart = m.index + full.lastIndexOf(val);
        spans.push({ start: valStart, end: valStart + val.length });
        findings.push({
          type: p.type,
          line: lineOf(content, m.index),
          preview: `${m.groups?.key ?? 'secret'}=${mask(val)}`,
        });
      } else {
        spans.push({ start: m.index, end: m.index + full.length });
        findings.push({
          type: p.type,
          line: lineOf(content, m.index),
          preview: mask(full),
        });
      }
    }
  }

  const redacted = applyRedactions(content, spans);
  return { findings, hasSecrets: findings.length > 0, redacted };
}

function mask(s: string): string {
  const head = s.slice(0, 3);
  return `${head}${'*'.repeat(Math.min(8, Math.max(3, s.length - 3)))}`;
}

function applyRedactions(content: string, spansIn: { start: number; end: number }[]): string {
  if (spansIn.length === 0) return content;
  // sort + merge overlaps, then rebuild
  const spans = [...spansIn].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  let out = '';
  let cursor = 0;
  for (const s of merged) {
    out += content.slice(cursor, s.start) + REDACTION;
    cursor = s.end;
  }
  out += content.slice(cursor);
  return out;
}
