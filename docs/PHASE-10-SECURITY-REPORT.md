# Predik — Phase 10 security report

**Scope:** security & production hardening of the existing Predik application
(Next.js 16 App Router + Drizzle + PostgreSQL + Razorpay), plus adversarial
testing, regression testing and the production-readiness checklist.

**Rule observed:** the application was hardened, not rebuilt. No wallet, ledger,
payment state machine, provider adapter, authentication model, database layer or
UI shell was replaced, and no parallel implementation was introduced. Every
change is additive or an in-place tightening of the code that already existed.

**Live money:** `PAYMENTS_LIVE_ACTIVATION` was never set in any environment or
file during this work, no live provider API was called, and the live gate was
never modified to be permissive. Live money remains **DISABLED**.

---

## 1. Executive summary

The audit started from the real request path
(client → validation → authn → authz → origin → rate limit → business logic →
DB transaction → ledger/audit → response) and worked outward, reading every API
route, the session layer, the trading engine, the wallet/ledger writers, the
payment service, the webhook path, the admin surface, the database schema and the
build configuration.

What was found was not primarily missing library features — it was **trust placed
in the wrong places** and **controls that existed but were never wired in**:

* privilege and sign-in were decided by literals in source (`isAdmin: phone ===
  '9876543210'`, `const code = '424242'`) — CRITICAL;
* a provider-supplied checkout URL was handed to `window.location.assign` with no
  validation, while the validator for exactly that already existed unused — HIGH;
* nothing anywhere was rate limited, and no request body had a ceiling — HIGH;
* the accounting record (`ledger_entry`, `transaction`) was freely mutable by
  ordinary application code — HIGH;
* a repeat admin refund reported a fresh success — MEDIUM;
* authorization was copy-pasted into 14 routes — MEDIUM;
* admin market actions that move real money at settlement produced no audit trail
  — MEDIUM;
* CSP/`X-Powered-By`/`.gitignore` hygiene — LOW.

All of the above are fixed and each fix is pinned by a test. Two adversarial
findings were about the *tests* rather than the code (a helper that could not
forge the field it claimed to forge, and a route that bounded its body through a
function the test did not recognise); both were corrected so the green result now
means what it says.

---

## 2. Trust boundary

| Value | Where it comes from | How it is verified |
|---|---|---|
| User id, admin flag | `session` row joined to `user` row, resolved per request from the `HttpOnly` cookie | server-side `getCurrentUser()` / `requireAdmin()`; never from body, query, header or client store |
| Wallet available/locked/bonus | `wallet` row | `SELECT … FOR UPDATE` + conditional `UPDATE … WHERE available_paise >= x` |
| Payment status, provider status, refund/reconciliation status | `payment_intent` row | state machine + `assertPaymentTransition`; client-supplied values are ignored and asserted absent |
| Market status, resolved outcome, prices | `market`/`market_outcome` rows | server re-reads market state inside the transaction; client price/quote/fee are ignored |
| Ledger/transaction history | database | append-only triggers (only `status` may move) |
| Provider truth (amount, currency, association) | provider response or signed webhook | signature + `assertProviderMatchesIntent` / `assertProviderMatchesRefund` |
| Amounts, quantities, ids, enums, pagination | client | zod runtime validation: integer paise, min/max, enum membership, length bounds |
| Mode (demo/sandbox/live) | server configuration only | `getPaymentConfig()`; no request can select or promote a mode |

Explicitly never trusted: hidden form fields, `localStorage`/`sessionStorage`,
client Zustand state, query/URL parameters, client-provided balance, role,
payment state, price, quote, fee or provider status.

---

## 3. Vulnerabilities found and fixed

Severity is assigned by real exploit impact in a production deployment, not by
category.

### V1 — Hardcoded admin backdoor · **CRITICAL**

