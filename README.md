# Prediction-web
Betting Prediction website like Kalshi, polymarket

## Payments (Phase 9 · Steps 1–2)

Predik has a provider-ready, auditable, transaction-safe payment foundation
(Step 1) with a real payment-service-provider integration behind it (Step 2).
Real money is **not** enabled: the live-money path is gated, fails closed, and
reports exactly which prerequisite is missing.

### Architecture

```
User
 ↓  eligibility / account state      lib/payments/eligibility.ts   (ELIGIBLE / NOT_ELIGIBLE / REQUIRES_REVIEW)
 ↓  payment method / provider        lib/payments/provider.ts      (registry, config-selected)
 ↓  deposit or withdrawal request    app/api/wallet/{deposit,withdraw}
 ↓  provider interaction             lib/payments/razorpay/*  or  lib/payments/simulated-provider.ts
 ↓  provider webhook                 POST /api/payments/webhook    (signature verified, event id deduped)
 ↓  verification                     lib/payments/webhook.ts
 ↓  internal transaction state       payment_intent row + state machine
 ↓  wallet ledger                    lib/payments/service.ts       (single writer)
 ↓  bounded status re-check          lib/payments/recheck.ts       (lost webhook recovery)
 ↓  reconciliation                   lib/payments/reconciliation.ts
 ↓  retention                        lib/payments/retention.ts
 ↓  user-visible status              wallet page + notifications
```

Payment state is deliberately **separate from wallet state**: a payment can be
created, pending, failed, cancelled, expired or refunded without the wallet
moving at all. Only the `verified → completed` step moves money, and it is the
only place in the codebase that translates provider truth into a balance change.

### Payment tables

| Table | Purpose |
| --- | --- |
| `payment_intent` | The authoritative payment record: direction, status, provider, provider reference, provider order/payout anchor, hosted checkout URL, re-check attempts, amount (integer paise), fee, refund status, reconciliation status, timestamps. |
| `payment_webhook_event` | Every provider delivery received (including rejected ones) with processing status, attempts and error. |
| `payment_reconciliation_run` / `payment_reconciliation_finding` | Reconciliation evidence and the mismatches that need human handling. |
| `payment_account` | Payment eligibility / KYC / jurisdiction state, kept out of the `user` table. |
| `audit_log` | Administrative financial actions (refunds, withdrawal resolution, retries, re-checks, reconciliation runs, retention purges, rejected webhooks). |

Tables are created by an idempotent bootstrap (`lib/db/payment-schema.ts`) on
first payment use, matching the project's existing `ensureDemoCatalog()` pattern
— the unique indexes it creates are what make retries and duplicate webhooks
harmless.

### Money and currency

Money stays an **integer number of paise** everywhere. Provider amounts are
normalized into paise before any financial mutation (`lib/payments/limits.ts`);
an amount that cannot be represented exactly as paise is rejected rather than
rounded. INR is the only supported currency — a provider reporting any other
currency fails the payment and is reported by reconciliation.

There is no deposit fee model in the product, so `fee_paise` is 0 and
`net_paise == amount_paise`. The fields exist so a fee can be represented
explicitly later instead of hiding inside a balanced change.

### Modes and the live-money gate

```
PAYMENTS_MODE=demo     # default — simulated, settles in the create call
PAYMENTS_MODE=sandbox  # provider test mode — settles on a signed webhook
PAYMENTS_MODE=live     # real money — additionally requires every prerequisite below
```

Live money is refused unless **all** of the following are true. Configuring
provider credentials alone never enables it, and there is no admin action, client
flag, URL, header or environment trick that can flip the gate: it is derived from
the process environment, server-side, on every financial request.

