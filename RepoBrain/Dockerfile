# RepoBrain — local context engine. Self-contained image with the embedding model baked in.
FROM node:24-slim

# Build tools as a fallback for native deps (better-sqlite3 / onnxruntime-node usually
# resolve prebuilt binaries, but keep the toolchain to be safe). glibc base (not Alpine)
# because transformers.js pulls `sharp` which needs glibc.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Skip onnxruntime-node's CUDA execution-provider download; CPU binaries are bundled.
ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /app

# Manifests + sources (node_modules/dist excluded via .dockerignore → fresh install/build)
COPY package.json package-lock.json* tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples

RUN npm install --no-audit --no-fund
RUN npm run build

# Bake the local multilingual embedding model into the image so the container is
# fully offline after build (cache dir matches the CLI default: ~/.cache/repobrain/models).
RUN node -e "import('@repobrain/embeddings').then(async (m) => { const e = await m.createEmbedder({ cacheDir: '/root/.cache/repobrain/models' }); await e.embedQuery('warmup'); console.log('embedding model cached'); }).catch((err) => { console.error(err); process.exit(1); })"

ENTRYPOINT ["node", "/app/apps/cli/dist/cli.js"]
CMD ["--help"]
