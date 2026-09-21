# Predik — Phase 11: Final Production Launch & Go-Live

Date: 2026-09-18 · Version: `0.8.0` (Phase 10 baseline + Phase 11 launch work)

> **Live money is DISABLED and remains disabled.** No production credential, host,
> provider account or payout rail exists in this environment, and nothing in this phase
> enabled one. Everything that depends on those is reported as **BLOCKED**, not PASS.

---

## 1. Executive summary

Phase 11 prepared the existing Predik codebase for production and then tried to falsify
that preparation. It did not rebuild anything: the payment state machine, wallet, ledger,
provider adapter, webhook pipeline, trading engine, admin surface and UI are the same
systems Phase 9/10 delivered.

What was actually done:

1. **Re-audited the whole repository** for launch blockers (TODOs, debug routes, mock
   payment paths, hardcoded credentials, client-trusted money, XSS sinks, unsafe raw SQL,
   secret exposure). The audit found **no launch-blocking defects** — the Phase 10
   hardening is intact and the live-activation gate is untouched.
2. **Closed one real launch hazard** that only exists in production: a production runtime
   could *silently degrade* its payment mode (live → sandbox → demo) and then credit a
   simulated balance while users believed they had paid. Production now **refuses to move
   balances** (`503 PAYMENTS_CONFIG_DEGRADED`) unless the requested mode is actually
   honoured by a real provider — with one explicit operator acknowledgement for
   deliberately simulated (non-money) deployments.
3. **Added a production health endpoint** (`GET /api/health`) that separates application
   from database health and reports whether money can move — without disclosing
   configuration.
4. **Added a deployment-wide accounting sweep** and a **launch gate script**
   (`pnpm preflight`) that resolves the real environment, inspects the real PostgreSQL
   schema (tables, append-only triggers, rate-limit store) and checks the money
   invariants across every account.
5. **Proved the backup/restore procedure** against a real PostgreSQL: dump → restore into
   a separate database → 18/18 wallets, 14/14 payments, 14/14 ledger rows and both
   immutability triggers restored → `pnpm preflight` reports the restored copy's schema
   and invariants.
6. **Extended the test suites**: 179 unit tests (7 new) and 241 database tests (12 new),
   all green, plus a clean `tsc --noEmit` and a successful `next build`.
7. **Wrote the production runbook** (`docs/PRODUCTION-RUNBOOK.md`): deploy, environment,
   database roles, monitoring/alerting, backups, disaster recovery, rollback, data hygiene
   and the step-by-step live-activation sequence.

The product is **code-complete and internally verified**. It is **not launched**, because
launch requires things this environment cannot supply: a production host/domain, a
production database, production Razorpay credentials, a registered production webhook
endpoint, a monitoring account, backups on the platform, and a human decision to satisfy
the live-money gate. §8 lists them with the exact reason each is blocked.

---

## 2. Pre-launch code audit (§4, §30, §31)

Every search below was run across `app/`, `lib/`, `components/`, `scripts/`, `tests/`
and the build config.

