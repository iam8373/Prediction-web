# Predik — Production Runbook (Phase 11)

Everything an operator needs to deploy Predik, verify it, back it up, recover it and
roll it back. Written against the code as it exists: no step here asks you to change
architecture, and every command is one that was actually run while preparing this
document (see `docs/PHASE-11-LAUNCH-REPORT.md` for the evidence).

Live money is **off by default** and can only be turned on by satisfying the
server-side activation gate described in §8. Nothing in this runbook enables it for
you.

---

## 1. Launch gate: run this first

```bash
pnpm preflight            # human readable
pnpm preflight -- --json  # machine readable (CI)
```

`pnpm preflight` resolves the payment posture from the environment it runs in,
inspects the real database and sweeps the accounting invariants. It is **read only**
— with `DATABASE_SCHEMA_BOOTSTRAP=off` (the recommended production setting) it cannot
create, update or delete anything — and it never prints a secret value, only the
*names* of unset variables.

Exit codes: `0` when nothing failed, `1` when any check returned FAIL.

| Result | Meaning |
|---|---|
| `PASS` | Verified against this environment. |
| `FAIL` | Broken or misconfigured. **Do not launch.** |
| `BLOCKED` | An external dependency (provider account, credentials, live activation, a real payout rail) prevents verification. Never treat this as PASS. |
| `WARN` | Not launch-blocking, but an operator should look. |

Run it against the exact environment you intend to serve, and again after every
configuration change.

---

## 2. Environment variables

The full annotated list is `env.example` (tracked, no values). Required for a
production runtime:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. Prefer a least-privilege role (§4). |
| `DATABASE_SCHEMA_BOOTSTRAP` | yes | `off` in production after the schema exists. |
| `ADMIN_PHONES` | yes | Comma-separated allowlist. Unset ⇒ **there are no admins**. |
| `OTP_FIXED_CODE` | yes* | *Or a real SMS delivery integration. Without either, production sign-in returns 503 by design rather than handing out the demo code. |
| `TRUSTED_ORIGINS` | only with a proxy | Extra origins allowed to make state-changing requests. Same-origin requests never need listing. |
| `PAYMENTS_MODE` | yes | `demo` \| `sandbox` \| `live`. |
| `PAYMENTS_SANDBOX_PROVIDER` | yes | `razorpay` for real test-mode runs; `simulated` only for non-money deployments. |
| `PAYMENTS_RAZORPAY_TEST_*` | sandbox | `_KEY_ID`, `_KEY_SECRET`, `_WEBHOOK_SECRET`. |
| `PAYMENTS_RAZORPAY_LIVE_*` | live | `_KEY_ID`, `_KEY_SECRET`, `_WEBHOOK_SECRET`. |
| `PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER` | payouts | RazorpayX source account. Without it withdrawals cannot settle. |
| `PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION` | no | Deliberate acknowledgement that a **production** deployment moves *simulated* balances (a public demo/preview). Never set it on a money deployment. |
| Live gate block (§8) | live | `PAYMENTS_LIVE_ACTIVATION`, `PAYMENTS_COMPLIANCE_ACK`, `PAYMENTS_COMPLIANCE_OWNER`, `PAYMENTS_LIVE_JURISDICTION`, `PAYMENTS_ALLOWED_LIVE_JURISDICTIONS`. |

Rules that the application enforces and you should not fight:

- Secrets live only in the process environment / secret manager. `.gitignore` ignores
  every `.env*` file; `env.example` documents names only.
- `PAYMENTS_RAZORPAY_API_BASE` is a store/staging override. **Setting it in
  production is a FAIL** in `pnpm preflight` — it would send payments to a host of
  your choosing rather than Razorpay.
- Test credentials can never serve live money and live credentials can never drive a
  non-production runtime: the mode is resolved from `NODE_ENV` + the activation gate
  on every financial request.

---

## 3. Deployment

```bash
pnpm install --frozen-lockfile
pnpm typecheck        # tsc --noEmit
pnpm test             # unit suite (no database needed)
pnpm test:db          # PostgreSQL E2E suite (needs a test database, see §11)
pnpm build            # next build — must exit 0
pnpm start            # serves the built app on $PORT, bound to 0.0.0.0
```

- Never run `pnpm build` on a machine that cannot reach the database if your build
  performs prerendering of data-backed pages; the app reads `DATABASE_URL` at runtime.
- In this workspace the platform runs the dev server and (optionally) a managed
  deploy: `freebuff-deploy check` first (it reports the exact install/build commands
  hosting will run), then deploy with `freebuff-deploy start`. Production environment
  variables are managed separately from the workspace `.env` files
  (`freebuff-deploy env list` / `set` / `unset`).
