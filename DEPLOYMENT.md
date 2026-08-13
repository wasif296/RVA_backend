# RVA Backend — Vercel deployment

Do not deploy until this checklist is complete. This API is a **persistent-looking Express app packaged as one Vercel Function**. Cold starts on the free tier add latency; the first request after idle is slow. That is expected, not a bug.

## Prerequisites

- Node.js 22+
- MongoDB Atlas (or any reachable MongoDB)
- Cloudinary account (production storage; Vercel disk is ephemeral)
- Upstash Redis (REST) — shared rate-limit store across serverless invocations
- Vercel project pointed at this repo

## Why Upstash Redis

Vercel is serverless. An in-memory `express-rate-limit` store resets on every cold start, which would silently disable login throttling. Production **must** use Upstash. If Redis is unreachable, the **login** limiter fails closed (rejects) rather than allowing unlimited password guesses.

## Build and start (local compiled server)

```bash
npm ci
npm run build
npm start
```

Local development still uses:

```bash
npm run dev   # tsx watch src/server.ts — never use this on Vercel
```

One-off index repair (run deliberately against production Mongo, not on boot):

```bash
npm run migrate:quiz-indexes
```

## Vercel project settings (dashboard)

The Express Application Preset expects a static folder named `build`. This API has none — it is one Node serverless function (`api/index.ts`). If the project was imported as Express, deployment fails with `No Output Directory named "build"`.

Change these under **Settings → General → Build & Development Settings**:

| Setting | What to do |
|---------|------------|
| **Framework Preset** | Keep **Other** (not Express, not Vite). |
| **Build Command** | Override **off**, or override to an empty string. Do **not** leave the dashboard running `npm run build`. vercel.json sets `"buildCommand": ""` so zero-config does not treat `package.json` `"build"` as a static site (that is what produced `No Output Directory named "public"`). |
| **Output Directory** | Override **off**, value empty. Do not set `public`, `build`, or `dist`. |
| **Install Command** | `npm ci` (or Override off; vercel.json also sets `npm ci`) |
| **Node.js Version** | `22.x` |

`vercel.json` declares `api/index.ts` as the Node function and rewrites every path (including `/api/*`) to it. `@vercel/node` compiles that file and its `src/` imports (including `src/shared` and `src/modules/uploads`). `includeFiles: "src/**"` also copies the source tree into the function bundle. `app.listen` is not used on this path.

Local `npm run build` still compiles `dist/` for `npm start`. Vercel does not run that script and does not use `dist/`.

## Environment variables (names only)

| Name | Description |
|------|-------------|
| `NODE_ENV` | Must be `production` on Vercel |
| `PORT` | Unused on Vercel (platform-assigned); default `4000` locally |
| `MONGODB_URI` | MongoDB connection string |
| `CORS_ORIGIN` | Comma-separated frontend origins; never `*` |
| `JWT_ACCESS_SECRET` | Access-token signing secret (min 32 chars) |
| `JWT_REFRESH_SECRET` | Refresh-token signing secret (min 32 chars) |
| `LOG_LEVEL` | Pino log level (e.g. `info`) |
| `STORAGE_DRIVER` | Must be `cloudinary` in production |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (required in production) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token (required in production) |
| `UPLOAD_DIR` | Local disk path only; unused when `STORAGE_DRIVER=cloudinary` |
| `PUBLIC_UPLOAD_BASE_URL` | Local public prefix (default `/uploads`) |
| `SEED_ADMIN_EMAIL` | Seed script only — not required at boot |
| `SEED_ADMIN_PASSWORD` | Seed script only — not required at boot |

Missing production variables fail at boot via the Zod env schema.

## Deploy order

1. Deploy **backend** to Vercel (CORS_ORIGIN can be a placeholder like `http://localhost:5173` for the first push).
2. Deploy **frontend** to Vercel with `VITE_API_BASE_URL` set to the backend origin (no trailing slash), e.g. `https://rva-backend.vercel.app`.
3. Update backend `CORS_ORIGIN` to the frontend origin (comma-separated if you also keep a preview URL). Redeploy or restart env so the allowlist takes effect.

Refresh cookies are `SameSite=None; Secure` in production so they work across those two domains. `SameSite=Strict` is kept in development behind the Vite proxy.

## After first deploy

- Run `npm run migrate:quiz-indexes` once against production Mongo if this database ever had the old `lessonId_1` / `courseId_1` indexes.
- Boot only **asserts** those indexes are gone; it will refuse to serve if they still exist.
