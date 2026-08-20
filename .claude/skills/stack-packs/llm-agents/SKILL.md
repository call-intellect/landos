---
name: llm-agent-conventions
description: Эталон инфраструктуры LLM-агентов и prompt management (provider-agnostic каркас): prompt registry с code-fallback и admin-editable без деплоя, обязательная асинхронность через очередь, трейсинг tokens/cost/latency, версионирование промптов _V2 для shadow-run, единая confidence-онтология. Используй при создании нового AI/LLM-агента, добавлении prompt key, изменении существующего промпта, настройке prompt registry, написании seed/patch для промптов, маршрутизации LLM-провайдеров, постановке AI-задачи в очередь. Обязателен если задача касается генерации/суммаризации/извлечения через LLM, prompt management или трейсинга AI-вызовов.
---

> **OPTIONAL stack-pack — включай для продукта с LLM** (любой агент/пайплайн поверх LLM: генерация, суммаризация, извлечение, классификация, диалог). Не активен по умолчанию. Это **SKELETON** — provider-agnostic каркас; конкретные провайдеры, ENV-имена, task-маршруты и prompt-ключи вычищены и помечены `<!-- FILL: ... -->`. Термины очереди/ORM/конфига отмечены как `{{STACK_TERMS}}` — подставь свои.

# {{PROJECT_NAME}}: правила LLM-агентов и prompt infrastructure

## Главное правило №0 — выбор LLM-канала

**Перед выбором модели/провайдера всегда сверяйся с verified-картой провайдеров** — единственным источником правды о том, какие LLM-вызовы реально работают в проекте (с датой последнего smoke-прогона). Держи её в `second-brain/` и обновляй после каждой переверификации.

Жёсткие ограничения проекта (фиксируются решением владельца — вписать свои):

```
<!-- FILL: your provider constraints — какие модели/провайдеры запрещены, чем заменены -->
- <провайдер X не используем ни primary, ни fallback, ни A/B — причина>
- Embeddings — только <модель> (dim=<N>); альтернативы не использовать
- Chat — только <модель>; тяжёлые/недоступные варианты не использовать
```

Детали по каждой задаче (taskType → primary → fallback chain) держи в плейбуке рядом с verified-картой. При расхождении плейбука с verified-картой — **приоритет у verified**.

Переверификация одной командой: держи smoke-скрипт, гоняющий все настроенные провайдеры, и запускай его перед сменой маршрута.

## Главное правило про prompt registry

Если промпт не является одноразовым локальным экспериментом — он **обязан**:
1. Быть доступен из БД (через prompt registry)
2. Редактироваться через админку без деплоя
3. Иметь кодовый fallback (на случай, если запись в БД отсутствует)
4. Иметь безопасный путь доставки в production без массового overwrite

Если продукт разветвляет генерацию по типу входа (тип встречи, тип документа, тип задачи) — **на каждый тип отдельный prompt-ключ**, не «один шаблон на всё». Разные типы эволюционируют независимо; общий шаблон превращается в набор `if`-ов внутри промпта и деградирует.

---

## AI pipeline (provider-agnostic)

```
<input source> → <storage>
                    ↓
        Queue job: process-<domain>
                    ↓
   Pre-processing (нормализация / подготовка входа)
                    ↓
   LLM через router-сервис:
     primary  — <ваш основной провайдер/модель>
     fallback — <fallback-цепочка>
                    ↓
   Шаблон по <тип задачи> → результат
                    ↓
   Хранилище результатов
```

<!-- FILL: your providers, pre-processing steps, task routes, result store -->

Провайдеры подключаются через ENV (switchable endpoints). Никаких хардкодов URL/ключей в коде агента.

---

## Prompt Registry

### Структура записи

```typescript
interface PromptRegistryEntry {
  key: string;
  name: string;
  description: string;
  content: string;
  variables: string[];
  version: number;
  isActive: boolean;
}
```

`content` — admin-editable; `variables` — переменные подстановки (например `['transcript', 'participants']`); `version` инкрементируется при каждом изменении.

### Naming convention для ключей

Формат: `<домен>.<этап>.<тип/цель>` (snake_case внутри сегментов).

```
<!-- FILL: your prompt keys -->
<domain>.report.<type_a>
<domain>.report.<type_b>
<domain>.extract.<goal>
<domain>.normalize.<goal>
```

Один ключ на каждый бизнес-тип генерации — так их можно редактировать и версионировать независимо.

### Code fallback