- **Never** ship `PAYMENTS_MODE=live` in the same change that first deploys the
  release. Bring the deployment up, verify sandbox, then activate live (§8).

---

## 4. Production database

Expected objects: 23 tables created by `pnpm db:bootstrap` (core catalogue, trading,
wallet/ledger, Phase 9 payments, Phase 10 rate-limit counters) plus:

- unique indexes that make retries and duplicate webhooks harmless
  (`payment_intent_request_idx`, `payment_intent_provider_payment_idx`,
  `payment_webhook_event` provider event id, `ledger_reference_idx`,
  `transaction_reference_idx`);
- the append-only triggers `ledger_entry_immutable` and `transaction_immutable`, which
  make rewriting or deleting accounting history impossible at the database level (only
  a `status` transition is permitted, so withdrawal holds can still settle).

Bootstrap:

```bash
DATABASE_URL=postgres://… pnpm db:bootstrap   # idempotent: create-if-not-exists only
```

It never drops, truncates or rewrites data. Run it once as the schema owner, verify with
`pnpm preflight`, then set `DATABASE_SCHEMA_BOOTSTRAP=off` so the runtime does not need
DDL rights.

**Least privilege.** The runtime role needs `SELECT, INSERT, UPDATE` on application
tables and `DELETE` only on `rate_limit_counter` (expired counters) and
`otp_challenge`/`session` cleanup if you enable it. It does **not** need `CREATE`,
`DROP`, `ALTER`, `TRUNCATE` or superuser rights once `DATABASE_SCHEMA_BOOTSTRAP=off`.

**Schema changes at launch.** `pnpm db:bootstrap` is additive-only by design, so it is
safe on live data. For anything beyond that: take a backup (§9) first, apply, verify
with `pnpm preflight`, and keep the previous statement set ready as the rollback.

---

## 5. Health checks and monitoring

`GET /api/health` — intentionally unauthenticated, deliberately minimal.

```json
{
  "ok": true,
  "checks": { "application": "ok", "database": "ok" },
  "database": { "reachable": true, "schemaReady": true, "latencyMs": 3 },
  "payments": { "mode": "sandbox", "requestedMode": "sandbox", "liveEnabled": false, "mutationBlocked": false, "sandboxReady": true, "currency": "INR" }
}
```

- `200` — process is serving and the database answered and has the core schema.
- `503` — the database is unreachable or the schema is incomplete. **Page someone.**

It never returns connection strings, driver messages, environment values or stack
traces; configuration detail lives behind the authenticated admin screens or
`pnpm preflight`.

Two alertable conditions exist on that endpoint:

| Condition | Meaning |
|---|---|
| HTTP 503 for 2 consecutive checks | Database down / schema missing. |
| `payments.mutationBlocked: true` on a deployment that should take money | The deployment asked for a payment mode it cannot honour and is **refusing** to move balances. Real revenue is at zero. |

UptimeRobot is a good fit for exactly this: an HTTP(s) monitor on
`https://<host>/api/health` accepting 200 only, a keyword/JSON check on
`"mutationBlocked": false`, alert contacts to the on-call, and its free SSL-expiry
monitoring on the same host. Create the monitor in the dashboard (no code change is
needed — the endpoint already exists) and, if you want it scripted, store
`UPTIMEROBOT_API_KEY` in the environment.

Application-level evidence the monitor cannot see lives in the database and the logs:

| Surface | Where | What to look at |
|---|---|---|
| Failed/rejected webhooks | `payment_webhook_event` (`status in ('failed','rejected')`), admin payment screens | a burst means a signature or mapping problem |
| Reconciliation divergences | `payment_reconciliation_finding` (everything except `matched`), admin → reconciliation | money-level mismatch, needs a human |
| Payments stuck mid-flight | `payment_intent` where `status in ('pending','processing','verified')` and old | the bounded re-check should clear these; `verified` for long means the wallet write failed |
| Security events | `audit_log` / security event rows (`lib/security/events.ts`) | failed authorization, rate-limit trips, rejected webhooks |
| Admin actions | `audit_log` | every privileged action is attributable |
| Accounting invariants | `pnpm preflight` (scheduled) or admin → wallet audit | any account off the wallet equation |

Log conventions: module-prefixed lines (`[payments]`, `[security]`, `[auth]`,
`[health]`) with a coded error, never a credential, session token, OTP, cookie or
webhook secret. Route errors log the thrown error object server-side and return a safe
message to the client.

---

## 6. Alerting (keep it actionable)

