# Predik

A prediction market for cricket, football, crypto and politics. Users trade Yes/No
outcomes at a live price, hold positions, and settle at ₹10 a winning share. Every
account has an INR wallet with an append-only ledger behind it: a movement is a
transaction row, a ledger entry and the wallet total, written in one database
transaction.

Payments go through a provider abstraction with demo, sandbox and live modes. **Live
money is off** unless the operator satisfies a server-side activation gate — see
`docs/PRODUCTION-RUNBOOK.md` §8.

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4, shadcn/ui primitives, lucide icons |
| Data | PostgreSQL via Drizzle ORM (`pg`); no migration runner — an idempotent bootstrap instead |
| State | Zustand on the client, route handlers on the server |
| Auth | Phone number + one-time code, `httpOnly` session cookie |
| Payments | Provider adapters with signature-verified webhooks (Razorpay in sandbox/live) |
| Tests | Node's built-in test runner: a unit suite and a PostgreSQL E2E suite |

`shadcn` is pinned to exactly `4.19.0` because `app/globals.css` imports
`shadcn/tailwind.css`, which 4.21.0 dropped.

## Local setup

Needs **Node 22+** and **pnpm**.

```bash
pnpm install
cp .env.example .env        # then fill in the values
pnpm dev                    # http://localhost:3000
```

1. Set `DATABASE_URL` to a PostgreSQL database. Tables are created on first use, so an
   empty database is fine (`DATABASE_SCHEMA_BOOTSTRAP`, below).
2. Set `ADMIN_PHONES` to your own number for the admin screens. Unset means no admins.
3. Sign-in uses a one-time code. Development uses `424242` and shows it on screen; in
   production you must set `OTP_FIXED_CODE` (exactly 6 digits) or sign-in returns `503`
   rather than issuing a publicly known code.

## Environment variables

The full annotated list is `.env.example`. The ones that matter most:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Nothing renders without it. |
| `DATABASE_SCHEMA_BOOTSTRAP` | no | Defaults to `auto`: missing tables, indexes and triggers are created on first use. Set `off` after running `pnpm db:bootstrap` as the schema owner, for a runtime role without DDL rights. |
| `ADMIN_PHONES` | yes | Comma-separated digits. Unset means there are no admins. |
| `OTP_FIXED_CODE` | yes in production | Exactly 6 digits; a deployment secret the operator shares out. |
| `TRUSTED_ORIGINS` | behind a proxy | Origins allowed to make state-changing requests. Same-origin requests never need listing. |
| `PAYMENTS_MODE` | no | `demo` (default), `sandbox` or `live`. |
| `PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION` | non-money sites | Production refuses to move balances through a simulated provider unless this is `true`. |
| `PAYMENTS_*` | see `.env.example` | Provider keys, payout account and the live-money activation gate. |
| `RATE_LIMIT_<BUCKET>_LIMIT` / `_WINDOW_MS` | no | Override one limit, e.g. `RATE_LIMIT_OTP_REQUEST_PHONE_LIMIT=5`. |

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server. |
| `pnpm build`, `pnpm start` | Production build, then serve it on `$PORT`. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm test` | Unit suite, no database needed. |
| `pnpm test:db` | PostgreSQL E2E suite; the harness only touches a database whose name contains `test`. |
| `pnpm test:all` | Both suites. |
| `pnpm db:bootstrap` | Creates every table, index and trigger if missing. Idempotent and additive only; needs DDL rights. |
| `pnpm preflight` | Read-only launch gate over configuration, the database and the accounting invariants. Exits `1` on any FAIL. |

Health: `/api/health/live` is liveness (always `200`; use it as the platform health
check) and `/api/health` is readiness (`200` when the database answers and the core
schema exists, `503` otherwise). Both report booleans only.

## Deploy on Railway

1. **Add a database**: project → *New → Database → PostgreSQL*.
2. **Point the app at it**: on the app service,
   `DATABASE_URL=${{Postgres.DATABASE_URL}}` — reference the variable rather than
   pasting a URL, so it rotates with the service.
3. **Set the application variables**:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `ADMIN_PHONES` | your number, digits only |
   | `OTP_FIXED_CODE` | a 6-digit secret |
   | `PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION` | `true`, only while the site is a demo that takes no real money |
   | `TRUSTED_ORIGINS` | `https://<your-service>.up.railway.app` |

4. **Build and start**: Railway detects Next.js. Set *Settings → Deploy* to build
   `pnpm build`, start `pnpm start` and use `/api/health/live` as the healthcheck path.
   The tracked `railway.json` sets the start command and the healthcheck path as well,
   but config-as-code files are being retired in favour of Infrastructure as Code, so
   the dashboard is the source of truth.
5. **Create the schema**: `DATABASE_SCHEMA_BOOTSTRAP=auto` (the default) does it on the
   first request, so nothing extra is needed. To create it before traffic arrives, run
   `pnpm db:bootstrap` once against production, or set it as the **pre-deploy command**
   (`deploy.preDeployCommand: ["pnpm db:bootstrap"]` in `railway.json`). Either way it
   is idempotent and safe to repeat.
6. **Verify**: `/api/health` should answer `200` with `checks.database: "ok"`. A `503`
   with `database.configured: false` means `DATABASE_URL` is unset, and
   `checks.database: "schema-incomplete"` means the bootstrap is off or failed (the
   deploy logs say which). Once the tables exist, set
   `DATABASE_SCHEMA_BOOTSTRAP=off` and consider a least-privilege runtime role — see
   `docs/PRODUCTION-RUNBOOK.md` §4.

If a page instead shows "Predik is temporarily unavailable", it could not read the
database; `/api/health` says why. Every server start also writes a configuration report
to the deploy logs naming each missing variable (`instrumentation.ts` →
`lib/config/startup.ts`); it prints names only, never values.
