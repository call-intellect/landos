# bilingual-app (fixture)

Synthetic bilingual repo: **English identifiers, Russian comments**, NestJS-ish.
Exists to regression-test RepoBrain's Russian→English retrieval at a scale where
graph-central hubs can bury semantically-relevant leaf services. Gold answers are
two leaf services (`crypto.service.ts`, `livekit.service.ts`) that must beat
central hubs (`logger`, `config`, `app.module`, `admin-livekit`).
