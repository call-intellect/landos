import { describe, it, expect } from 'vitest';
import { scanForSecrets, shannonEntropy } from '../src/secret-scanner.js';

describe('scanForSecrets', () => {
  it('detects an AWS access key id and redacts it', () => {
    const src = 'const id = "AKIAIOSFODNN7EXAMPLE";';
    const r = scanForSecrets(src);
    expect(r.hasSecrets).toBe(true);
    expect(r.findings.some((f) => f.type === 'aws_access_key_id')).toBe(true);
    expect(r.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(r.redacted).toContain('***REDACTED***');
  });

  it('detects a private key block and redacts the whole block', () => {
    const src = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7Xk3aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghij',
      'kLmNoPqRsTuVwXyZ0123456789abcdefghijkLmNoPqRsTuVwXyZ0123456789ab',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const r = scanForSecrets(src);
    expect(r.hasSecrets).toBe(true);
    expect(r.findings.some((f) => f.type === 'private_key_block')).toBe(true);
    expect(r.redacted).not.toContain('MIIEpAIBAAKCAQEA');
  });

  it('detects a high-entropy secret assignment', () => {
    const src = 'apiKey: "a1B2c3D4e5F6g7H8i9J0kLmNoPqR"';
    const r = scanForSecrets(src);
    expect(r.hasSecrets).toBe(true);
    expect(r.findings.some((f) => f.type === 'generic_secret_assignment')).toBe(true);
    expect(r.redacted).not.toContain('a1B2c3D4e5F6g7H8i9J0kLmNoPqR');
  });

  it('does NOT flag placeholder passwords', () => {
    const r = scanForSecrets('password = "changeme"');
    expect(r.hasSecrets).toBe(false);
  });

  it('does NOT flag env references', () => {
    const r = scanForSecrets('const token = process.env.API_TOKEN;');
    expect(r.hasSecrets).toBe(false);
  });

  it('leaves clean application code untouched', () => {
    const src = [
      'import { LeadInput } from "./lead.schema";',
      'export async function createLead(input: LeadInput) {',
      '  return sendLeadToCrm(input);',
      '}',
    ].join('\n');
    const r = scanForSecrets(src);
    expect(r.hasSecrets).toBe(false);
    expect(r.redacted).toBe(src);
  });

  it('reports 1-based line numbers', () => {
    const src = 'line one\nline two\nconst id = "AKIAIOSFODNN7EXAMPLE";';
    const r = scanForSecrets(src);
    expect(r.findings[0]?.line).toBe(3);
  });
});

describe('shannonEntropy', () => {
  it('is 0 for empty string and low for repetition', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1, 5);
  });
});