| Requirement | Env var |
| --- | --- |
| Explicit operator activation | `PAYMENTS_LIVE_ACTIVATION=true` (must be exactly `true`) |
| Legal classification / compliance acknowledgement | `PAYMENTS_COMPLIANCE_ACK` |
| Accountable owner | `PAYMENTS_COMPLIANCE_OWNER` |
| Approved jurisdiction | `PAYMENTS_LIVE_JURISDICTION` ∈ `PAYMENTS_ALLOWED_LIVE_JURISDICTIONS` |
| Live provider adapter implemented | build-time (`lib/payments/capabilities.ts`) — Razorpay is implemented |
| Live provider credentials | `PAYMENTS_RAZORPAY_LIVE_KEY_ID`, `PAYMENTS_RAZORPAY_LIVE_KEY_SECRET`, `PAYMENTS_RAZORPAY_LIVE_WEBHOOK_SECRET` |
| Payout source account (needed for real withdrawals) | `PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER` |
| Production runtime | `NODE_ENV=production` |

When anything is missing the deployment stays in SANDBOX (or DEMO) and reports
the unmet prerequisites, which admins can see in the admin payments panel and via
`GET /api/admin/payments`. Live balance mutation also requires an account whose
`payment_account` row is `active`, KYC `verified`, `live_eligible`, in the
approved jurisdiction — see `decidePaymentEligibility`.

`GET /api/admin/payments/eligibility?userId=…&mode=live` reports that decision
(and its reason code) without moving any money, so eligibility can be prepared
before cutover.

### Environment configuration

```bash
# Mode
PAYMENTS_MODE=demo|sandbox|live

# Simulated adapters (demo / simulator-sandbox only)
PAYMENTS_WEBHOOK_SECRET_DEMO=
PAYMENTS_WEBHOOK_SECRET_SANDBOX=
# Which adapter serves sandbox: "simulated" (default) or "razorpay"
PAYMENTS_SANDBOX_PROVIDER=simulated

# Razorpay — TEST mode (sandbox)
PAYMENTS_RAZORPAY_TEST_KEY_ID=
PAYMENTS_RAZORPAY_TEST_KEY_SECRET=
PAYMENTS_RAZORPAY_TEST_WEBHOOK_SECRET=

# Razorpay — LIVE mode (real money; gated as above)
PAYMENTS_RAZORPAY_LIVE_KEY_ID=
PAYMENTS_RAZORPAY_LIVE_KEY_SECRET=
PAYMENTS_RAZORPAY_LIVE_WEBHOOK_SECRET=

# RazorpayX payouts (withdrawals)
PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER=
PAYMENTS_RAZORPAY_PAYOUT_MODE=UPI          # UPI | IMPS | NEFT | RTGS
PAYMENTS_RAZORPAY_USE_PAYMENT_LINKS=true   # hosted checkout (default) vs Orders + Checkout.js
PAYMENTS_RAZORPAY_API_BASE=                # override for staging/local mocks only
PAYMENTS_RAZORPAY_ACCOUNT_ID=              # expected merchant id, verified in provider responses

# Live gate
PAYMENTS_LIVE_PROVIDER=razorpay
PAYMENTS_LIVE_ACTIVATION=false
PAYMENTS_COMPLIANCE_ACK=
PAYMENTS_COMPLIANCE_OWNER=
PAYMENTS_LIVE_JURISDICTION=
PAYMENTS_ALLOWED_LIVE_JURISDICTIONS=
```

Credentials are read from the environment only, per provider **and** per mode, so
a sandbox run can never use live keys. Secrets are never hardcoded, never logged,
never placed in a client bundle, and are stripped from any provider error text
before it is surfaced (`lib/payments/razorpay/client.ts`).

### Provider layer

One contract (`lib/payments/contracts.ts`) with
`createDeposit`, `getPaymentStatus`, `verifyPayment`, `createWithdrawal`,
`getWithdrawalStatus`, `cancelWithdrawal`, `refundPayment`, `fetchPayment`,
`listPayments` and `verifyWebhook`. Providers are selected from configuration
(`lib/payments/provider.ts`) — never imported directly by callers, and never
selected by a mode the gate has not enabled.

