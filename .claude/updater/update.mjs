#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  mkdtempSync,
} from 'node:fs';
import { join, resolve, relative, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const DEFAULT_STORE = 'https://vibe-os.ru';
const SHELVES = ['theirs_never_touch', 'merge_required', 'ours_replaceable'];
const EMPTY_BASE = '/dev/null';

export function semverCompare(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function globToRegex(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      while (glob[i + 1] === '*') i++;
      re += '.*';
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

export function compilePolicy(policy) {
  const compiled = {};
  for (const shelf of SHELVES) {
    compiled[shelf] = (policy[shelf] || []).map(globToRegex);
  }
  return compiled;
}

function classifyCompiled(compiled, path) {
  for (const shelf of SHELVES) {
    if (compiled[shelf].some((r) => r.test(path))) return shelf;
  }
  return 'merge_required';
}

export function classify(path, policy) {
  return classifyCompiled(compilePolicy(policy), path);
}

export function parsePolicyYaml(yaml) {
  const policy = { ours_replaceable: [], merge_required: [], theirs_never_touch: [] };
  const lines = yaml.split(/\r?\n/);
  let inBlock = false;
  let shelf = null;
  for (const line of lines) {
    if (!inBlock) {
      if (/^update_policy:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const shelfMatch = line.match(/^\s+([A-Za-z_]+):\s*$/);
    if (shelfMatch) {
      shelf = shelfMatch[1];
      if (!policy[shelf]) policy[shelf] = [];
      continue;
    }
    const itemMatch = line.match(/^\s+-\s*["']?([^"'\n]+?)["']?\s*$/);
    if (itemMatch && shelf) policy[shelf].push(itemMatch[1].trim());
  }
  return policy;
}

function walkFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function mergeFile(oursPath, basePath, theirsPath) {
  try {
    const stdout = execFileSync(
      'git',
      ['merge-file', '-p', '-q', oursPath, basePath, theirsPath],
      { maxBuffer: 128 * 1024 * 1024 },
    );
    return { status: 0, stdout };
  } catch (e) {
    return { status: typeof e.status === 'number' ? e.status : -1, stdout: e.stdout ?? Buffer.alloc(0) };
  }
}

export function applyUpdate(root, baseDir, newDir, policy) {
  const compiled = compilePolicy(policy);
  const result = { replaced: [], merged: [], kept_yours: [], added: [], deleted: [], skipped: [] };

  for (const rel of walkFiles(newDir)) {
    const shelf = classifyCompiled(compiled, rel);
    if (shelf === 'theirs_never_touch') continue;

    try {
      const theirsPath = join(newDir, rel);
      const oursPath = join(root, rel);
      const basePath = join(baseDir, rel);

      if (!existsSync(oursPath)) {
        mkdirSync(dirname(oursPath), { recursive: true });
        copyFileSync(theirsPath, oursPath);
        result.added.push(rel);
        continue;
      }

      const oursBuf = readFileSync(oursPath);
      const theirsBuf = readFileSync(theirsPath);
      if (oursBuf.equals(theirsBuf)) continue;

      const baseExists = existsSync(basePath);
      if (baseExists && readFileSync(basePath).equals(oursBuf)) {
        copyFileSync(theirsPath, oursPath);
        result.replaced.push(rel);
        continue;
      }

      const { status, stdout } = mergeFile(oursPath, baseExists ? basePath : EMPTY_BASE, theirsPath);
      if (status === 0) {
        writeFileSync(oursPath, stdout);
        result.merged.push(rel);
      } else {
        result.kept_yours.push(rel);
      }
    } catch {
      result.skipped.push(rel);
    }
  }

  for (const rel of walkFiles(baseDir)) {
    if (existsSync(join(newDir, rel))) continue;
    if (classifyCompiled(compiled, rel) !== 'ours_replaceable') continue;
    const oursPath = join(root, rel);
    if (!existsSync(oursPath)) continue;
    try {
      if (readFileSync(oursPath).equals(readFileSync(join(baseDir, rel)))) {
        rmSync(oursPath);
        result.deleted.push(rel);
      }
    } catch {
      result.skipped.push(rel);
    }
  }

  return result;
}

const SETTING_KEY = /^\s*"([^"]+)"\s*:/;

function settingLines(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(SETTING_KEY);
    if (match && !out.has(match[1])) out.set(match[1], line.trim().replace(/,$/, ''));
  }
  return out;
}

export function previewResurrect(root, baseDir, newDir, policy) {
  const compiled = compilePolicy(policy);
  const out = [];
  for (const rel of walkFiles(newDir)) {
    if (classifyCompiled(compiled, rel) !== 'merge_required') continue;
    const oursPath = join(root, rel);
    if (!existsSync(oursPath)) continue;
    const ours = settingLines(oursPath);
    const base = settingLines(join(baseDir, rel));
    const theirs = settingLines(join(newDir, rel));
    for (const [key, line] of theirs) {
      if (!base.has(key) || ours.has(key)) continue;
      out.push({ file: rel, key, yours: null, theirs: line });
    }
  }
  return out;
}

function dropResurrected(root, entries, log) {
  const byFile = new Map();
  for (const entry of entries) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, new Set());
    byFile.get(entry.file).add(entry.key);
  }
  for (const [rel, keys] of byFile) {
    const target = join(root, rel);
    if (!existsSync(target)) continue;
    const before = readFileSync(target, 'utf8');
    const after = before
      .split('\n')
      .filter((line) => {
        const match = line.match(SETTING_KEY);
        return !(match && keys.has(match[1]));
      })
      .join('\n');
    if (after === before) continue;
    if (rel.endsWith('.json')) {
      try {
        JSON.parse(after);
      } catch {
        log(`Не смог убрать вернувшееся решение из ${rel}, оставил как есть — проверь файл сам.`);
        continue;
      }
    }
    writeFileSync(target, after);
    log(`Оставил твоё: убрал вернувшееся решение из ${rel} (${[...keys].join(', ')}).`);
  }
}

