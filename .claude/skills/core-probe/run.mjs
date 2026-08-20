#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_CASES = 10;
const MAX_CASES = 20;
const BEGIN = '<!-- core-probe:begin -->';
const END = '<!-- core-probe:end -->';
const skillRoot = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(skillRoot, '..', '..', '..');

function loadYaml() {
  const bases = [
    path.join(kitRoot, 'RepoBrain', 'apps', 'cli', 'package.json'),
    path.join(kitRoot, 'RepoBrain', 'package.json'),
    path.join(kitRoot, 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const base of bases) {
    try {
      return createRequire(base)('yaml');
    } catch {
      continue;
    }
  }
  return { parse: parseCasesYaml };
}

const TOO_COMPLEX = 'поставь в проект модуль yaml (npm i yaml) и повтори — встроенный разбор такое не берёт';

function parseScalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (text.includes('\\')) throw new Error(`экранирование внутри кавычек: ${raw.trim()}; ${TOO_COMPLEX}`);
    const end = text.indexOf('"', 1);
    if (end < 0) throw new Error(`незакрытая кавычка: ${raw.trim()}`);
    return text.slice(1, end);
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end < 0) throw new Error(`незакрытая кавычка: ${raw.trim()}`);
    if (text.slice(end + 1).trim().startsWith("'")) {
      throw new Error(`удвоенная кавычка внутри значения: ${raw.trim()}; ${TOO_COMPLEX}`);
    }
    return text.slice(1, end);
  }
  const cut = text.search(/\s#/);
  const value = (cut >= 0 ? text.slice(0, cut) : text).trim();
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export function parseCasesYaml(text) {
  const out = {};
  let list = null;
  let item = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      list = null;
      item = null;
      if (top[2].trim() === '') {
        list = [];
        out[top[1]] = list;
      } else {
        out[top[1]] = parseScalar(top[2]);
      }
      continue;
    }
    const bullet = line.match(/^\s+-\s*(.*)$/);
    if (bullet && list) {
      item = {};
      list.push(item);
      const pair = bullet[1].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (pair) item[pair[1]] = parseScalar(pair[2]);
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (nested && item) {
      item[nested[1]] = parseScalar(nested[2]);
      continue;
    }
    throw new Error(
      `строка «${line.trim()}» сложнее, чем понимает встроенный разбор cases.yaml; ` +
        'поставь в проект модуль yaml (npm i yaml) и повтори',
    );
  }
  return out;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function slugOf(dir) {
  const base = path.basename(dir);
  const cut = base.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/^proba-yadra-/, '');
  return cut.length ? cut : base;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function shorten(value, limit) {
  const text = escapeCell(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function parseSpend(stdout) {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.tokens === 'number' && Number.isFinite(parsed.tokens)) {
        return { tokens: parsed.tokens, usd: null };
      }
      if (typeof parsed.usd === 'number' && Number.isFinite(parsed.usd)) {
        return { tokens: null, usd: parsed.usd };
      }
    } catch {
      continue;
    }
  }
  return { tokens: null, usd: null };
}

function readJudgements(text) {
  const kept = new Map();
  const block = text.split(BEGIN)[1];
  if (!block) return kept;
  for (const line of block.split(END)[0].split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 7) continue;
    const id = cells[1];
    if (!/^\d+$/.test(id)) continue;
    kept.set(id, { verdict: cells[4] ?? '', why: cells[5] ?? '' });
  }
  return kept;
}

function skeleton({ slug, dir, judge, criterionPath }) {
  const date = new Date().toISOString().slice(0, 10);
  return [
    '---',
    'type: core-probe',
    'status: measured',
    `feature: ${slug}`,
    `date: ${date}`,
    `judge: ${judge}`,
    `criterion: ${criterionPath}`,
    `command: node .claude/skills/core-probe/run.mjs --dir ${dir}`,
    '---',
    '',
    '## Критерий «годно» (записан до прогона)',
    '',
    `Дословная формулировка и коммит, в котором она записана: ${criterionPath}`,
    '',
    BEGIN,
    END,
    '',
    '## Что делает продукт, когда модель не смогла',
    '',
    '',
    '## Вердикт:',
    '',
  ].join('\n');
}