Каждый агент обязан иметь fallback прямо в коде — на случай отсутствия записи в БД:

```typescript
async getPrompt(key: string): Promise<string> {
  const dbPrompt = await this.promptRegistry.findByKey(key);
  if (dbPrompt?.isActive) return dbPrompt.content;
  return PROMPT_FALLBACKS[key] ?? throwMissingPromptError(key);
}

const PROMPT_FALLBACKS: Record<string, string> = {
  '<domain>.report.<type_a>': `
    <system role>
    Вход: {{input}}
    Контекст: {{context}}
    Задача: <что вернуть>.
  `,
};
```

---

## Создание нового AI-агента

### Шаги

1. **Создай worker** в директории воркеров (`{{STACK_TERMS}}`)
2. **Зарегистрируй job** в реестре AI-задач
3. **Добавь prompt key** в prompt registry (через patch script)
4. **Напиши fallback** в коде агента
5. **Зарегистрируй в baseline seed** (только если это core-агент)
6. **Добавь трейсинг** (input, output, tokens, cost, latency)

### Структура worker

Декораторы очереди/воркера стек-специфичны (`{{STACK_TERMS}}`) — суть в том, что worker берёт промпт из registry, рендерит, вызывает LLM через router и оборачивает вызов в трейс:

```typescript
export class ReportWorker {
  constructor(
    private readonly promptRegistry: PromptRegistryService,
    private readonly llm: LlmRouterService,
    private readonly aiTrace: AiTraceService,
  ) {}

  async process(job: Job<GenerateReportJobData>): Promise<void> {
    const promptKey = `<domain>.report.${job.data.type}`;
    const prompt = await this.promptRegistry.get(promptKey);
    const rendered = this.renderPrompt(prompt, job.data);

    const traceId = await this.aiTrace.start('generate-report', job.data);
    try {
      const result = await this.llm.complete(rendered);
      await this.aiTrace.complete(traceId, result);
    } catch (error) {
      await this.aiTrace.fail(traceId, error);
      throw error;
    }
  }
}
```

---

## Доставка промптов в production

### Baseline (bootstrap) регистрация

Регистрируй новые ключи через инкрементальный seed. Правила:
- Проверяй существование перед вставкой (`upsert`).
- **Не перезаписывай `content` при апдейте** — запись могла быть отредактирована в админке. В блоке `update` обновляй только служебные поля (`name`, `variables`), но не `content`.

```typescript
await prisma.promptRegistry.upsert({
  where: { key: '<domain>.report.<type_a>' },
  create: {
    key: '<domain>.report.<type_a>',
    name: '<human-readable name>',
    content: DEFAULT_CONTENT,
    variables: ['input', 'context'],
    isActive: true,
  },
  update: {
    name: '<human-readable name>',
    variables: ['input', 'context'],
  },
});
```

### One-off patch script

Для точечных изменений существующих промптов — отдельный patch script. Меняй только если текущая версия соответствует ожидаемой (защита от повторного/конкурентного применения):

```typescript
const patch = async () => {
  const existing = await prisma.promptRegistry.findUnique({
    where: { key: '<domain>.report.<type_a>' },
  });

  if (existing?.version !== 2) {
    console.log('Skipping: unexpected version');
    return;
  }

  await prisma.promptRegistry.update({
    where: { key: '<domain>.report.<type_a>' },
    data: { content: NEW_CONTENT, version: 3 },
  });
};
```

Запускай через штатный script-раннер проекта (`{{PKG_MANAGER}}`), а не разовым `npx`/`tsx` мимо конфига.

---

## Трейсинг AI

Каждый AI-вызов обязан трейситься — с токенами, стоимостью и латентностью:

```typescript
const traceId = await this.aiTrace.start(jobName, inputData);
try {
  const result = await this.llm.complete(prompt);
  await this.aiTrace.complete(traceId, {
    tokens: result.usage,
    output: result.content,
    cost: result.cost,
    latencyMs: result.latencyMs,
  });
} catch (error) {
  await this.aiTrace.fail(traceId, error);
  throw error;
}
```

Трейс нужен для: отладки качества промптов, мониторинга стоимости (по каждому провайдеру/этапу), анализа ошибок и refusal-rate.

---

## Асинхронность — обязательно

Никакого синхронного вызова LLM из HTTP-эндпоинта. Только через очередь (`{{STACK_TERMS}}`):

```typescript
await this.jobsQueue.add('process-<domain>', { entityId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
});
```