* `RazorpayPaymentProvider` (`lib/payments/razorpay/`) — deposits via the Orders
  API plus a provider-hosted payment link, withdrawals via RazorpayX payouts.
  All Razorpay vocabulary lives in that folder; nothing else in the app knows the
  provider's names.
* `SimulatedPaymentProvider` — keeps `demo` (instant settle) and simulator
  `sandbox` (pending until a signed webhook) available for development. Amounts
  whose last two paise digits are `99` fail deterministically, which makes the
  failure/release paths reproducible.

### Deposit flow

```
request → server validation (authn, amount, currency, limits, eligibility,
          duplicate request key) → payment_intent committed (status created)
        → provider ORDER (+ hosted payment link) → status pending
        → user pays on the provider's page
        → signed webhook (payment.captured / order.paid)
        → signature + event-id checks → load payment (by payment id, reference
          or the order anchor) → validate amount, currency and internal reference
        → status verified → wallet credit + transaction + ledger + notification
        → status completed
```

An `authorized` (uncaptured) payment is **not** credited. A redirect back to the
app is never a confirmation. If the provider reports an unexpected amount,
currency, merchant account or reference, nothing is credited: the payment is
flagged for controlled review (`reconciliation_status = mismatch`) and shown to
admins.

### Withdrawal flow

```
request → authn, eligibility, amount limits, available-balance check
        → funds moved available → locked (reserved) in the same transaction as
          the payment row (unique request key ⇒ the same money cannot be queued twice)
        → provider payout (reusing a stored UUID as the provider idempotency key)
        → status pending / processing
        → payout webhook or status lookup: processed ⇒ final debit from locked
          (locked → spent), failed / reversed / cancelled ⇒ reservation released
          back to available
```

A payout is never finalised because the create call returned 2xx. If the provider
request is *indeterminate* (timeout, outage, 5xx), the payment stays pending with
its funds still reserved — releasing them could pay the user twice — and is
resolved by the bounded re-check or a webhook.

### Refunds

`POST /api/admin/wallet/refund` keeps its original behaviour (reverse a completed
deposit, or cancel a pending withdrawal and unlock its funds) and now also:

* locks the original transaction and the refund resource before calling the
  provider, so a double refund is impossible (unique refund request key +
  unique `<reference>-REFUND` transaction)
* calls the provider (a Razorpay refund, or a payout cancellation when the
  original is an unsettled payout)
* creates a refund `payment_intent` with the provider reference, a transaction,
  a ledger entry, one notification and an audit entry
* on provider failure writes no wallet mutation and no false `refunded` status —
  it records the provider error for a controlled retry
* partial refunds are **not** implemented (the product model and the adapter both
  refuse them), so `refunded_amount > original_amount` is impossible

### Webhooks

`POST /api/payments/webhook` (provider from the `x-predik-provider` header or
`?provider=`):

1. read the **raw** body (the signature is over the exact bytes)
2. verify authenticity with every configured secret for that provider, using a
   constant-time comparison — an unverifiable delivery is recorded and rejected
   (503 when no secret is configured, 401 otherwise)
3. check the provider event id against `payment_webhook_event` — a delivery that
   was already processed returns 200 with `duplicate: true` and no second effect
4. load the internal payment, validate the expected state, apply the transition
   and (only when appropriate) the wallet/ledger mutation
5. record the outcome; a genuine processing failure returns 500 so the provider
   retries, and the retry is allowed to reprocess exactly once

Implemented Razorpay events:

| Event | Effect |
| --- | --- |
| `payment.authorized` | deposit stays pending (money not captured yet) |
| `payment.captured`, `order.paid` | deposit verified → wallet credit |
| `payment.failed` | deposit failed, no wallet movement |
| `refund.created` | refund processing |
| `refund.processed` | refund settles → wallet/ledger |
| `refund.failed` | refund failed |
| `payout.queued/pending/initiated/processing/updated` | withdrawal pending/processing |
| `payout.processed` | withdrawal completes (locked → spent) |
| `payout.failed`, `payout.reversed` | reservation released |
| `payout.cancelled` | withdrawal cancelled, reservation released |

