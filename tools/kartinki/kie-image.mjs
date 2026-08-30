import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { basename, extname, resolve } from "node:path";

const BASE = "https://api.kie.ai";
const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";
const MODEL_TEXT = "gpt-image-2-text-to-image";
const MODEL_REFERENCE = "gpt-image-2-image-to-image";
const KEY_NAMES = ["KIE_API_KEY", "KIEAI_API_KEY", "KIE_AI_API_KEY", "KIE_KEY", "FACTORY_KIE_API_KEY"];
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const RUB_PER_CREDIT = 0.3916;

function fromEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
}

function findKey() {
  const fromFile = fromEnvFile(resolve(process.cwd(), ".env"));
  for (const name of KEY_NAMES) {
    const value = process.env[name] ?? fromFile[name];
    if (value !== undefined && value.length > 0 && value !== "CHANGEME") {
      return { name, value };
    }
  }
  throw new Error(
    `Ключ KIE не найден ни под одним из имён ${KEY_NAMES.join(", ")}. ` +
      "Смотрел переменные окружения и .env в корне проекта",
  );
}

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 || at + 1 >= process.argv.length ? fallback : process.argv[at + 1];
}

async function envelope(response, what) {
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
  }
  const body = await response.json();
  if (![0, 200].includes(body.code)) {
    throw new Error(`${what}: код ${body.code}, ${body.msg ?? "без пояснения"}`);
  }
  return body;
}

async function credits(auth) {
  try {
    const body = await envelope(await fetch(`${BASE}/api/v1/chat/credit`, { headers: auth }), "баланс");
    return typeof body.data === "number" ? body.data : null;
  } catch {
    return null;
  }
}

async function uploadReference(file, auth) {
  const mime = MIME[extname(file).toLowerCase()];
  if (mime === undefined) {
    throw new Error(`Референс ${file}: годятся ${Object.keys(MIME).join(", ")}`);
  }

  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      base64Data: `data:${mime};base64,${readFileSync(file).toString("base64")}`,
      uploadPath: "images/landos",
      fileName: basename(file),
    }),
    signal: AbortSignal.timeout(300_000),
  });

  const payload = await envelope(response, "файловый хост не принял референс");
  const data = payload.data ?? {};
  const url = data.downloadUrl ?? data.fileUrl ?? data.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Файловый хост принял референс, но ссылки в ответе нет");
  }
  return url;
}

async function main() {
  const prompt = arg("prompt");
  if (prompt === null) {
    throw new Error(
      "Нужен --prompt «текст». Ещё: --ref файл (можно несколько), --out файл.png, " +
        "--aspect 16:9, --resolution 1K|2K|4K",
    );
  }

  const secret = findKey();
  const auth = { Authorization: `Bearer ${secret.value}` };
  const aspectRatio = arg("aspect", "1:1");
  const resolution = arg("resolution", "1K");
  const out = resolve(process.cwd(), arg("out", "kartinka.png"));

  const references = [];
  for (let at = 0; at < process.argv.length; at += 1) {
    if (process.argv[at] === "--ref" && at + 1 < process.argv.length) {
      references.push(process.argv[at + 1]);
    }
  }

  const model = references.length === 0 ? MODEL_TEXT : MODEL_REFERENCE;
  const before = await credits(auth);
  console.log(`ключ: ${secret.name}, баланс: ${before ?? "не прочитан"}`);

  const inputUrls = [];
  for (const file of references) {
    const url = await uploadReference(resolve(process.cwd(), file), auth);
    console.log(`референс залит: ${file}`);
    inputUrls.push(url);
  }

  const started = Date.now();
  const created = await envelope(
    await fetch(`${BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: {
          prompt,
          aspect_ratio: aspectRatio,
          resolution,
          ...(inputUrls.length === 0 ? {} : { input_urls: inputUrls }),
        },
      }),
      signal: AbortSignal.timeout(300_000),
    }),
    "kie не принял задачу",
  );

  const taskId = created.data?.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error("kie ответил успехом, но taskId не вернул: приём задачи не подтверждён");
  }
  console.log(`задача ${taskId}: ${model}, ${aspectRatio}, ${resolution}`);

  let url = null;
  const deadline = Date.now() + 1_200_000;
  while (Date.now() < deadline) {
    await delay(5000);
    const body = await envelope(
      await fetch(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
        headers: auth,
        signal: AbortSignal.timeout(60_000),
      }),
      `задача ${taskId} не опрошена`,
    );
    const record = body.data ?? {};
    if (record.state === "fail") {
      throw new Error(`задача ${taskId} провалена: ${record.failMsg ?? "без пояснения"}`);
    }
    if (record.state === "success") {
      url = JSON.parse(record.resultJson).resultUrls[0];
      break;
    }
    console.log(`  ${record.state} ${Math.round((Date.now() - started) / 1000)}с`);
  }

  if (url === null) {
    throw new Error(`задача ${taskId} не завершилась за 20 минут: деньги за неё уже списаны`);
  }

  const image = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(300_000) })).arrayBuffer());
  writeFileSync(out, image);

  const after = await credits(auth);
  const spent = before === null || after === null ? null : before - after;
  console.log(`файл: ${out} (${image.length} байт, ${Math.round((Date.now() - started) / 1000)}с)`);
  console.log(
    spent === null
      ? "расход не замерен"
      : `расход: ${spent} кредитов ≈ ${(spent * RUB_PER_CREDIT).toFixed(2)} ₽`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
