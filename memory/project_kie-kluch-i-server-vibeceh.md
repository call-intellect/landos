---
name: kie-kluch-i-server-vibeceh
description: Где на сервере 46.8.196.29 реально лежит ключ KIE_API_KEY и почему в домашнем .env лежит заглушка.
metadata: 
  node_type: memory
  type: project
  originSessionId: 07a5eaaf-b987-4b26-a876-55d900a2a418
  modified: 2026-08-30T03:11:38.943Z
---

Сервер `46.8.196.29` — в `~/.ssh/config` как хост `vibeceh-prod` (user `user`, ключ `~/.ssh/vibeceh_prod`), у пользователя есть `sudo` без пароля.

Рабочий ключ KIE — только в `/home/docker/statejnik/apps/stateinik-engine/.env` под именем `KIE_API_KEY` (32 символа), читается через `sudo`. В `/home/user/.env` лежит `KIE_API_KEY=CHANGEME` — заглушка, на неё нельзя опираться; проект `statejnik` на сервере целиком под root.

**Почему важно:** первый же очевидный путь (домашний `.env`) даёт заглушку молча — вызов упадёт не на «нет ключа», а на отказе вендора, и причину искать долго.

**Как применять:** брать ключ из `statejnik/apps/stateinik-engine/.env` через `sudo`, значение в чат не печатать. Код-образец вызова — `apps/image-lab/` в репозитории `call-intellect/vibe-seo`, см. [[kie-image2-kontrakt]].