| Alert | Trigger | First action |
|---|---|---|
| Database unavailable | `/api/health` 503 ×2 | Check the database service and connection limits; the app fails closed meanwhile. |
| Payments refusing to move money | `payments.mutationBlocked: true` in `/api/health` | Re-run `pnpm preflight`; fix the missing prerequisite or set `PAYMENTS_MODE` to what you actually intend. |
| Webhook failures | any `payment_webhook_event` with `status='rejected'`, or a run of `failed` | Verify the webhook secret and provider event mapping; provider deliveries are retried by the provider. |
| Reconciliation mismatch | a new `payment_reconciliation_finding` with `status <> 'matched'` | Investigate in admin → reconciliation. Never edit balances by hand. |
| Withdrawal failure burst | payouts failing | Check the RazorpayX source account balance/limits. Holds are released on failure, never silently settled. |
| Suspected abuse | rate-limit trips or repeated failed auth for one identifier | The limiter already throttles; escalate if it is a single account. |
| Admin authorization failures | recorded security events | Someone without privilege is probing admin routes. |
| App crash loop | platform health/restart count | Roll back (§10) — do not debug on the live deployment. |

Do not add alerts for routine `demo`/`sandbox` activity.

---

## 7. Data hygiene before launch

Simulated money is the one thing that must be reconciled before live activation: a
balance produced by a sandbox or demo payment becomes **withdrawable real money** the
moment live mode is on.

Read-only inspection (also summarised by `pnpm preflight`):

```sql
select mode, count(*) from payment_intent group by mode;

-- accounts whose wallet is not explained by its ledger
with ledger_totals as (
  select user_id,
         coalesce(sum(case when status = 'completed' and type <> 'bonus' then amount_paise else 0 end), 0) as completed,
         coalesce(sum(case when status = 'pending' then amount_paise else 0 end), 0) as pending,
         coalesce(sum(case when status = 'completed' and type = 'bonus' then amount_paise else 0 end), 0) as bonus
  from ledger_entry group by user_id
)
select w.user_id, w.available_paise, w.locked_paise, w.bonus_paise,
       (w.available_paise + w.locked_paise) - (coalesce(l.completed,0) + coalesce(l.pending,0)) as wallet_difference
from wallet w left join ledger_totals l on l.user_id = w.user_id
where (w.available_paise + w.locked_paise) <> (coalesce(l.completed,0) + coalesce(l.pending,0))
   or w.bonus_paise <> coalesce(l.bonus,0)
   or w.available_paise < 0 or w.locked_paise < 0 or w.bonus_paise < 0;
```

Two categories, two different responses:

- **Balance with no ledger history** (typically seed/fixture data): remove the fixture
  accounts, or zero them with an audited compensating entry — decide with the owner,
  and record why.
- **A posting that drifted**: investigate the payment/transaction reference first; the
  correction is a compensating entry with an audit record, never an `UPDATE` of
  history (the database refuses those for a reason).

Never `DELETE FROM payment_intent`, `ledger_entry` or `transaction` to "clean up".

---

## 8. Live activation gate

Live money requires **all** of:

1. `NODE_ENV=production` — refused elsewhere, always.
2. `PAYMENTS_MODE=live`.
3. `PAYMENTS_LIVE_ACTIVATION=true` (exactly `"true"`; `1`, `yes`, `on` do not count).
4. `PAYMENTS_COMPLIANCE_ACK` — the legal classification / compliance reference.
5. `PAYMENTS_COMPLIANCE_OWNER` — an accountable human or team.
6. `PAYMENTS_LIVE_JURISDICTION` present **and** listed in
   `PAYMENTS_ALLOWED_LIVE_JURISDICTIONS`.
7. `PAYMENTS_LIVE_PROVIDER` (default `razorpay`) with an implemented adapter and
   `PAYMENTS_RAZORPAY_LIVE_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` present.
8. A working sandbox configuration (provider + webhook secret) as the fallback safety net.

With anything missing, live is refused and the deployment's posture decides what
happens next:

- **Non-production**: the gate degrades (live → sandbox → demo). Development keeps
  working as before.
- **Production**: the deployment **refuses to move balances** and every deposit or
  withdrawal answers `503 PAYMENTS_CONFIG_DEGRADED`. It will not quietly credit a
  simulated balance while users believe they paid. The one exception is the explicit
  `PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION=true` acknowledgement for a deliberately
  simulated (non-money) deployment.

There is no URL parameter, header, cookie, client flag, admin screen or API field that
can change this: the gate is evaluated from the process environment, server-side, on
every financial request.

### Go-live sequence

1. `pnpm preflight` → all FAILs resolved; BLOCKEDs understood and owned.
2. Deploy with `PAYMENTS_MODE=sandbox`, `PAYMENTS_SANDBOX_PROVIDER=razorpay` (test keys).
3. Run the end-to-end path with test keys: deposit → provider checkout → webhook →
   wallet/ledger/transaction/history; then withdrawal → payout state → event → settle.