function readInstalledVersion(root) {
  const path = join(root, 'kit.manifest.yaml');
  if (!existsSync(path)) {
    throw new Error(`Не найден ${path}. Это не установка кита VibeOS или установка повреждена — не могу определить версию.`);
  }
  const match = readFileSync(path, 'utf8').match(/^kit_version:\s*["']?([^"'\n]+)/m);
  if (!match) {
    throw new Error(`В ${path} нет поля kit_version — установка повреждена. Не буду гадать версию.`);
  }
  return match[1].trim();
}

function normalizePolicy(p) {
  return {
    ours_replaceable: p.ours_replaceable || [],
    merge_required: p.merge_required || [],
    theirs_never_touch: p.theirs_never_touch || [],
  };
}

function readPolicyFromNew(newDir) {
  const jsonPath = join(newDir, 'kit.manifest.json');
  if (existsSync(jsonPath)) {
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (parsed && parsed.update_policy) return normalizePolicy(parsed.update_policy);
  }
  const yamlPath = join(newDir, 'kit.manifest.yaml');
  if (existsSync(yamlPath)) return parsePolicyYaml(readFileSync(yamlPath, 'utf8'));
  throw new Error('В новой версии нет kit.manifest.json или kit.manifest.yaml — не могу прочитать политику обновления.');
}

function bumpInstalledVersion(root, to) {
  const path = join(root, 'kit.manifest.yaml');
  if (!existsSync(path)) return;
  const txt = readFileSync(path, 'utf8');
  if (!/^kit_version:/m.test(txt)) return;
  writeFileSync(path, txt.replace(/^kit_version:\s*["']?[^"'\n]*["']?/m, `kit_version: "${to}"`));
}

function promptStdin(question) {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer);
    });
  });
}

function protectVibeos(root) {
  const dir = join(root, '.vibeos');
  mkdirSync(dir, { recursive: true });
  const localIgnore = join(dir, '.gitignore');
  if (!existsSync(localIgnore)) writeFileSync(localIgnore, '*\n');
}

async function ensureKey(root, log) {
  const keyPath = join(root, '.vibeos', 'license-key');
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, 'utf8').trim();
    if (existing) return existing;
  }
  protectVibeos(root);
  log('Лицензионный ключ не найден. Введи ключ один раз — сохраню локально в .vibeos/license-key.');
  const answer = (await promptStdin('Лицензионный ключ VibeOS: ')).trim();
  if (!answer) throw new Error('Ключ не введён — обновление невозможно.');
  writeFileSync(keyPath, answer + '\n', { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {}
  return answer;
}

function isGitRepo(root) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function copyTree(srcRoot, destRoot) {
  const excluded = (rel) => {
    const parts = rel.split(sep);
    if (parts.includes('node_modules')) return true;
    if (parts.includes('.git')) return true;
    if (rel.split(sep).join('/').startsWith('.vibeos/backup-')) return true;
    return false;
  };
  const recurse = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(srcRoot, full);
      if (excluded(rel)) continue;
      const dest = join(destRoot, rel);
      if (entry.isSymbolicLink()) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(full, dest);
      } else if (entry.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        recurse(full);
      } else if (entry.isFile()) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(full, dest);
      }
    }
  };
  mkdirSync(destRoot, { recursive: true });
  recurse(srcRoot);
}

function makeCheckpoint(root, from, to, log) {
  if (isGitRepo(root)) {
    execFileSync('git', ['add', '-A'], { cwd: root });
    let staged = true;
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: root });
      staged = false;
    } catch {
      staged = true;
    }
    if (staged) {
      execFileSync('git', ['commit', '-m', `checkpoint before kit update ${from}→${to}`], { cwd: root, stdio: 'pipe' });
      log('Чекпоинт: коммит текущего состояния (git).');
    } else {
      log('Чекпоинт: рабочее дерево чистое, откат возможен на последний коммит (git).');
    }
    return 'git';
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(root, '.vibeos', `backup-${ts}`);
  copyTree(root, backupDir);
  log(`Чекпоинт: резервная копия дерева в ${backupDir}.`);
  return `backup:${backupDir}`;
}