Out-of-order and contradictory deliveries never overwrite a final state: the
state machine refuses the transition, the payment is flagged for controlled
review, and the delivery is acknowledged so the provider does not retry an
impossible transition forever.

### Idempotency

| Operation | Protection |
| --- | --- |
| Deposit / withdrawal creation | `pg_advisory_xact_lock` per request key + unique `payment_intent (user_id, request_key)` + provider idempotency key `pay:<intentId>` |
| Payout creation | stored `provider_idempotency_key` (UUID) sent as `X-Payout-Idempotency` on every retry |
| Payment / payout settlement | row lock + state-transition assertion + conditional `UPDATE … WHERE status = … RETURNING` |
| Webhook delivery | unique `payment_webhook_event (provider, provider_event_id)` |
| Ledger movement | unique `ledger_entry.reference` / `transaction.reference` |
| Refund | unique refund intent request key (`refund:<transactionId>`) + unique `<reference>-REFUND` transaction |
| One record per provider payment | unique `payment_intent (provider, provider_payment_id)` |

Expected outcome for a repeated event: one economic event, one wallet mutation,
one ledger movement, one notification.

### Bounded re-check (lost webhook recovery)

`lib/payments/recheck.ts` looks up provider truth for payments still open
(`created`/`pending`/`processing`/`verified`):

* at most `RECHECK_POLICY.maxAttempts` (6) lookups per payment, with an
  increasing delay (5 min → 15 min → 1 h → 6 h → 24 h → 72 h)
* never within 5 minutes of creation (the provider's own webhook retry gets first
  refusal)
* each result is applied through the same verified service path a webhook uses, so
  it cannot double-credit
* a payment that is still unclear, missing at the provider, or that reports a
  contradictory state after the budget is spent is **flagged for review** rather
  than retried forever
* a provider outage writes nothing and leaves the payment exactly as it was

`POST /api/admin/payments/recheck` runs it on demand (admin only); the run is
audited.

### Reconciliation and retention

`POST /api/admin/payments/reconciliation` compares internal payments with the
provider's records — through the adapter for each payment's own mode — and
records `matched`, `mismatch`, `missing_provider_record`, `missing_internal_record`,
`status_mismatch`, `amount_mismatch` or `currency_mismatch`. Mismatches are
**never** auto-corrected; they are queued for controlled handling, with a retry
action for the "provider succeeded but settlement did not complete" case.

`GET /api/admin/payments/wallet-audit?userId=…` answers the accounting question
for one account, read-only:

```
completed ledger movements + reserved (pending) movements == available + locked
bonus ledger credit                                      == bonus balance
```

Spendable and promotional buckets are reconciled separately, and a withdrawal
hold is booked as a `pending` debit (confirmed → `completed`, released → voided),
which is why both statuses are summed. A difference is reported with its
components for investigation and is **never** compensated with a balance
adjustment.

`POST /api/admin/payments/retention` (dry run by default) applies
`PAYMENT_RETENTION_POLICY`: handled webhook deliveries after 90 days, rejected
deliveries after 365 days (they are evidence), reconciliation history after 180
days, and reviewed findings after 365 days. Payment, transaction and ledger rows
are the accounting trail and are **never** deleted. Deletions are audited.

### Compliance data boundary

No card numbers, bank credentials or provider secrets are ever stored. Deposits
use provider-hosted collection (payment link by default), so sensitive payment
credentials never pass through Predik; withdrawals store only the payout handle
the user typed and the provider's opaque fund-account id. Webhook storage keeps a
one-way payload fingerprint, never the payload body. There is no KYC document
storage — only the KYC status the compliance process establishes.

### Admin payment operations

