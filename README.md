# RVA Backend

API server for **RVA — Remote VA's Academy**.

> **Shared source of truth:** Types and constants under `src/shared/` live here first. Any change must be copied by hand into `RVA_frontend/src/shared/`.

Production deploy target: **Vercel**. See [DEPLOYMENT.md](./DEPLOYMENT.md).

## Prerequisites

- Node.js 22+
- MongoDB reachable at the URI you configure

## Setup

```bash
cp .env.example .env
# Edit .env with your values (never commit .env)
npm install
```

## Scripts

```bash
npm run dev                  # watch mode (tsx) — local only
npm run build                # compile to dist/
npm start                    # run compiled server (dist/server.js)
npm run typecheck
npm test
npm run seed
npm run migrate:quiz-indexes # deliberate Quiz index repair — not run on boot
```

## Production (Vercel)

| | |
|---|---|
| **Framework preset** | Other (not Express) |
| **Vercel build command** | empty (`""`) — do not run `npm run build` on Vercel |
| **Output directory** | empty — no static `public/` or `build/` folder |
| **Vercel entry** | Function `api/index.ts` (compiles `src/` directly; no `app.listen`) |
| **Local start** | `npm start` after `npm run build` |

Required environment variables (names only):

| Name | Purpose |
|------|---------|
| `NODE_ENV` | Runtime environment |
| `PORT` | HTTP listen port locally (default `4000`; unused on Vercel) |
| `MONGODB_URI` | MongoDB connection string |
| `CORS_ORIGIN` | Comma-separated frontend origins; never `*` |
| `JWT_ACCESS_SECRET` | Access token signing secret |
| `JWT_REFRESH_SECRET` | Refresh token signing secret |
| `LOG_LEVEL` | Pino log level |
| `STORAGE_DRIVER` | `cloudinary` in production |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (production rate limits) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `UPLOAD_DIR` | Local disk path (dev) |
| `PUBLIC_UPLOAD_BASE_URL` | Local public upload prefix |
| `SEED_ADMIN_EMAIL` | Optional seed admin email |
| `SEED_ADMIN_PASSWORD` | Optional seed admin password |

Deploy order: backend first → frontend with `VITE_API_BASE_URL` → update backend `CORS_ORIGIN`. Full steps in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Dev workflow with the frontend

Start this API on **port 4000** before starting `RVA_frontend`. The Vite dev server proxies `/api` to `http://localhost:4000` so cookies stay same-origin in development.