function renderBlock(rows, numbers) {
  const lines = [BEGIN, '## Прогоны', '', '| # | вход | результат | годно | почему |', '|---|---|---|---|---|'];
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.input} | ${row.artifact} | ${row.verdict} | ${row.why} |`);
  }
  lines.push('', '## Три числа', '');
  lines.push(`- доля годных: ${numbers.good} из ${numbers.total}`);
  lines.push(`- секунды на результат (медиана): ${numbers.seconds}`);
  lines.push(`- деньги на результат: ${numbers.money}`);
  lines.push(END);
  return lines.join('\n');
}

function writeResult(file, block, meta) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : skeleton(meta);
  const hasBegin = existing.includes(BEGIN);
  const hasEnd = existing.includes(END);
  if (hasBegin !== hasEnd) {
    fail(`в ${path.relative(process.cwd(), file)} повреждены маркеры блока: нужны оба — ${BEGIN} и ${END}`);
  }
  if (!hasBegin) {
    writeFileSync(file, `${existing.replace(/\s*$/, '')}\n\n${block}\n`, 'utf8');
    process.stdout.write('в result.md не было маркеров блока — таблица дописана в конец файла\n');
    return;
  }
  const head = existing.split(BEGIN)[0];
  const tail = existing.split(END).slice(1).join(END);
  writeFileSync(file, `${head}${block}${tail}`, 'utf8');
}

function moneyLine(unit, values) {
  const measured = values.filter((v) => Number.isFinite(v));
  if (!measured.length) {
    return 'не измерено (команда не печатает хвостовой JSON {"tokens":N} или {"usd":X})';
  }
  const value = median(measured);
  return unit === 'usd' ? `${Number(value.toFixed(4))} USD` : `${Math.round(value)} токенов`;
}

function main() {
  const dirArg = argValue('--dir');
  if (!dirArg) fail('нужен аргумент --dir <каталог пробы>');

  const dir = path.resolve(process.cwd(), dirArg);
  const casesFile = path.join(dir, 'cases.yaml');
  if (!existsSync(casesFile)) fail(`нет ${path.relative(process.cwd(), casesFile)} — входы и команда берутся оттуда`);

  let spec = {};
  try {
    spec = loadYaml().parse(readFileSync(casesFile, 'utf8')) ?? {};
  } catch (e) {
    fail(`cases.yaml не разобран: ${e.message}`);
  }
  const cases = Array.isArray(spec.cases) ? spec.cases : [];
  if (cases.length < MIN_CASES) {
    fail(`проба не состоялась: входов ${cases.length}, нужно ≥ ${MIN_CASES}`);
  }
  if (cases.length > MAX_CASES) {
    process.stdout.write(`входов ${cases.length}, процедура рассчитана на ${MIN_CASES}–${MAX_CASES}\n`);
  }
  if (typeof spec.command !== 'string' || !spec.command.includes('{{input}}')) {
    fail('в cases.yaml нет поля command с подстановкой {{input}}');
  }
  const badIndex = cases.findIndex((item) => !/^\d+$/.test(String(item?.id ?? '')));
  if (badIndex >= 0) {
    fail(
      `в cases.yaml у входа №${badIndex + 1} негодный id «${cases[badIndex]?.id}» — ` +
        'id должен быть целым числом: по нему сохраняются отметки «годно» между прогонами',
    );
  }

  const slug = slugOf(dir);
  const judge = spec.judge === 'human' ? 'human' : 'rubric';
  const unit = spec.unit === 'usd' ? 'usd' : 'tokens';
  const timeoutMs = (Number(spec.timeout_sec) > 0 ? Number(spec.timeout_sec) : 600) * 1000;
  mkdirSync(path.join(process.cwd(), 'artifacts', 'core-probe', slug), { recursive: true });

  const resultFile = path.join(dir, 'result.md');
  const kept = existsSync(resultFile) ? readJudgements(readFileSync(resultFile, 'utf8')) : new Map();

  const rows = [];
  const durations = [];
  const spends = [];
  let failures = 0;

  for (const item of cases) {
    const id = String(item.id);
    const input = String(item?.input ?? '');
    const artifactRel = path.join('artifacts', 'core-probe', slug, `${id.padStart(3, '0')}.txt`);
    const command = spec.command.split('{{input}}').join(shellQuote(input));
    const started = Date.now();
    const r = spawnSync(command, {
      shell: true,
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const elapsed = Date.now() - started;
    const stdout = r.stdout ?? '';
    const previous = kept.get(id) ?? { verdict: '', why: '' };

    if (r.status !== 0 || r.error) {
      failures += 1;
      const reason = r.error ? r.error.message : `команда завершилась кодом ${r.status}`;
      writeFileSync(path.join(process.cwd(), artifactRel), `${stdout}\n${r.stderr ?? ''}`, 'utf8');
      rows.push({
        id,
        input: shorten(input, 40),
        artifact: artifactRel,
        verdict: 'нет',
        why: escapeCell(`${reason}: ${(r.stderr ?? '').trim().slice(-120)}`),
      });
      continue;
    }

    writeFileSync(path.join(process.cwd(), artifactRel), stdout, 'utf8');
    durations.push(elapsed);
    const spend = parseSpend(stdout);
    spends.push(unit === 'usd' ? spend.usd : spend.tokens);
    rows.push({
      id,
      input: shorten(input, 40),
      artifact: artifactRel,
      verdict: previous.verdict === 'да' || previous.verdict === 'нет' ? previous.verdict : '',
      why: previous.why,
    });
  }

  const good = rows.filter((row) => row.verdict === 'да').length;
  const unjudged = rows.filter((row) => row.verdict !== 'да' && row.verdict !== 'нет').length;
  const secondsMedian = median(durations);
  const numbers = {
    good,
    total: rows.length,
    seconds: secondsMedian === null ? '0.0' : (secondsMedian / 1000).toFixed(secondsMedian < 1000 ? 2 : 1),
    money: moneyLine(unit, spends),
  };

  writeResult(resultFile, renderBlock(rows, numbers), {
    slug,
    dir: path.relative(process.cwd(), dir),
    judge,
    criterionPath: path.join(path.relative(process.cwd(), dir), 'criterion.md'),
  });

  process.stdout.write(`проба ${slug}: прогонов ${rows.length}, упавших команд ${failures}\n`);
  process.stdout.write(
    `три числа: годных ${good} из ${rows.length} · секунды ${numbers.seconds} · деньги ${numbers.money}\n`,
  );
  if (unjudged) {
    const who = judge === 'human' ? 'владелец глазами' : 'агент по criterion.md';
    process.stdout.write(`не отсуждено строк: ${unjudged} — колонку «годно» заполняет ${who}\n`);
  }
  process.stdout.write('заполнить руками: раздел «Что делает продукт, когда модель не смогла» и строку «## Вердикт:»\n');
  process.stdout.write(`${path.relative(process.cwd(), resultFile)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