`GET /api/admin/payments` returns, for each payment: id, user name/phone, amount,
type, provider, provider payment id and reference, status, timestamps, refund
status, reconciliation status, provider re-check attempts, and the account/KYC
state the payment was made from — plus webhook deliveries, reconciliation runs and
findings, the recent audit trail, and the number of payments awaiting the
provider. Admins can also resolve a withdrawal (complete / fail / cancel),
re-drive a stuck payment, run reconciliation, run the bounded re-check, audit one
account's wallet against its ledger, run a retention dry run or purge, and set
payment-account state. Every one of those is
authorized from the authenticated server session (`isAdmin`), never from the
client.

### Exercising the sandbox flow

Simulator sandbox (`PAYMENTS_MODE=sandbox`, `PAYMENTS_SANDBOX_PROVIDER=simulated`,
`PAYMENTS_WEBHOOK_SECRET_SANDBOX` set):

1. sign in, create a deposit — it returns `pending`
2. as an admin, press **Simulate success** (`POST /api/admin/payments/sandbox`):
   the simulated provider settles and the result is replayed through the real,
   signature-verified webhook path — the wallet is credited only then
3. withdrawals reserve funds at request time; **Complete / Fail / Cancel**
   finalise or release them
4. run **Reconciliation** / **Re-check pending** and inspect webhook deliveries in
   the same panel

Razorpay test mode (`PAYMENTS_MODE=sandbox`, `PAYMENTS_SANDBOX_PROVIDER=razorpay`,
test keys + test webhook secret set): point a Razorpay test-mode webhook at
`https://<host>/api/payments/webhook?provider=razorpay` and use Razorpay test
payment methods. No live money is involved, and the payout leg additionally needs
a RazorpayX test source account.

### Verification

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # unit: state machines, live gate, amounts, signatures, Razorpay mapping/webhook/client, re-check policy
pnpm test:db     # PostgreSQL E2E (requires DATABASE_URL -> a *test* database)
pnpm test:all    # both
pnpm build       # next build
```

#### Database bootstrap

`pnpm db:bootstrap` creates every table the application queries — the core
catalogue/wallet/auth tables **and** the Phase 9 payment tables — from
`lib/db/schema.ts`. The DDL is derived from Drizzle's own table metadata, so it
cannot drift from the schema, and it only ever issues `create table if not
exists` / `create index if not exists`: safe to re-run, never drops or rewrites
data. Requires DDL rights on the database (the same requirement the runtime
`ensurePaymentSchema()` already imposes).

#### PostgreSQL E2E suite (`pnpm test:db`)

These run against a real PostgreSQL database and drive the application's own
modules — the payment service, the provider registry, the webhook core, the
reconciliation/re-check services and the audit log — plus a local stand-in that
speaks Razorpay's HTTP contract. `tests/db/harness.ts` **refuses to reset a
database whose name does not contain `test`**, so the suite cannot touch
production data.

Covered: schema bootstrap idempotency + column-level parity; deposit accounting
(wallet/transaction/ledger/notification/audit) and webhook security (invalid,
missing, malformed, stale and tampered signatures, replay, duplicate and
out-of-order deliveries, amount/currency/association mismatches); withdrawal
reserve → settle/release with duplicate-webhook and race protection
(two simultaneous ₹800 withdrawals on ₹1,000 and three ₹400 attempts on ₹1,000);
idempotency under real concurrency; refunds (async confirmation, double-refund
refusal, provider failure, blocked partials); reconciliation on real data
(matched, amount/currency divergence, missing provider/internal record,
bounded re-check, exhaustion); the live gate (fail-closed, and that no unknown
"enable live" variable opens it); eligibility decisions; authentication/session
data integrity; and a source-level audit of admin authorization, secret
handling, money integrity and logging hygiene.

### Live activation status

**DISABLED — prerequisites not satisfied.** `PAYMENTS_MODE` defaults to `demo`,
`PAYMENTS_LIVE_ACTIVATION` is unset, no compliance acknowledgement/owner/
jurisdiction is configured, and no live provider credentials or payout account
exist in this environment. The gate reports every unmet item to admins, and all
its inputs are non-client, non-admin, environment-level controls.

## Security & production hardening (Phase 10)

The full audit is in [`docs/PHASE-10-SECURITY-REPORT.md`](docs/PHASE-10-SECURITY-REPORT.md):
every finding with its severity, attack scenario, fix and the test that proves the
fix, the adversarial-testing log, the exact verification commands and results,
the production-readiness checklist, the remaining risks and the final security
matrix.

Phase 10 hardened the existing architecture — it did not replace any of it. The
request pipeline is now explicit, and every step is enforced server-side:

```
CLIENT
 ↓  bounded body (Content-Length ceiling)
 ↓  input validation            zod schemas (integer paise, enums, length bounds)
 ↓  authentication             session cookie → `session` row → `user` row
 ↓  authorization              requireAdmin() for privileged routes
 ↓  cross-site check           Origin/Referer must match the request host or a trusted origin
 ↓  rate limit / abuse budget  PostgreSQL counter, atomic upsert, per identity
 ↓  business logic             trading, payments, admin actions
 ↓  database transaction       row locks + conditional updates
 ↓  ledger / audit             append-only accounting + attributed admin actions
 ↓  explicit response shape     no raw rows, no stack traces, no secrets
