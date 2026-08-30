---
name: kie-image2-kontrakt
description: "Контракт вызова картинок gpt-image-2 у kie.ai — эндпоинты, две модели, замеренная цена и время."
metadata: 
  node_type: memory
  type: project
  originSessionId: 07a5eaaf-b987-4b26-a876-55d900a2a418
  modified: 2026-08-30T03:11:49.826Z
---

Картинки в проекте `vibe-seo` (`apps/image-lab/`) делаются через **kie.ai**, база `https://api.kie.ai`, авторизация `Bearer <KIE_API_KEY>`. Три эндпоинта: `POST /api/v1/jobs/createTask` → `GET /api/v1/jobs/recordInfo?taskId=…` (поллинг до `state: success`, ссылка внутри `resultJson.resultUrls[0]`) → баланс `GET /api/v1/chat/credit`.

Две модели: `gpt-image-2-text-to-image` (только `prompt`) и `gpt-image-2-image-to-image` (плюс `input_urls` — до 16 публичных ссылок на референсы). Локальный файл в публичную ссылку превращает `POST https://kieai.redpandaai.co/api/file-base64-upload` с тем же Bearer.

**Замер 2026-08-30 (моя проба, 1:1 / 1K):** обе модели прошли, ~60 с на картинку, **6 кредитов ≈ 2,3 ₽** за штуку при курсе 0,3916 ₽/кредит. Баланс на счёте был 1173,7 кредита.

**В проекте landos свой тонкий клиент** — `tools/kartinki/kie-image.mjs`, без зависимостей, сам выбирает модель по наличию `--ref` и сам заливает локальный референс. Описан в `second-brain/02_architecture/kartinki-cherez-kie.md`, прогнан обеими ветками 2026-08-30.

**Как применять:** не изобретать клиент заново — брать `apps/image-lab/src/kie/client.ts` за образец: там уже разобраны отказ вендора, тихий даунгрейд разрешения и случай «запрос ушёл, ответа нет» (задачу могли затарифицировать, вслепую повторять нельзя). Где взять ключ — [[kie-kluch-i-server-vibeceh]].