HTTP-хендлер возвращает `202 Accepted` + `jobId`. Клиент поллит статус или получает нотификацию. Синхронный `await this.llm.complete(...)` в цикле запроса держит соединение, ломает таймауты и роняет запрос при сбое провайдера.

---

## Switchable endpoints

ASR/LLM/embeddings-провайдеры подключены через ENV — переключение без кода. Все ENV-имена и дефолты держи в едином schema-файле конфига; в коде агента бери их только через типизированный config-сервис, никогда не хардкодь URL/ключи.

```
<!-- FILL: your provider ENV keys — endpoint URL, API key, default model per provider -->
<PROVIDER>_BASE_URL=...
<PROVIDER>_API_KEY=...
<PROVIDER>_DEFAULT_MODEL=...
```

Переключаемые endpoint'ы и креды внешних провайдеров остаются в ENV (это внешняя инфра). Всё остальное — выбор модели по taskType, пороги, лимиты — это крутилки: держи их в admin-config, не в ENV и не в коде.

---

## Версионирование code-fallback промптов

При **изменении существующей** `SYSTEM_PROMPT`-константы в code-fallback (до миграции в БД-registry):

- Создавай **новую константу** с суффиксом `_V2` (`_V3` и т.д.), не правь существующую.
- В прод не удаляй старую версию сразу — оставляй на 1–2 деплоя для shadow-run через resolver.
- Удаляй только когда есть подтверждение, что новая версия работает стабильнее по метрикам (latency / refusal-rate / judge-rubric).

Это даёт: историю изменений промптов прямо в git; A/B-сравнение через resolver shadow-run; безопасный rollback (revert последнего коммита возвращает указатель на старую версию).

**Не применяется** к промптам, уже мигрированным в БД-registry — там version history ведётся полями записи (`version`, `createdAt`, ссылка `previousVersionId`).

```typescript
export const TASKS_SYSTEM = `...`;

/**
 * @since <date>
 * @reason <что и зачем изменили>
 */
export const TASKS_SYSTEM_V2 = `...`;
```

Resolver выбирает версию по ENV-флагу или процентному split'у; метрика `prompt_version_used{key, version}` показывает реальный трафик.

---

## Confidence — единая онтология

Продукту нужна **одна** шкала уверенности across всех агентов, иначе UI и агрегации разъезжаются.

- **Новые промпты обязаны** возвращать `confidence: float ∈ [0, 1]` (continuous). Подмешивай в system-body единый текст калибровки шкалы через общий helper (`withConfidenceCalibration`).
- **Существующие enum-промпты** (`low`/`medium`/`high`) при риске регрессии и завязанном на enum UI **не мигрируй** — калибровку к ним не применяй (будет дубль и противоречие).
- **UI всегда отображает confidence через mapper** — единый scale 0–100% или одинаковые badge-цвета, даже если backend вернул enum.

Helper'ы держи в общем модуле промптов:

```typescript
export const CONFIDENCE_ENUM_TO_FLOAT = { low: 0.3, medium: 0.6, high: 0.85 } as const;
export type ConfidenceEnum = 'low' | 'medium' | 'high';
export function confidenceEnumToFloat(v: ConfidenceEnum): number;
export function confidenceFloatToEnum(v: number): ConfidenceEnum;
```

Точечная миграция enum→float — только когда конкретная бизнес-логика этого потребует (агрегация/среднее по значениям).

**Качественные шкалы** (severity / risk / fit и т.п.) — это **НЕ** confidence. Их якоря живут прямо в тексте промпта (по одному предложению на уровень, формат `- {уровень} — {критерий}`); калибровку confidence к ним не подмешивай.

---

## Чеклист нового AI-агента

- [ ] Worker в правильной директории
- [ ] Prompt key зарегистрирован (patch script или seed-incremental)
- [ ] Code fallback написан
- [ ] Upsert не перезаписывает admin-edited `content`
- [ ] Трейсинг подключён (tokens + cost + latency)
- [ ] Job добавлен через очередь, не синхронный вызов
- [ ] Retry/backoff настроен
- [ ] Идемпотентность проверена (повторный запуск не создаёт дубли результатов)
- [ ] Endpoints через ENV, fallback-цепочка настроена
- [ ] Новый промпт возвращает `confidence ∈ [0,1]` (или осознанно оставлен enum)
- [ ] `{{TYPECHECK_CMD}}` · `{{LINT_CMD}}` · `{{BUILD_CMD}}` · `{{TEST_CMD}}` — зелёные