```

### Authentication and sessions

* The session cookie is `HttpOnly`, `SameSite=Lax` (or `None`+`Secure` behind the
  platform's cross-site preview host), and every request re-resolves the session
  from the `session` row. An expired session is deleted on first use.
* Session *lookup* fails closed: if the cookie store is unavailable the caller is
  treated as unauthenticated instead of producing a 500 from every protected
  route.
* **Admin privilege is configuration, not code.** It used to be a literal phone
  number in `lib/auth/session.ts`; it is now the `ADMIN_PHONES` allowlist
  (`lib/auth/admin.ts`). In production an unset allowlist means *no* admins — the
  fail-closed direction. The development demo number still works locally.
* **Sign-in fails closed in production.** The one-time code was a fixed constant
  (`424242`) for every account in every environment, which is a shared-secret
  login. Production now requires `OTP_FIXED_CODE` (a deployment secret, never
  echoed to the client); otherwise the sign-in endpoint returns **503** instead of
  handing out a documented code. Development still uses the demo code.

Delivering a real OTP requires an SMS/email provider: set `OTP_FIXED_CODE` to a
rotating per-challenge secret once that integration exists. Until then production
sign-in is deliberately unavailable rather than insecure.

### Authorization

Every privileged endpoint authorizes through one server-side gate,
`requireAdmin()` in `lib/security/admin-guard.ts`:

* unauthenticated → **401**, signed-in non-admin → **403**, and both are written
  to `audit_log` (`security.auth.unauthenticated` / `security.authz.denied`) with
  the route and scope, so probing is reviewable after the fact
* the rate-limit budget is charged **after** the role check, so an unauthorized
  flood cannot spend a legitimate operator's allowance or write limiter rows
* routes never re-implement the check and never trust a header, query parameter,
  body field, hidden button or client store value. A test asserts that every
  route under `app/api/admin` calls the gate and returns its refusal response.

### Cross-site request protection (CSRF)

The existing `SameSite` cookie is the first layer. `lib/security/request-origin.ts`
adds a second, independent one: any state-changing request that presents an
`Origin` (or `Referer`) must match the host it was sent to, or an origin from
`TRUSTED_ORIGINS` / the platform's own published preview origins. Requests with no
origin information (curl, scripts, server-to-server) are allowed — a third-party
website cannot forge their absence through a browser. Provider webhooks skip this
check deliberately: they are cross-site by nature and authenticated by signature.

### Rate limiting

`lib/security/rate-limit.ts` implements shared, server-side budgets in PostgreSQL
(the app is horizontally scaled, so an in-process counter would be defeated by
hitting another instance).

* one atomic statement (`insert … on conflict do update returning count`), so two
  simultaneous requests cannot both read a stale count
* keys are SHA-256 digests — the table never becomes a second store of phone
  numbers or IP addresses
* buckets: `otpRequestPhone`, `otpRequestIp`, `otpVerifyPhone`, `otpVerifyIp`,
  `deposit`, `withdrawal`, `trade`, `referralClaim`, `adminAction`, `adminMarket`,
  `webhook`, `accountRead`
* overrides: `RATE_LIMIT_<BUCKET>_LIMIT` / `RATE_LIMIT_<BUCKET>_WINDOW_MS`
* a limiter-store failure **fails open** and logs: failing closed would turn a
  database blip into "nobody can sign in or withdraw". This is a deliberate,
  documented trade-off, and it is safe because the limiter is not an
  authorization control.

OTP verification is budgeted per phone **across challenges**, so requesting a new
code cannot reset the brute-force budget, and the per-challenge attempt cap still
applies. Responses never disclose whether an account exists.

### Payload and input bounds

`assertRequestSize()` rejects an oversized declared body (64 KiB default for JSON
routes) before it is read; the webhook endpoint re-checks the buffered body
against `MAX_WEBHOOK_BYTES` after the rate limit and before any cryptographic
work. Identifiers are length-bounded, money is `int` paise (which also rejects
`NaN`/`Infinity`), share quantities are bounded, and enums are used for methods,
actions and statuses. A test asserts no endpoint reads a balance, role or payment
status from the request body.

### Redirect and URL safety

`lib/security/url-safety.ts`:

* hosted-checkout URLs are only ever returned to the browser when they are
  `https` on an allowlisted provider host, with no embedded credentials — a
  compromised or misconfigured provider response cannot become an open redirect.
  The client re-checks before navigating (defence in depth).
* internal redirect targets must be same-site absolute paths (`safeInternalPath`).
* `isPublicHostname` classifies loopback, private, link-local (cloud metadata),
  reserved and `.internal`/`.local` addresses as unreachable, for any server-side
  fetch of a configured URL.

### Accounting immutability

`ledger_entry` and `transaction` are append-only **in the database itself**
(`lib/db/security-schema.ts` installs `BEFORE UPDATE OR DELETE` triggers):

* `delete` is refused outright
* `user_id`, `amount_paise`, `reference`, `type`, `market_id` and `created_at`
  cannot be rewritten
* only `status` may move, which is exactly what settling or releasing a hold does
  (`pending → completed/failed`)

A correction therefore has to be a compensating entry, and a buggy write cannot
quietly rewrite history. The triggers are part of `pnpm db:bootstrap`, and the
runtime installer retries until the accounting tables exist rather than skipping
them forever.

### Secrets, dependencies and headers

* Secrets are read from the process environment only, per provider and per mode;
  they are stripped from provider error text and never returned by an API.
  `publicPaymentConfig()` exposes mode and readiness, never credentials.
* `.gitignore` now ignores every `.env*` file; `env.example` documents the
  required keys with empty values.
* `shadcn` (a scaffolding CLI) was moved from `dependencies` to
  `devDependencies`. It was being installed into production and accounted for
  roughly 29 of the repository's npm advisories; the production dependency tree
  is now down to 5 advisories, all transitive to the pinned `next` version.
* Response headers add `Content-Security-Policy` (production only), plus
  `X-DNS-Prefetch-Control` and `Origin-Agent-Cluster`; `X-Powered-By` is disabled.

CSP exceptions, deliberate and documented: `script-src 'unsafe-inline'` is
required because the App Router injects inline bootstrap scripts and removing it
needs a nonce issued from middleware (a larger architectural change than this
phase allows); `unsafe-eval` is **not** allowed in production; `img-src` permits
remote `https:` images; the policy is not sent in development because the dev
server needs eval and websockets and Predik's preview runs inside the platform's
frame.

### Security tests

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # unit: includes tests/payments/security-hardening.test.ts
pnpm test:db     # PostgreSQL: includes tests/db/security-runtime.test.ts
pnpm build       # next build
```

