# AI Builder TypeScript Backend

This service mirrors the existing FastAPI app but is implemented with Express and TypeScript. It exposes the same endpoints and now bundles the background worker logic, so the WordPress plugin can create OpenAI-powered page builds without touching the Python codebase.

## Endpoints

- `POST /build` – accepts a JSON brief, enqueues it in `aib_jobs` with status `pending`, and returns `{ ok, request_id, status }`.
- `GET /result/:jobId` – returns the stored job status and result payload for polling.

## Setup

```bash
cd app-ts
npm install
```

Create a `.env` file if you need to override defaults:

```
AIB_SHARED_SECRET=replace_me_with_a_strong_token
DATABASE_URL=postgresql://aibuser:psql789@127.0.0.1/aibuilder
PORT=8000
OPENAI_API_KEY=sk-...
# Optional overrides:
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_MODEL=gpt-4.1-mini
WP_DB_HOST=127.0.0.1
WP_DB_USER=root
WP_DB_PASS=
WP_DB_NAME=goldiwaycom
```

> The defaults match the existing Python service, so configuration is optional if you keep the same database and secret.

## Run

```bash
npm run dev      # hot-reload with tsx (polling worker included)
npm run build    # emit compiled JS into dist/
npm start        # run compiled build
```

The process listens on `PORT` (default `8000`). A background loop continuously claims pending rows from `aib_jobs`, fetches `wood-*` pages from WordPress MySQL, rewrites text with OpenAI GPT, and writes the finished bundle back to PostgreSQL—mirroring the Python worker.
# aibreactbackend