4. Confirm `pnpm preflight` reports the accounting invariants clean (`Accounting PASS`)
   and the reconciliation findings are empty in admin.
5. Verify the deposit **and** withdrawal webhook endpoints are registered at the
   provider with the production (or test, for step 2) webhook secret.
6. Switch to live: set the four gate variables from §8 (1–6) plus the live Razorpay
   credentials, then `PAYMENTS_MODE=live`.
7. Re-deploy, re-run `pnpm preflight` (`live-money gate: PASS` expected) and check
   `/api/health` shows `liveEnabled: true, mutationBlocked: false`.
8. Run the **smallest practical real transaction**: deposit ₹100 with a real method,
   confirm the provider recorded it, the webhook arrived, the wallet credited
   **exactly once**, one ledger movement and one transaction row exist, and history
   shows one entry. Replay the same webhook from the provider dashboard and confirm
   **no second credit**.
9. Do the same for the smallest permitted payout, then open the product to users.
10. If any step fails, stop and revert to step 2 (sandbox) — the gate is reversible
    and never leaves a half-live state.

---

## 9. Backups and restore

Predik does not ship a backup job; it is a PostgreSQL consumer and cannot verify your
platform's snapshots. What the application *does* require is a **tested** restore.

```bash
# backup (schedule daily, retain at least 30 days, encrypt at rest)
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > predik-$(date +%F-%H%M).dump

# restore test — into a SEPARATE database, never over production
createdb predik_restore_test
pg_restore --no-owner --no-privileges --clean --if-exists -d predik_restore_test predik-2026-09-18-0200.dump
DATABASE_URL=postgres://…/predik_restore_test pnpm preflight
```

A restore is only verified when, in the restored copy:

- `pnpm preflight` reports `expected schema PASS` and the accounting invariants clean;
- row counts are plausible (`select count(*) from payment_intent`, `ledger_entry`,
  `wallet`, `market`);
- the append-only triggers exist (the `Ledger PASS` line in the preflight output).

Record the restore timestamp, the backup file and the outcome; an untested backup is
not a backup. Also confirm the *destination* is access-controlled and encrypted —
a dump contains every user's phone number and full financial history.

---

## 10. Disaster recovery and rollback

| Failure | Response |
|---|---|
| Bad deployment | Revert to the previous known-good release (platform rollback), keep the database as is, re-run `pnpm preflight`, then smoke-test one sandbox deposit. Do not patch code on a live deployment. |
| Database unavailable | The app fails closed (503s); payments do not half-apply. Restore per §9 if data loss occurred, then reconcile. |
| Provider outage | Payments stay `pending`/`processing`; the bounded re-check and admin re-check tools advance them when the provider recovers. Never mark a payment settled by hand. |
| Webhook outage | Providers retry; run admin → reconciliation/re-check afterwards to catch anything the retries missed. |
| Suspected duplicate credit / missing money | Freeze the account's activity, run the wallet audit for that user, compare against `payment_intent` + provider dashboard, correct only with a compensating entry, and record an audit note. |

Rules that make recovery safe, and that must not be broken under pressure:

- Accounting history is append-only; corrections are compensating entries.
- A provider "success" response is never treated as final settlement without a verified
  provider state change.
- Rollback must never include a destructive migration. Prefer additive schema changes.

---

## 11. Security configuration notes

Phase 10 hardening is documented in `docs/PHASE-10-SECURITY-REPORT.md`. Points worth
re-checking at launch:

- **CSRF**: state-changing requests are gated by a server-side origin check
  (`lib/security/request-origin.ts`) plus the session cookie. Sessions are `httpOnly`,
  `Secure` in production, `SameSite=None` — deliberate, because the deployment may be
  served from a host the request cannot see (proxy/preview). If you deploy on a single
  same-site host you may tighten this, but then keep the origin check anyway.
- **Rate limiting** is server-side and PostgreSQL-backed, so it holds across
  horizontally scaled instances. Buckets cover OTP request/verify, deposit, withdrawal,
  trade, referral claim, admin action, webhook and account reads; tune with
  `RATE_LIMIT_<BUCKET>_LIMIT` / `_WINDOW_MS`. If the database is unreachable the
  limiter fails **open** (documented trade-off: availability of the payment path over
  throttling) — the database being down is already a paging alert.
- **CSP and headers** live in `next.config.mjs`; the documented exceptions exist for the
  payment checkout redirect, analytics and provider-hosted pages. Verify the production
  build still renders after any change.
- **Bootstrap HTTP**: serve HTTPS only in production; the app never weakens cookie
  security automatically.
- **The pre-flight/OTP blocker**: production sign-in refuses to hand out the demo code.
  Set `OTP_FIXED_CODE` (a deployment secret) or wire a real SMS delivery provider before
  users need to sign in — see the launch report's remaining risks.