`tests/payments/security-hardening.test.ts` (pure): CSRF decisions, checkout URL
and internal-path safety, SSRF host classification, payload ceiling, admin/OTP
configuration, rate-limit policy and key hashing, audit-log anonymisation, and
runtime validation (NaN, Infinity, negatives, fractions, oversized identifiers,
enum membership).

`tests/db/security-runtime.test.ts` (real PostgreSQL, real route handlers): the
401/403/200 authorization matrix from real sessions including expired and forged
ones, refusal logging, client-supplied privilege attempts, atomic rate limiting
under concurrency, 429 + `Retry-After`, withdrawal throttling reserving nothing,
identifier-free counter rows, request guards on real requests, database-enforced
immutability (amount/reference/type/owner/timestamp rewrites and deletes refused,
status transitions still allowed), concurrent buys that cannot overspend,
concurrent sells that cannot oversell, idempotent sell retries, double resolution
paying a winner exactly once, a resolved market refusing further trades, and
wallet balance invariants.

### Production launch (Phase 11)

The launch runbook is [`docs/PRODUCTION-RUNBOOK.md`](docs/PRODUCTION-RUNBOOK.md)
(environment variables, database roles, deployment, monitoring/alerting, backups and
restore verification, disaster recovery, rollback, and the step-by-step live-activation
sequence) and the launch report is
[`docs/PHASE-11-LAUNCH-REPORT.md`](docs/PHASE-11-LAUNCH-REPORT.md).

