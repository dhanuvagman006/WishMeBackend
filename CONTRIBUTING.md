# Contributing to the WishMe backend

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the ADRs first. The contract this server honours is the app's
`docs/BACKEND_CONTRACT_INVENTORY.md` (every endpoint the app calls, the fields it sends and the fields it reads).

## Toolchain

- Node 24 in production (Docker); Node 20.11+ works for development. pnpm 10.
- `docker compose -f docker-compose.test.yml up -d` starts Postgres 16 (127.0.0.1:55432) and Redis 7 (:56379).
- `pnpm typecheck`, `pnpm test`, `pnpm test:unit`, `pnpm test:integration`.
- Integration tests rebuild their database on every file (fixtures, then migrations). To run tests in parallel with
  someone else, point `DATABASE_URL` at your own database on the test server, e.g.
  `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/wishme_test_b pnpm vitest run test/integration/x.test.ts`.

## Where things go

| You are adding | Put it in | Wire it in |
| --- | --- | --- |
| Rules for a `/rest/v1` table | `src/compat/postgrest/policies/<domain>.ts` (`tables`) | already exported via `policies/index.ts` |
| A `/rest/v1/rpc/<name>` | same file (`rpcs`) | same |
| An edge-function replacement | `src/compat/functions/handlers/<domain>.ts` (`functions`) | already exported via `functions/index.ts` |
| A Razorpay payment purpose | `src/domains/payments/purposes/<domain>.ts` (`register`) | already called from `purposes.ts` |
| Background work | `src/jobs/processors/<queue>.ts` (`module`) | already listed in `processors/index.ts` |
| A vendor API client | `src/vendors/<vendor>.ts` | construct it with `deps.memo('<vendor>', () => new X(deps.env, deps.log))` |
| Business logic used by several surfaces | `src/domains/<domain>/` | import it |
| Test tables | `test/fixtures/<domain>.sql` | loaded by `test/helpers.ts` |
| Tests | `test/integration/<domain>-*.test.ts`, `test/unit/*.test.ts` | — |

Each table has exactly one policy, in the file listed in [docs/POLICY_OWNERSHIP.md](docs/POLICY_OWNERSHIP.md).

## Rules that are not negotiable

1. **Default deny.** No policy, no access. Grant the narrowest rows and columns the app needs; prefer listing columns
   over `'*'` for anything shared with other users. Use `hiddenColumns` for secrets.
2. **Identity comes from the token.** Ownership predicates use `c.identity.profileId`, `c.identity.celebrityIds` or
   `c.auth.userId`, never an id from the request body or query string. Owner columns on inserts are forced with
   `insert.set`, not accepted from the client.
3. **Money only moves through `deps.ledger` (and `deps.payments` for Razorpay).** Prices come from the database or
   server constants, never from client-sent amounts. Client-written money rows (`wallet_transactions`,
   `payment_transactions`, `payout_requests`, balance columns, order `payment_status`) are intercepted with
   `custom` handlers: genuine debits are executed by the ledger with a balance check; credits and "I paid" claims are
   only accepted when they mirror something the server already did, and then the server's row is returned.
4. **Keep the wire contract.** Same paths, same request fields, same response fields, same status codes, and the same
   words where the app matches error text (see the inventory). When the app's request is wrong or unsafe, fix it on
   the server without changing what the app sees on success.
5. **Vendors through `lib/http.ts` (`vendorFetch`)**: timeouts on every call, retries only for idempotent calls, no
   keys or bodies in logs. A function whose vendor is not configured answers 503 with a clear message.
6. **Validate every body** with zod (`parseBody`) and cap sizes. Rate-limit anything that costs money or sends
   messages (`rateLimit` on the function, or `deps.limiter`).
7. **SQL**: domain code uses postgres.js tagged templates (`deps.db\`…\``); dynamic SQL only through `lib/sql.ts`
   (`sql`, `ident`, `join`). Parameters for json/jsonb/uuid/array columns are cast through text
   (`$1::text::jsonb`), because postgres.js re-serialises values whose type it believes is json.
8. **Idempotency.** Jobs get deterministic `jobId`s; ledger movements get deterministic `idempotencyKey`s where the
   app can retry (e.g. `order:<id>:debit`).
9. Comments explain *why*. No commented-out code. No TODOs without an issue reference.

## Unknowns

The exact Supabase schema, RLS policies and edge-function source arrive with the audit (`scripts/supabase-audit` in
the app repository). Until then, column names come from the inventory, and every assumption about server behaviour is
written down where it is made, with `ASSUMPTION:` in the comment, so it can be checked against the audit.
