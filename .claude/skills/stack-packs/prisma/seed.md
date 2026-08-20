# Prisma: безопасные seeds, patch- и sync-скрипты

> **OPTIONAL stack-pack** (часть пака `prisma`). Читай вместе с [SKILL.md](SKILL.md).

## Главный принцип

**Admin-edited данные защищены от overwrite по умолчанию.**

Если запись в БД могла быть изменена через админку — никогда не перезаписывай её содержимое
в скрипте без явной проверки. Критично для любых **admin-editable записей**: шаблонов, конфигов,
текстов, лимитов/порогов — всего, что владелец/оператор может отредактировать из интерфейса.
Скрипт, который вслепую перетрёт такую запись, молча откатит ручную настройку.

---

## Типы скриптов и их назначение

| Скрипт | Назначение | Когда использовать |
|--------|-----------|-------------------|
| `seed.ts` | Bootstrap — первоначальное наполнение пустой БД | Только при первом запуске на новой БД |
| `seed-incremental.ts` | Добавление новых записей без overwrite | Регистрация новых ключей, новых конфигов |
| `seed-*.ts` | Специализированные seed'ы по доменам | Домен-специфичные bootstrap-данные |
| `scripts/patches/` | One-off патчи для точечных изменений | Обновление конкретной записи в prod |
| `scripts/sync-*` | Mass sync с явным предупреждением | ТОЛЬКО если overwrite является целью |

---

## Runtime и регистрация

Запускай скрипты через раннер проекта, а не «сырым» интерпретатором на проде:

```bash
{{PKG_MANAGER}} run seed
{{PKG_MANAGER}} run seed:incremental
{{PKG_MANAGER}} run patch:2026-05-06-update-config
```

Все скрипты прописаны в `package.json`, чтобы запуск был единообразным и воспроизводимым:

```json
{
  "scripts": {
    "seed": "{{PKG_MANAGER}} prisma/seed.ts",
    "seed:incremental": "{{PKG_MANAGER}} prisma/seed-incremental.ts",
    "patch:2026-05-06-update-config": "{{PKG_MANAGER}} scripts/patches/2026-05-06-update-config.ts"
  }
}
```

---

## Защита admin-edited данных

### Паттерн безопасного upsert

`create` заполняет запись при первом появлении; `update` трогает **только** структурные/метаданные
(имя, набор переменных, флаги), но **не** поля-контента, которые могли быть изменены из админки.

```typescript
await prisma.settingRegistry.upsert({
  where: { key: 'report.template.default' },
  create: {
    key: 'report.template.default',
    content: DEFAULT_CONTENT,
    isActive: true,
  },
  update: {
    name: 'Default report template',
    variables: ['input', 'context'],
  },
});
```

### Паттерн «только если не существует»

```typescript
const existing = await prisma.contentTemplate.findUnique({
  where: { key: 'default' },
});

if (!existing) {
  await prisma.contentTemplate.create({
    data: {
      key: 'default',
      title: 'Default',
      defaultDurationMin: 15,
    },
  });
  console.log('Created: default');
} else {
  console.log('Skipped (already exists): default');
}
```

---

## One-off patch scripts

Для точечного изменения существующей записи — отдельный скрипт с защитами. Version-guard делает
его идемпотентным: повторный прогон видит уже поднятую версию и выходит, не перетирая данные.

```typescript
// scripts/patches/2026-05-06-update-config.ts

const NEW_CONTENT = `...новый текст...`;
const EXPECTED_VERSION = 2;

const patch = async () => {
  const prisma = new PrismaClient();

  try {
    const existing = await prisma.settingRegistry.findUnique({
      where: { key: 'report.template.default' },
    });

    if (!existing) {
      console.error('Record not found, skipping');
      return;
    }

    if (existing.version !== EXPECTED_VERSION) {
      console.log(`Version mismatch: expected ${EXPECTED_VERSION}, got ${existing.version}. Skipping.`);
      return;
    }

    await prisma.settingRegistry.update({
      where: { key: 'report.template.default' },
      data: {
        content: NEW_CONTENT,
        version: EXPECTED_VERSION + 1,
      },
    });

    console.log('Patch applied successfully');
  } finally {
    await prisma.$disconnect();
  }
};

patch().catch(console.error);
```

> Инстанс клиента бери из фабрики вашего проекта, если она есть (некоторые версии Prisma
> требуют сконфигурированный клиент вместо голого `new PrismaClient()`).

---

## Именование скриптов

| Тип | Шаблон | Пример |
|-----|--------|--------|
| Patch script | `YYYY-MM-DD-что-делает.ts` | `2026-05-06-update-config.ts` |
| Sync script | `sync-<domain>.ts` | `sync-content-templates.ts` |
| Seed domain | `seed-<domain>.ts` | `seed-content-templates.ts` |

**Важно:** если скрипт может перезаписать данные — называй его `sync-*`, не `seed-*`.
Название сигнализирует об опасности.

---

## seed.ts — только bootstrap

`prisma/seed.ts` считается bootstrap-only:
- запускается только на пустой БД;
- не должен содержать mass-sync-логику;
- не должен вызываться в production для обновления данных.

Нужно добавить новые записи к существующей БД — используй `seed-incremental.ts` или patch script.

---

## Чеклист перед написанием DB-writing скрипта

- [ ] Какой тип скрипта нужен? (bootstrap / incremental / one-off patch / sync)
- [ ] Admin-edited поля защищены от overwrite?
- [ ] Скрипт идемпотентен (повторный запуск не сломает данные)?
- [ ] Версионная защита есть (для patch scripts)?
- [ ] Скрипт добавлен в `package.json` scripts?
- [ ] Запуск через раннер проекта, а не «сырым» интерпретатором?
- [ ] Название отражает опасность (sync vs seed)?