| Search | Result |
|---|---|
| `TODO` / `FIXME` / `HACK` / `XXX` / `@ts-ignore` / `@ts-expect-error` | **none** |
| Debug / test-only endpoints (`/debug`, `__dev`, `mock-complete`, dev bypass flags) | **none** |
| Hardcoded users, admin phone numbers, admin credentials, API keys | **none** (admin privilege is configuration-driven and fails closed; the only fixed code is the development demo OTP, which production refuses to issue) |
| Mock / simulated payment logic reachable in production | Simulated adapters exist by design for `demo`/`sandbox`, and **cannot move balances in production** after this phase's posture gate (§3) |
| Fake wallet credits / fake settlement / dev wallet credit | **none** — the only balance mutation path is the payment service's verified-event path |
| `console.log` of secrets, tokens, cookies, OTPs | **none**; logging is error-only (`[payments]`, `[security]`, `[auth]`, `[health]` prefixes) and logs error objects, never credentials |
| XSS sinks (`dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `eval`, `new Function`) | **none** |
| Unsafe raw SQL (`sql.raw` with interpolated input) | **none** — the six `sql.raw` calls are static DDL statements plus the new constant invariant queries; no user value reaches them |
| Committed secrets (Razorpay keys, JWT/database secrets, connection strings) | **none**; `env.example` documents names with empty values and `.gitignore` ignores every `.env*` |
| `pnpm audit --prod` | 5 advisories (1 moderate, 4 high), all transitive to the pinned `next` 16.3.3 toolchain — documented, remediation requires a framework upgrade (out of scope, §8) |

Trust boundaries were re-confirmed rather than re-designed: user id, roles, wallet and
locked balances, market state, payment status and ledger state are server state only;
amounts, ids, prices, quantities, destinations and pagination come from the client and are
validated and re-derived server-side (Phase 10's guards, zod schemas and the 26 route
guards remain in place — this phase changed none of them).

---

## 3. Changes made in Phase 11

| Change | Files | Why |
|---|---|---|
| **Production posture: no silent degradation** | `lib/payments/mode.ts`, `lib/payments/config.ts`, `lib/payments/errors.ts`, `lib/payments/service.ts`, `app/api/admin/payments/sandbox/route.ts`, `types/index.ts`, `app/wallet/page.tsx` | A production deployment that cannot honour the payment mode it was configured for must refuse new monetary exposure instead of quietly running a weaker mode. New `PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION` acknowledgement covers intentional non-money (demo/preview) production deployments. Deposits, withdrawals and the sandbox simulation helper all assert the posture; **webhook settlement and admin refunds deliberately do not**, so existing obligations are never stranded. |
| **Health endpoint** | `app/api/health/route.ts` | Distinguishes application health from database health, reports `payments.mutationBlocked` for monitoring, returns 503 when the database or schema is not ready, and leaks no configuration. |
| **Accounting integrity sweep** | `lib/payments/reconciliation.ts` (`auditAccountingIntegrity`) | Turned the per-account wallet/ledger audit into a deployment-wide invariant check (equation for every wallet, negative balances, settled payments without a transaction row, completed transactions without a ledger entry, refunds without a parent) plus a direction split (holding more vs holding less than the ledger explains). Read only; never repairs. |
| **Launch gate script** | `scripts/preflight.ts`, `package.json` (`pnpm preflight`) | One command an operator runs against the real environment; PASS/FAIL/BLOCKED/WARN output, `--json` for CI, exit 1 on any FAIL, no secret ever printed. |
| **Tests** | `tests/payments/mode.test.ts` (+7), `tests/db/launch-preflight.test.ts` (+12) | Posture unit tests; PostgreSQL tests for the invariants, the degraded-production refusals, the sweep-vs-per-account agreement guard, and the health endpoint. |
| **Docs / configuration template** | `docs/PRODUCTION-RUNBOOK.md`, `env.example`, `README.md` | Operator-facing launch procedure and the new configuration surface. |

Nothing was replaced: no second wallet, no second ledger, no change to the payment state
machine, the Razorpay adapter, the webhook pipeline, idempotency, the trading engine or the
auth model.

---

## 4. Tests executed (§37, §41)

All commands were run in this workspace. Database commands ran against a real
PostgreSQL 14 instance.

| Command | Result |
|---|---|
| `pnpm typecheck` (`tsc --noEmit`) | **PASS** — no diagnostics |
| `pnpm test:unit` | **PASS** — 179 tests / 33 suites / 0 failures |
| `DATABASE_URL=… pnpm test:db` | **PASS** — 241 tests / 44 suites / 0 failures |
| `pnpm build` (`next build`) | **PASS** — all pages and 22 API routes compiled (incl. `/api/health`) |
| `pnpm preflight` (development environment, local PostgreSQL) | Ran successfully: 19 checks → 11 PASS, 3 WARN, 2 BLOCKED, 3 FAIL. The FAILs are the *correct* result for an unconfigured environment (no `ADMIN_PHONES`, no sign-in code, and a test database full of fixture balances and sandbox payments) and are exactly what the gate exists to catch. |
| Backup/restore verification | **PASS** — `pg_dump` → `pg_restore` into `predik_restore_test`: 18 wallets, 14 payments, 14 ledger rows restored; `ledger_entry_immutable` + `transaction_immutable` present; `pnpm preflight` against the restored copy reported `expected schema 23/23 PASS`, `append-only enforcement PASS`, `durable counter store PASS`. |
| `pnpm audit --prod` | 5 advisories (1 moderate, 4 high), all transitive to `next` 16.3.3 |

Database coverage relevant to the launch gate (existing suites, still green):
admin authorization from the database (`security-runtime.test.ts`), server-side rate
limiting, request guards on real requests, append-only accounting in the database itself,
trading concurrency, market-resolution idempotency under concurrency, wallet invariants,
deposit/withdrawal E2E, withdrawal concurrency, Razorpay deposit/payout/refund/
reconciliation over real HTTP against a local mock provider, live-gate behaviour,
adversarial suites (IDOR, money tampering, protocol manipulation, cookie/session
manipulation, replay/staleness/idempotency, provider and webhook tampering, simultaneous
requests), and the new launch-gate suites.

---

## 5. Production readiness checklist (§40)

| Item | Status | Evidence |
|---|---|---|
| Authentication | **PASS / BLOCKED (delivery)** | Session model, expiry, revocation, forged/stolen-cookie refusal and fail-closed sign-in verified in unit + DB suites. Production *code delivery* (a real OTP channel) is BLOCKED — see §8. |
| Authorization | **PASS** | Single server-side `requireAdmin` gate; 401 unauthenticated / 403 non-admin proven against real requests. |
| IDOR | **PASS** | Every id-bearing route scoped to the authenticated principal; tampering suites green. |
| Input validation | **PASS** | Centralised zod schemas + runtime bounds (integers, ranges, enums, lengths, body ceiling); NaN/Infinity/negative/oversized rejected. |
| CSRF | **PASS** | Server-side origin check + session cookie; cross-site state-changing requests rejected (unit + DB tests). |
| XSS | **PASS** | No HTML injection sinks; user content rendered as text only. |
| Security headers | **PASS (config) / pending runtime confirmation** | CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`, `poweredByHeader: false` configured in `next.config.mjs`, documented exceptions; production `curl -I` confirmation is on the go-live checklist. |
| Rate limiting | **PASS** | PostgreSQL-backed limiter, shared across instances; bucket coverage and 429 behaviour tested; store verified present in the live database. |
| Secret management | **PASS** | No secret in the repo, the client bundle, logs or responses; env-only, names documented. |
| Database security | **PASS** | Parameterised queries, validated dynamic components, least-privilege role documented, append-only triggers verified in the real database. |
| Wallet integrity | **PASS** | Transactional, row-locked, condition-guarded mutations; no negative balances; invariants verified in DB tests and by the new sweep. |
| Ledger integrity | **PASS** | Append-only enforced by the database (rewrites/deletes refused, only status transitions allowed); reference uniqueness; sweep checks transaction↔ledger parity. |
| Trading integrity | **PASS** | Server-authoritative quotes/prices/quantities; no overselling/overspending under concurrency; trades refused after close/resolution. |
| Payment integrity | **PASS (sandbox) / BLOCKED (live)** | Verified provider-event → state machine → wallet/ledger path proven end to end with the real HTTP adapter against a mock PSP. Live money is off (§8). |
| Webhook security | **PASS (code) / BLOCKED (registration)** | Raw body, constant-time signature comparison, replay/dedupe, amount/currency/reference/ownership verification, state-transition limits — all tested. The *production* endpoint registration at the provider cannot be performed here. |
| Admin security | **PASS** | Server-side role checks on every privileged route, audited actions, no client-side role trust. |
| Audit logging | **PASS** | Actor/action/target/outcome recorded for admin, payment, security and wallet events; no secrets in metadata. |
| Error handling | **PASS** | Coded errors mapped to safe messages; stack traces and driver detail stay server-side (health endpoint included). |
| Dependency security | **PASS (documented)** | Production tree otherwise clean; 5 advisories are transitive to the pinned `next` 16.3.3 toolchain (see §8). |
| Production configuration | **PASS (gated)** | Fail-fast validation, environment-only activation controls, `pnpm preflight` gate, no development fallbacks in production; production values themselves are supplied at deploy time. |
| Concurrency protection | **PASS** | Concurrent withdrawals, trades, refunds, resolutions and duplicate webhook deliveries all verified against PostgreSQL. |
| Regression tests | **PASS** | 179 unit + 241 DB tests green; build green; no Phase 9/10 protection removed. |
| Live money | **MUST REMAIN DISABLED — and is** | `PAYMENTS_MODE` is `demo` by default, `PAYMENTS_LIVE_ACTIVATION` is unset, no live credentials or payout account exist, and the gate is unchanged. |

---

## 6. Launch gate (§41)

| Gate | Status |
|---|---|
| Application | **PASS** — builds, starts, serves every route |
| Authentication (mechanism) | **PASS** |
| Authentication (production delivery) | **BLOCKED** — no OTP channel configured |
| Authorization | **PASS** |
| Security | **PASS** |
| PostgreSQL (local/verified) | **PASS** |
| PostgreSQL (production instance) | **BLOCKED** — no production database in this environment |
| Wallet | **PASS** |
| Ledger | **PASS** |
| Trading | **PASS** |
| Market lifecycle | **PASS** — close/resolve/settle idempotency under concurrency verified |
| Razorpay production connection | **BLOCKED** — no production account/credentials |
| Deposit | **PASS (sandbox E2E)** / **BLOCKED (live)** |
| Withdrawal | **PASS (sandbox hold → event → settle/release)** / **BLOCKED (live payout)** |
| Webhook | **PASS (handler)** / **BLOCKED (production endpoint registration)** |
| Refund | **PASS (sandbox E2E, double-refund refused)** |
| Reconciliation | **PASS** — provider comparison + wallet/ledger sweep |
| Admin | **PASS** |
| Backups | **BLOCKED** — platform responsibility; restore procedure verified locally |
| Restore test | **PASS (local PostgreSQL)** / **BLOCKED (production dump)** |
| Monitoring | **PASS (health endpoint + alert conditions)** / **BLOCKED (monitoring account)** |
| Production build | **PASS** |
| Browser smoke test | **BLOCKED** — no deployed production URL and no browser automation in the project |
| Mobile smoke test | **BLOCKED** — same |

**Launch gate conclusion: not satisfied for go-live.** No application or security gate
failed; every remaining gate is blocked by something outside the codebase and is listed in
§8 with what is required to clear it.

---

## 7. Block conditions (§42)

| Condition | Present? |
|---|---|
| Critical security vulnerability | **No** |
| High-risk authorization bypass | **No** |
| Wallet accounting inconsistency in the application | **No** — the sweep reports fixture/seeded balances in the local test database, not a posting drift |
| Ledger inconsistency | **No** — append-only enforced and verified |
| Broken payment webhook verification | **No** |
| Duplicate wallet credit vulnerability | **No** — idempotency and dedupe verified |
| Double withdrawal vulnerability | **No** — row locks + conditional updates verified |
| Broken market settlement | **No** |
| Production database unavailable | **BLOCKED** — not provisioned here |
| Production secrets unavailable | **BLOCKED** — operator to supply |
| Production payment configuration invalid | **BLOCKED** — no live/test credentials present |
| Unexplained money discrepancy | **No** |
| Missing required provider capability | **BLOCKED** — production Razorpay account + payout rail |
| Failed backup/restore verification | **No** — verified locally; production schedule BLOCKED |
| Broken production build | **No** |
| Critical unexplained E2E failure | **No** |

---

## 8. Remaining risks and blockers (explicit)

| # | Blocker | Exact reason | To clear it |
|---|---|---|---|
| 1 | **Live money activation** | `PAYMENTS_MODE=demo`; `PAYMENTS_LIVE_ACTIVATION` unset; no compliance ack/owner/jurisdiction; no `PAYMENTS_RAZORPAY_LIVE_*`; no payout account. The gate is deliberately fail-closed and was not weakened. | Provider + legal decision; then the §8 runbook sequence, ending with the smallest real deposit replay test. |
| 2 | **Production sign-in** | No OTP delivery channel. Production refuses the demo code (503) instead of issuing a public constant. | Set `OTP_FIXED_CODE` (deployment secret) or wire an SMS provider — e.g. **Knock** for SMS OTP + the existing notification flows. |
| 3 | **Production host, domain, HTTPS, proxy** | No production deployment exists in this workspace; `TRUSTED_ORIGINS` therefore unset. | Deploy, then set `TRUSTED_ORIGINS` if the public host differs from the app host, and confirm TLS/cookies with `curl -I`. |
| 4 | **Production database** | No production PostgreSQL instance here; `DATABASE_URL` unset in this workspace. | Provision, run `pnpm db:bootstrap` once as the schema owner, set `DATABASE_SCHEMA_BOOTSTRAP=off`, then `pnpm preflight`. |
| 5 | **Provider-registered webhook endpoint** | Requires the public production URL and the provider dashboard; the handler itself is verified. | Register `https://<host>/api/payments/webhook` with the mode's webhook secret, then send a provider test delivery and confirm one credit. |
| 6 | **Real-money deposit/payout test (§39)** | Cannot be faked and cannot be run without a production account and funds. | Perform after activation: smallest deposit, replay the webhook (expect no second credit), then the smallest permitted payout. |
| 7 | **Backups / monitoring accounts** | Platform-level responsibilities that the application cannot create. | Schedule encrypted `pg_dump` retention (or platform snapshots) and repeat the verified restore test on the real dump; create an UptimeRobot HTTP(s) monitor on `/api/health` (expect 200, keyword `"mutationBlocked": false`, SSL-expiry alerts). |
| 8 | **Browser and mobile smoke tests (§34, §35)** | No browser automation dependency exists in this project and there is no deployed production URL; the environment forbids starting long-lived servers here. | After the first deploy, walk the sign-in → market → buy → sell → wallet → deposit → withdrawal → activity → admin → resolution → settlement journey on desktop and Android Chrome. |
| 9 | **`next` advisories** | 5 advisories (1 moderate, 4 high) are transitive to the pinned `next` 16.3.3 toolchain; fixing them changes the framework version. | Schedule a `next` upgrade in a dedicated change, then re-run the full suites. |
| 10 | **Rate limiter fail-open** | If PostgreSQL is unreachable the limiter allows requests (documented availability-over-throttling trade-off). | Accept and rely on the database-down alert; revisit if abuse during a DB outage becomes a real threat. |
| 11 | **RazorpayX payout settlement against a live source account** | Only verified against a local mock PSP over real HTTP. | Verify with the smallest real payout after activation. |

### Deliberate exceptions worth knowing

- Sessions use `SameSite=None` + `Secure` in production because the deployment may be
  served from a host the app cannot see (proxy/preview). CSRF is instead enforced by the
  server-side origin check. A single same-site deployment may tighten this, keeping the
  origin check.
- The CSP in `next.config.mjs` has documented exceptions for the provider-hosted checkout,
  analytics and hosted payment pages. Verify the production build renders after any change.
- `PAYMENTS_RAZORPAY_API_BASE` exists for staging/mock runs and is a **FAIL** in
  `pnpm preflight` when set in a production runtime.

---

## 9. No fake PASS

- Every PASS above was produced by a command run in this environment, an assertion in an
  automated suite, or a row read from a real PostgreSQL database. No result was inferred
  from documentation or from a previous report.
- Every BLOCKED item is marked BLOCKED even where the code is complete and tested, because
  the *production* form of it was not exercised (live Razorpay, production host/database,
  provider-registered webhook, monitoring account, browser/mobile journeys).
- Mocked/local-provider results are never presented as evidence of a real production
  integration: the Razorpay adapter tests are labelled as running against a local mock PSP
  over real HTTP.
- Live money was **not** enabled, and no gate was weakened to make a check pass.

---

## 10. What to do next (operator sequence)

1. Provision the production database and secrets; run `pnpm db:bootstrap` once as the
   schema owner; set `DATABASE_SCHEMA_BOOTSTRAP=off`.
2. Set `ADMIN_PHONES`, and either `OTP_FIXED_CODE` or a real SMS OTP provider.
3. Deploy in sandbox mode with Razorpay **test** keys; run `pnpm preflight` until every
   FAIL is resolved.
4. Run the sandbox end-to-end journey (deposit → webhook → wallet/ledger/history;
   withdrawal → payout state → settle) and confirm the reconciliation screens are clean.
5. Configure monitoring on `/api/health`, backups, and the restore schedule.
6. Satisfy the live-activation gate deliberately, redeploy, and confirm
   `pnpm preflight` reports the live-money gate PASS and `/api/health` reports
   `liveEnabled: true, mutationBlocked: false`.
7. Execute the smallest real deposit (and a webhook replay) and the smallest real payout,
   verify the database records exactly once, then open the product to users.