async function getLatest(store) {
  const res = await fetch(`${store}/api/kit/latest`);
  if (!res.ok) throw new Error(`GET ${store}/api/kit/latest → HTTP ${res.status}`);
  return res.json();
}

async function requestDownload(store, key, version) {
  const res = await fetch(`${store}/api/kit/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, version }),
  });
  if (!res.ok) throw new Error(`POST ${store}/api/kit/update (версия ${version}) → HTTP ${res.status}`);
  return res.json();
}

async function downloadVerified(store, downloadUrl, destPath, expectedSha) {
  const res = await fetch(`${store}${downloadUrl}`);
  if (!res.ok) throw new Error(`GET ${store}${downloadUrl} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (!expectedSha) {
    throw new Error('Магазин не вернул контрольную сумму — не применяю непроверенный архив. Обновление прервано.');
  }
  if (sha !== expectedSha) {
    throw new Error(`Контрольная сумма архива не совпала (ожидалось ${expectedSha}, получено ${sha}). Обновление прервано, ничего не изменено.`);
  }
  writeFileSync(destPath, buf);
}

async function fetchAndUnpack(store, key, version, destDir, work, tag, log) {
  log(`Скачиваю кит версии ${version}…`);
  const meta = await requestDownload(store, key, version);
  if (!meta.download_url) throw new Error(`Магазин не дал ссылку на скачивание версии ${version}.`);
  const tarPath = join(work, `kit-${tag}.tar.gz`);
  await downloadVerified(store, meta.download_url, tarPath, meta.sha256);
  mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarPath, '-C', destDir]);
}

async function main() {
  const root = resolve(process.argv[2] || process.cwd());
  const store = process.env.VIBEOS_STORE_URL || DEFAULT_STORE;
  const log = (m) => process.stderr.write(m + '\n');

  const from = readInstalledVersion(root);
  log(`Установленная версия кита: ${from}.`);

  const latest = await getLatest(store);
  const to = latest && latest.version;
  if (!to) throw new Error('Магазин не вернул номер последней версии.');

  if (semverCompare(to, from) <= 0) {
    process.stdout.write(JSON.stringify({ status: 'up_to_date', from, to }) + '\n');
    log(`Уже установлена последняя версия (${from}). Обновление не требуется.`);
    return;
  }
  log(`Доступна новая версия: ${to}. Обновляю ${from} → ${to}.`);

  protectVibeos(root);
  const key = await ensureKey(root, log);
  const checkpoint = makeCheckpoint(root, from, to, log);

  const work = mkdtempSync(join(tmpdir(), 'vibeos-update-'));
  try {
    const baseDir = join(work, 'base');
    const newDir = join(work, 'new');
    await fetchAndUnpack(store, key, from, baseDir, work, 'base', log);
    await fetchAndUnpack(store, key, to, newDir, work, 'new', log);

    const policy = readPolicyFromNew(newDir);

    const wanted = previewResurrect(root, baseDir, newDir, policy);
    let keepMine = true;
    if (wanted.length) {
      log('');
      log('Эти решения кит хочет вернуть:');
      for (const item of wanted) log(`  ${item.file} · ${item.theirs} — у тебя снято`);
      if (process.stdin.isTTY) {
        const answer = (await promptStdin('Вернуть их? (да / нет — оставить своё) [нет]: ')).trim().toLowerCase();
        keepMine = !['да', 'yes', 'y', 'д'].includes(answer);
      } else {
        log('Запуск неинтерактивный — оставляю твоё; вернуть можно вручную.');
      }
    }

    const applied = applyUpdate(root, baseDir, newDir, policy);
    if (wanted.length && keepMine) dropResurrected(root, wanted, log);
    bumpInstalledVersion(root, to);

    process.stdout.write(JSON.stringify({ from, to, ...applied, checkpoint }) + '\n');
    log(
      `Готово: заменено ${applied.replaced.length}, слито ${applied.merged.length}, ` +
        `оставлено твоих ${applied.kept_yours.length}, добавлено ${applied.added.length}, ` +
        `удалено ${applied.deleted.length}, пропущено ${applied.skipped.length}.`,
    );
    if (applied.kept_yours.length) {
      log(`Твои правки сохранены (были расхождения) в: ${applied.kept_yours.join(', ')}`);
    }
    if (applied.skipped.length) {
      log(`Не смог обработать (оставил как есть): ${applied.skipped.join(', ')}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + '\n');
    process.exit(1);
  });
}