Three things worth knowing before deploying:

1. **`pnpm preflight`** is the launch gate. It resolves the payment posture from the
   environment it runs in, inspects the real PostgreSQL schema (tables, the
   append-only triggers, the rate-limit store) and sweeps the accounting invariants
   (wallet == ledger, no negative balances, every settled payment has a transaction,
   every completed transaction has a ledger entry). It is read only, never prints a
   secret, and exits non-zero when anything FAILs. It reports `BLOCKED` — never PASS —
   for anything an external dependency prevents it from verifying.
2. **`GET /api/health`** is the production probe: `200` when the process is serving and
   the database answered with the core schema present, `503` otherwise. It also reports
   `payments.mutationBlocked`, so a monitor can page when a live deployment is refusing
   to move money. It never returns a connection string, driver message or stack trace.
3. **A production runtime never silently degrades its payment mode.** Asking for live
   money without satisfying the gate no longer means "runs sandbox and credits anyway":
   the deployment refuses new deposits and withdrawals with
   `503 PAYMENTS_CONFIG_DEGRADED` until it is configured correctly (or the operator
   explicitly acknowledges a simulated deployment with
   `PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION=true`). Webhook settlement and admin refunds
   of payments that already exist still work, so a misconfigured deployment can never
   strand money it has already taken in.

### Production requirements before go-live

1. `pnpm db:bootstrap` (or `DATABASE_SCHEMA_BOOTSTRAP=auto`) — creates the core,
   payment and security objects, including the immutability triggers. On a role
   without DDL rights, run it once as the schema owner and set
   `DATABASE_SCHEMA_BOOTSTRAP=off`.
2. Set `ADMIN_PHONES`. Without it a production deployment has **no admins**.
3. Set `OTP_FIXED_CODE` (or wire a real OTP provider). Without it **sign-in is
   unavailable** in production.
4. Set `DATABASE_URL` and, if a proxy host differs from the app host, add it to
   `TRUSTED_ORIGINS`.
5. Review the transitive `next` advisories reported by `pnpm audit --prod` —
   fixing them requires upgrading `next`, which is outside this phase.
6. Run `pnpm preflight` against the production environment and resolve every FAIL.
   Treat `BLOCKED` as unverified, not as passing.
