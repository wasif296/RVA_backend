# RVA Backend

API server for **RVA — Remote VA's Academy**.

> **Shared source of truth:** Types and constants under `src/shared/` live here first. Any change must be copied by hand into `RVA_frontend/src/shared/`.

## Prerequisites

- Node.js 22+
- MongoDB reachable at the URI you configure

## Setup

```bash
cp .env.example .env
# Edit .env with your values (never commit .env)
npm install
```

## Environment variables (names only)

| Name | Purpose |
|------|---------|
| `NODE_ENV` | Runtime environment |
| `PORT` | HTTP listen port (default `4000`) |
| `MONGODB_URI` | MongoDB connection string |
| `CORS_ORIGIN` | Allowed browser origin (frontend URL) |
| `JWT_ACCESS_SECRET` | Access token signing secret |
| `JWT_REFRESH_SECRET` | Refresh token signing secret |
| `LOG_LEVEL` | Pino log level |
| `SEED_ADMIN_EMAIL` | Optional seed admin email |
| `SEED_ADMIN_PASSWORD` | Optional seed admin password |

## Scripts

```bash
npm run dev        # watch mode (tsx)
npm run build      # compile to dist/
npm start          # run compiled server
npm run typecheck
npm test
npm run seed
```

## Dev workflow with the frontend

Start this API on **port 4000** before starting `RVA_frontend`. The Vite dev server proxies `/api` to `http://localhost:4000` so cookies stay same-origin in development.
# RVA_backend
# RVA_backend