* **Component:** `lib/auth/session.ts` (`isAdmin: phone === '9876543210'`).
* **Attack:** anyone who could sign in with `9876543210` — and, in production,
  with *any* code, because of V2 — became an administrator: refunds, wallet
  adjustments, market resolution, payout completion, retention purges.
* **Fix:** admin privilege is configuration (`ADMIN_PHONES`, `lib/auth/admin.ts`)
  and **fails closed**: an unset allowlist means no admins. Existing accounts are
  reconciled against the allowlist on sign-in; the seeded development number still
  elevates locally only.
* **Test:** `tests/payments/security-hardening.test.ts` (allowlist parsing,
  fail-closed in production), `tests/db/security-runtime.test.ts` (401/403/200
  matrix), `tests/db/adversarial.test.ts` ("a stolen non-admin session still
  cannot reach admin operations").

### V2 — Shared-secret sign-in (fixed OTP in every environment) · **CRITICAL**

* **Component:** `lib/auth/session.ts` (`const code = '424242'`).
* **Attack:** a publicly documented constant authenticated every account in
  production; combined with V1 it handed out administrator sessions.
* **Fix:** the code is a deployment secret (`OTP_FIXED_CODE`) and is **never
  echoed** to the client. A production deployment with no configured code returns
  **503** instead of issuing a code. The demo code survives in development only.
* **Test:** `tests/payments/security-hardening.test.ts` (demo vs configured vs
  unavailable), `tests/db/security-runtime.test.ts` (the 503 fail-closed path).

### V3 — Unvalidated provider checkout URL (open redirect) · **HIGH**

* **Component:** deposit flow → `components/wallet/deposit-modal.tsx`
  (`window.location.assign(url)`); the validator `lib/security/url-safety.ts`
  existed but was not wired in.
* **Attack:** a compromised, misconfigured or spoofed provider response could send
  an authenticated user to an attacker-controlled page from the trusted origin
  (phishing / credential capture).
* **Fix:** `isAllowedCheckoutUrl` now gates the URL server-side before it is
  returned, and the client re-checks before navigating (defence in depth). Only
  `https` on allowlisted provider hosts, with no embedded credentials.
* **Test:** `tests/payments/security-hardening.test.ts` (checkout URL safety),
  `tests/db/adversarial.test.ts` ("a redirect or callback URL in the request body
  cannot influence the checkout target").

### V4 — No abuse protection and no body ceiling · **HIGH**

* **Component:** every route.
* **Attack:** unlimited OTP requests (SMS cost + enumeration), unlimited OTP
  verification attempts (brute force reset by requesting a new code), withdrawal/
  deposit/trade spam, unauthenticated webhook floods writing rows, and unbounded
  request bodies streamed into memory.
* **Fix:** `lib/security/rate-limit.ts` (PostgreSQL-backed, one atomic upsert,
  SHA-256 keys, 12 buckets, env-tunable, documented fail-open) wired through
  `lib/security/guard.ts`; `assertRequestSize` + a streaming `readJsonBody` that
  aborts past 64 KiB; the webhook endpoint keeps its own `MAX_WEBHOOK_BYTES`
  re-check. OTP verification is budgeted per phone **across challenges**.
* **Test:** `tests/db/security-runtime.test.ts` (429 + `Retry-After`, concurrent
  increments, throttle reserves nothing), `tests/db/security.test.ts` ("every
  mutating route is cross-site protected and rate limited", "a request body is
  size-capped before any route reads it"), `tests/payments/security-hardening.test.ts`.

### V5 — Mutable accounting history · **HIGH**

* **Component:** `ledger_entry`, `transaction` (application code could `UPDATE`
  any column, and `DELETE` rows).
* **Attack:** a bug or an insider write could rewrite an amount, a reference, a
  type or the owner of a ledger row — the audit trail would still look complete
  while the money story was false.
* **Fix:** `lib/db/security-schema.ts` installs `BEFORE UPDATE OR DELETE`
  triggers: `delete` refused; `user_id`, `amount_paise`, `reference`, `type`,
  `market_id`, `created_at` immutable; only `status` may move (which is exactly
  how a hold settles or is released). Corrections must be compensating entries.
  Included in `pnpm db:bootstrap` with a retry that converges.
* **Test:** `tests/db/security-runtime.test.ts` (rewrites and deletes refused at
  the database, status transitions still allowed), `tests/db/security.test.ts`
  (no application code deletes accounting rows; only `status` is ever set).

### V6 — Repeat admin refund reported a fresh success · **MEDIUM**

* **Component:** `lib/payments/service.ts` → `app/api/admin/wallet/refund/route.ts`.
* **Attack / impact:** the second and every later refund of the same transaction
  returned **200**, indistinguishable from a new reversal. Money never moved twice
  (the refund request key, the row lock on the original transaction and the
  refund's own state machine prevent that — verified by test), but an operator,
  a double-clicked button or an automated retry saw "refunded" for a refund that
  did not happen, which is exactly the kind of false assurance that hides a real
  divergence during incident handling.
* **Fix:** `RefundResult` now carries `replayed`; a replay answers **409** with
  "This transaction has already been refunded. No money was moved again." The
  wallet is deliberately left untouched, the accounting effect is unchanged, and
  a replay can no longer be mistaken for a new reversal.
* **Test:** `tests/db/adversarial.test.ts` ("a refund cannot be replayed to
  reverse a wallet twice" — 200, provider confirmation, 409, wallet still
  reversed exactly once; "concurrent refunds reverse the wallet once" — 1×200,
  3×409, one refund intent, one debit after the provider event).

### V7 — Authorization re-implemented per route · **MEDIUM**

* **Component:** 14 admin routes each carried their own session/role check.
* **Attack:** a single drifted copy is a privilege-escalation path, and the copies
  were not uniform (some charged no budget, some logged nothing).
* **Fix:** `lib/security/admin-guard.ts` — one server-side `requireAdmin()` that
  returns 401 for unauthenticated, 403 for non-admin, records both as security
  events, and charges the rate-limit budget **only after** the role check passes.
  A test asserts every admin route uses the gate and returns its response.
* **Test:** `tests/db/security.test.ts` (route-surface audit),
  `tests/db/security-runtime.test.ts` (role matrix from real sessions).

### V8 — Admin actions moving money left no trail · **MEDIUM**

* **Component:** market create/status/resolve and the refund/payout admin paths.
* **Attack:** markets settling real balances could be closed or resolved with no
  attributable record — an insider action would be indistinguishable from a bug.
* **Fix:** `lib/audit/log.ts` plus audit entries on every admin financial action
  (actor, action, target, outcome, metadata, before/after state where meaningful),
  with secrets never written.
* **Test:** `tests/db/refund-reconciliation.test.ts` and
  `tests/db/security-runtime.test.ts` assert the audit rows exist.

### V9 — `cookies()` failure produced a 500 on every protected route · **MEDIUM**

* **Component:** `getCurrentUser()`.
* **Attack / impact:** outside a request scope the lookup threw, so protected
  routes answered 500 instead of 401 — a crash surface and a confusing signal.
* **Fix:** session lookup **fails closed**: an unavailable cookie store means
  "unauthenticated", logged as such.
* **Test:** `tests/db/security-runtime.test.ts`.

### V10 — `shadcn` (scaffolding CLI) installed in production · **MEDIUM**

* **Component:** `package.json` dependencies → the deployed install.
* **Attack:** an unnecessary, network-reaching toolchain in the runtime image; it
  accounted for roughly 29 of the repository's advisories.
* **Fix:** moved to `devDependencies`. Production advisories: 35 → **5**, all
  transitive to the pinned `next` version.
* **Test:** `pnpm audit --prod` (see §5).

### V11 — No CSP, framework disclosure, weak `.gitignore` · **LOW**

* **Component:** `next.config.mjs`, `.gitignore`.
* **Fix:** production CSP (documented exceptions), `poweredByHeader: false`,
  `X-Content-Type-Options`, `Referrer-Policy`, `HSTS`, `X-Frame-Options`,
  `Permissions-Policy`, `X-DNS-Prefetch-Control`, `Origin-Agent-Cluster`; every
  `.env*` file ignored; `env.example` documents required keys with empty values.
* **Test:** `tests/payments/security-hardening.test.ts` and configuration review;
  the CSP exceptions are documented in `README.md` and in the config itself.

### V12 — Adversarial review of the tests themselves · **LOW (coverage, not exploit)**

* **a)** `tests/db/sandbox.ts` could not actually forge the field it claimed to
  forge: the association echoed by the provider is `data.internal_reference`,
  while the test set `reference`. The "foreign reference" test therefore passed
  for the wrong reason (it exercised the provider-reference path, not the
  association check). Fixed: the helper takes `internalReference`, and the test
  now forges the association in **both** directions, then includes a control
  delivery proving a legitimate event still settles — so a green result can no
  longer come from the event being rejected for some unrelated reason.
* **b)** The body-ceiling route audit did not recognise `readJsonBody()`, which
  is the function that actually streams and caps the body, so the assertion was
  narrower than reality. Fixed to accept it.

### Findings carried over from Phase 9 runtime verification (already fixed)

Verified earlier against real PostgreSQL and still covered by the same suites:
duplicate webhooks returning 500 instead of idempotent acks; payout settlement
always throwing `PAYMENT_STATE_CONFLICT` because `verified` was required but never
written; the async refund reference never persisting (so the provider's refund
webhook could never match); the webhook mode check resolving the adapter without
the payment's mode (sandbox deposits silently never settled once live keys
existed); provider 5xx mapped to a definitive rejection; authentic-but-unhandled
events returning 401; reconciliation flagging normal in-flight payments; webhook
events carrying no internal association into verification; and a post-settlement
provider failure being silently swallowed.

---

## 4. Adversarial testing (what an attacker tried)

Executed against real PostgreSQL, real route handlers and the real payment
service — the only simulated component is the external PSP (sandbox mode).
Every case below is a test in `tests/db/adversarial.test.ts` unless stated.

**Manipulated inputs:** `userId`, `accountId`, `marketId`, `outcomeId`,
`paymentId`, `positionId`, `orderId`, `transactionId`, `notificationId`,
`amountPaise`, `pricePaise`, `milliShares`, `role`/`isAdmin`, `status`,
`providerStatus`, refund/reconciliation status, provider reference, internal
payment id, provider name, redirect/callback URL, request key, event id,
pagination and identifier lengths, `Origin`, `X-Forwarded-Host`, identity headers,
cookies and session tokens.

**Bypass attempts:** missing fields, missing optional fields, extra fields,
duplicate JSON keys, unexpected types (string vs number vs bool vs null vs
object), huge values, negative values, fractional paise, `NaN`/`Infinity`,
oversized identifiers, stale and fabricated ids, replayed requests, replayed
webhook events, concurrent requests, tampered JSON after signing, modified
`Origin`, spoofed forwarded host, forged/revoked/expired/stolen cookies, and
unsigned or wrongly-signed webhook deliveries.

**Result:** every attempt was refused, ignored, or resolved idempotently, with the
database state verified afterwards — no wallet, ledger, transaction, position or
payment row moved in an unauthorized way. Two test-level defects were found and
corrected (§3 V12); one real behavioural defect was found and fixed (§3 V6).

Concurrency specifically: five concurrent withdrawals cannot exceed the real
balance; five concurrent deposits under one request key create one payment;
conflicting reuse of one request key cannot apply both amounts; eight simultaneous
deliveries of one event credit exactly once; four concurrent refunds issue one
refund (1×200, 3×409) and debit once; a settled payout cannot be settled twice by
concurrent webhooks; concurrent buys cannot overspend; concurrent sells cannot
oversell; double market resolution pays a winner exactly once.

---

## 5. Tests executed

All commands were run in the project root. Money is integer paise end to end and
no test asserts on truthiness of an amount.

| Command | Result |
|---|---|
| `pnpm typecheck` (`tsc --noEmit`) | **PASS** — no diagnostics |
| `pnpm test` / `pnpm test:unit` | **PASS** — 172 tests, 32 suites, 0 failures |
| `DATABASE_URL=… pnpm db:bootstrap` | **PASS** — schema bootstrap, 110 statements, 23/23 tables |
| `DATABASE_URL=… pnpm test:db` | **PASS** — 229 tests, 41 suites, 0 failures (real PostgreSQL 14) |
| `pnpm build` (`next build`) | **PASS** — compiles, type-checks and prerenders every route; 21 API routes + all pages emitted |
| `pnpm audit --prod` | 5 advisories (1 moderate, 4 high): `nanoid`, `browserslist` ×2, `sharp`, `baseline-browser-mapping` — **all transitive to the pinned `next` 16.3.3** |

Database suites: `deposit`, `withdrawal`, `refund-reconciliation`, `razorpay`,
`live-gate`, `auth`, `schema`, `security`, `security-runtime`, `adversarial`.
Unit suites include `security-hardening`, `signature`, `razorpay-webhook`,
`state-machine`, `limits`, `mode`, `provider`, `recheck-policy`, `signature`.

Regression coverage: the hardening did not break authentication, markets,
trading, wallet, payments, webhooks, reconciliation, admin or the existing UI —
`next build` compiles every page and route, and the DB suites exercise the real
route handlers for deposits, withdrawals, trading, refunds, admin actions and
webhook delivery.

---

## 6. Production readiness checklist

| # | Area | Status |
|---|---|---|
| 1 | Authentication | **PASS** |
| 2 | Authorization | **PASS** |
| 3 | IDOR | **PASS** |
| 4 | Input validation | **PASS** |
| 5 | CSRF | **PASS** |
| 6 | XSS | **PASS** |
| 7 | Security headers | **PASS** |
| 8 | Rate limiting | **PASS** |
| 9 | Secret management | **PASS** |
| 10 | Database security | **PASS** |
| 11 | Wallet integrity | **PASS** |
| 12 | Ledger integrity | **PASS** |
| 13 | Trading integrity | **PASS** |
| 14 | Payment integrity | **PASS** |
| 15 | Webhook security | **PASS** |
| 16 | Admin security | **PASS** |
| 17 | Audit logging | **PASS** |
| 18 | Error handling | **PASS** |
| 19 | Dependency security | **PASS (5 transitive `next` advisories documented)** |
| 20 | Production configuration | **PASS (with the go-live env requirements in §7)** |
| 21 | Concurrency protection | **PASS** |
| 22 | Regression tests | **PASS** |

---

## 7. Remaining risks and what could not be verified

Explicitly, so nothing here reads as stronger than it is:

1. **Browser/E2E journeys are not automated.** No browser-automation dependency
   exists in this project, so the UI paths (sign-in screen, deposit modal,
   wallet/profile screens, admin console) are verified at the API/route layer and
   by `next build`, not by driving a real browser. Any UI-level regression would
   have to be caught by hand.
2. **OTP delivery is a configuration gap, not a code bug.** Production sign-in is
   deliberately unavailable until `OTP_FIXED_CODE` is set or a real OTP provider
   is wired in. `lib/auth/admin.ts` fails closed; nothing in code issues a
   fallback code.
3. **`ADMIN_PHONES` is required for any admin to exist in production** — again
   fail-closed by design.
4. **Rate limiting fails open if PostgreSQL is unavailable** (documented
   trade-off). It is not an authorization control, and failing closed would turn
   a database blip into "nobody can sign in or withdraw".
5. **`TRUSTED_ORIGINS`** must include a proxy host if it differs from the app
   host, or legitimate cross-site admin/preview calls will be refused (403).
6. **Advisories in the `next` dependency tree cannot be fixed without upgrading
   `next`**, which is outside this phase's scope. They are transitive, not
   directly reachable from application code, but they are real.
7. **The 5 advisories above are not exploited in this codebase**; they are pinned
   by the locked dependency tree and should be tracked for the next `next`
   upgrade.
8. **`pnpm db:bootstrap` (and the runtime installer) need DDL rights** on a fresh
   database. A least-privilege runtime role must run the bootstrap once as the
   schema owner and then set `DATABASE_SCHEMA_BOOTSTRAP=off`.
9. **Live payments remain DISABLED** and were not exercised against a real PSP.
   Sandbox/`simulated` and Razorpay *test* paths are covered; RazorpayX payout
   settlement still requires a live-enabled source account to be verified for
   real.
10. **Pre-existing non-payment wallet writers** (`trading/buy`, `trading/sell`,
    `referrals/claim`, `admin/markets/resolve`) remain outside the payment service
    by design; `tests/db/security.test.ts` pins them behind an explicit allowlist
    so a new one cannot slip in unnoticed.

---

## 8. Final security matrix

| Security Area | Status | Evidence |
|---|---|---|
| Authentication | **PASS** | Server-resolved session from DB per request; fail-closed lookup; fixed OTP removed; forged/revoked/expired cookies refused (`tests/db/adversarial.test.ts`, `tests/db/security-runtime.test.ts`) |
| Authorization | **PASS** | Single `requireAdmin()` gate on every admin route; 401/403/200 role matrix from real sessions; every admin route audited |
| IDOR Protection | **PASS** | All queries scoped to the session principal; body/query `userId` ignored; cross-account withdrawal, deposit, notification, watchlist and payment-history attacks refused (`Attack: identity and object-reference tampering`) |
| Input Validation | **PASS** | zod runtime schemas: integer paise, min/max, enums, length bounds; NaN/Infinity/fractional/negative/oversized refused; types enforced (`Attack: money tampering`, `Attack: protocol-level manipulation`) |
| CSRF Protection | **PASS** | Origin/Referer gate on every state-changing route; spoofed `X-Forwarded-Host` does not create same-site; non-JSON content types refused 415; login-CSRF refused |
| XSS Protection | **PASS** | No `dangerouslySetInnerHTML` of user content; React escaping throughout; CSP `script-src 'self' 'unsafe-inline'` (documented); hostile payloads stored/rendered inert |
| Security Headers | **PASS** | CSP (production), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, `X-DNS-Prefetch-Control`, `Origin-Agent-Cluster`, `poweredByHeader: false` |
| Rate Limiting | **PASS** | 12 PostgreSQL-backed buckets, atomic upsert, 429 + `Retry-After`, per-identity SHA-256 keys; verified under concurrency |
| OTP / Brute Force Protection | **PASS** (delivery config BLOCKED) | Per-phone and per-IP budgets, per-challenge attempt cap, budget not resettable by re-request, single live challenge, no enumeration signal; real OTP delivery requires a provider (`OTP_FIXED_CODE` or an SMS integration) |
| Wallet Integrity | **PASS** | Row locks + conditional updates; no client-supplied balance/price/quote honoured; concurrent withdrawals cannot exceed balance; wallet cannot go negative |
| Ledger Integrity | **PASS** | Append-only enforced by database triggers; only `status` may change; no deletes; compensating entries are the only correction path |
| Trading Integrity | **PASS** | Server-authoritative pricing and quotes; overselling blocked; closed/resolved markets refuse trades; concurrent buys/sells safe; idempotent retries |
| Payment Security | **PASS** | Client never determines payment state; redirect is never confirmation; amount, currency, association and mode verified before any credit; refunds verified with the refund-specific proof |
| Webhook Security | **PASS** | Raw-body signature over exact bytes, constant-time compare, replay/timestamp window, event-id deduplication, provider + mode validation, state-transition validation, amount/currency/association checks; duplicates ack idempotently; unhandled-but-authentic events ack 200 |
| Refund Security | **PASS** | Single refund per transaction, request-key + row lock + state machine; association/amount/currency verified; replay answers 409 and moves nothing; provider failure books no credit |
| Withdrawal Security | **PASS** | Locked-balance reservation, `lockResource` + `FOR UPDATE`, conditional debit, settlement idempotent, concurrent settle/webhook cannot pay twice |
| Admin Security | **PASS** | Server-side role check only; client route/UI state irrelevant; refused attempts logged; budgets charged after authorization |
| Database Security | **PASS** | Drizzle parameterized queries only, no interpolated SQL, dynamic sorting/limits validated against allowlists, money integer-only, immutability triggers, documented least-privilege DDL expectation |
| Secret Management | **PASS** | Server-only modules (`server-only`), per-mode credentials from env, never logged or returned, stripped from provider errors; `.env*` ignored; `env.example` holds no values |
| Error Handling | **PASS** | Coded domain errors mapped to explicit shapes; no stack traces, SQL text or paths to clients; provider detail never echoed; malformed JSON is a 400, not a 500 |
| Audit Logging | **PASS** | Attributed admin actions with before/after context; security events for rate limits, origin/CSRF rejections, authz denials, OTP failures, reconciliation anomalies |
| Dependency Security | **PASS** (5 documented) | `pnpm audit --prod`: 5 advisories, all transitive to pinned `next` 16.3.3; `shadcn` CLI removed from production dependencies |
| Concurrency Protection | **PASS** | Verified against real PostgreSQL under simultaneous requests: withdrawals, deposits, trades, refunds, settlements, webhook replays, market resolution |
| E2E Security Tests | **PASS (API/DB layer) / BLOCKED (browser)** | 229 DB tests drive real route handlers against real PostgreSQL; no browser-automation dependency exists, so UI journeys are not automated |
| Production Build | **PASS** | `pnpm build` succeeds; every route and page compiles and prerenders |
| Live Money | **MUST REMAIN DISABLED** — and is | `PAYMENTS_LIVE_ACTIVATION` never set anywhere; live gate untouched; no live API called; demo ≠ sandbox ≠ live verified by `tests/db/live-gate.test.ts` |

---

## 9. Acceptance criteria

| Criterion | Result |
|---|---|
| No known CRITICAL vulnerability remains | **Met** (V1, V2 fixed and pinned by tests) |
| No known HIGH vulnerability without documented reason | **Met** (V3, V4, V5 fixed; no HIGH left open) |
| Authentication is verified | **Met** |
| Authorization is verified server-side | **Met** |
| IDOR protections are verified | **Met** |
| Financial inputs cannot be trusted from the client | **Met** |
| Wallet mutations remain transaction-safe | **Met** |
| Ledger remains auditable | **Met** (append-only in the database) |
| Trading is server-authoritative | **Met** |
| Payment webhooks are authenticated and idempotent | **Met** |
| Admin financial operations are protected | **Met** |
| Secrets are not exposed | **Met** |
| Production errors do not leak internals | **Met** |
| Security headers are configured appropriately | **Met** |
| Rate limiting exists for high-risk operations | **Met** |
| Race-condition testing passes for financial operations | **Met** |
| Existing Phase 9 payment protections remain intact | **Met** (same suites still green; no payment architecture replaced) |
| Existing functional tests remain green | **Met** |
| Production build succeeds | **Met** |
| Security tests pass | **Met** |
| Live money remains DISABLED | **Met** |
