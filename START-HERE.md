# START HERE — с чего начать знакомство

Ты открыл универсальный шаблон «вайб-кодинга». Вот маршрут чтения — от «что это» к деталям.

## 1. Понять замысел (10 минут)
1. [README.md](README.md) — что это, как развернуть новый проект, что внутри.
   - [GUIDE.md](GUIDE.md) — **справочник по компонентам**: по каждому блоку «что это · что внутри · что менять · на что повлияет» (+ честная карта зрелости: что готово, что скелет).
2. [docs/TEMPLATE-DESIGN.md](docs/TEMPLATE-DESIGN.md) — **ПОЧЕМУ так устроено**: что взяли из индустрии, что отвергли (с доказательствами), наши дифференциаторы.

## 2. Увидеть доказательства (по желанию, глубоко)
3. [docs/research/README.md](docs/research/README.md) — индекс всей аналитики. Оттуда:
   - [external-synthesis.md](docs/research/external-synthesis.md) — топ-5 усилений + итоговая рекомендация (**самое ценное**).
   - [external-verdicts.md](docs/research/external-verdicts.md) — почему Spec Kit / BMAD / Memory Bank и др. отвергнуты.
   - [internal-devsetup-analysis.md](docs/research/internal-devsetup-analysis.md) — как из обвязки Коры получился generic-шаблон.

## 3. Понять правила, по которым будет работать агент
4. [CLAUDE.md](CLAUDE.md) — тонкое ядро правил проекта (12 разделов: общение, no-comments, Ship-On, конфиг, знание vs планы, цепочка планирования + gate, реестр не-сделанного, завершение/рефлексия, git, стек, тулинг).
5. [.claude/hooks/README.md](.claude/hooks/README.md) — хуки безопасности и энфорсмента (что подкреплено кодом, а не «просьбой»).
6. [.claude/skills/README.md](.claude/skills/README.md) — ростер скиллов (цепочка планирования + стек-паки).

## 4. Понять «второй мозг» и планирование
7. [second-brain/index.md](second-brain/index.md) → [second-brain/00_system/](second-brain/00_system/) — протокол знания (8 файлов: источник правды, структура, ссылки, bootstrap).
8. [plans/README.md](plans/README.md) — воронка анализ → архитектура (одобрение) → ТЗ → архив. Шаблоны: [analysis](plans/analysis/_template.md) · [architecture](plans/architecture/_template.md) · [tz](plans/tz/_template.md).

## 5. Понять операционку (деплой/стенды/аналитика)
9. [docs/operations/](docs/operations/) — деплой-лог (12 шагов), флаги, SSH-рунбук, [стенды](docs/operations/stands-and-preview-envs.md), [аналитика](docs/operations/analytics.md), [обработка ошибок](docs/operations/error-handling.md).

## 6. Персональная память агента
10. [memory/README.md](memory/README.md) — как агент копит уроки между сессиями (+ образцы).

---

## Как развернуть проект из этого шаблона (кратко)
1. «Use this template» на GitHub (или `npx degit`).
2. Замени плейсхолдеры `{{...}}` (список — в [README.md](README.md#настройка-заполнить-плейсхолдеры)).
3. Скажи Claude Code: «инициализируй проект по README» → он проведёт по настройке и, если код уже есть, запустит [BOOTSTRAP_FROM_CODE](second-brain/00_system/BOOTSTRAP_FROM_CODE.md).

## Что ещё в планах (дорожная карта)
`npx`-установщик (настоящая «кнопка») · монитор токенов/стоимости · механизм обновления шаблона в развёрнутых проектах. См. [README.md](README.md#дорожная-карта-шаблона).
