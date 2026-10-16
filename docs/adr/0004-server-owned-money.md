# ADR 0004: The server owns every money movement

Date: 2026-10-16. Status: accepted.

## Context

Today the phone inserts `wallet_transactions`, `payment_transactions` and `payout_requests`, PATCHes
`celebrities.available_balance` and `profiles.plan`, and computes prices and fees. `verify-razorpay-payment` only checks
a signature. Anyone with a valid session and a REST client can credit their own wallet if RLS allows inserts.

## Decision

- Amounts are integer paise in the server and in the `wishme.ledger_entries` table. Rupee columns in `public` tables
  are written by the server from paise.
- Credits happen only in server code paths: Razorpay fulfilment (signature check on the callback **and** the webhook,
  idempotent on the payment id), referral commission, refunds, admin adjustments.
- Debits requested by the app are accepted only as debits, under a row lock on the wallet, with a sufficient-balance
  check, and recorded with an idempotency key.
- Compat inserts of credit rows are never executed as written. When they mirror a payment the server already fulfilled,
  the server's row is returned so the app's flow completes; otherwise they are rejected.
- Payouts are requests: the server checks and holds the balance, an admin approves, a job executes.
- Every movement is one ledger row with a unique idempotency key; nightly reconciliation checks the ledger against
  Razorpay and against the balance columns.

## Consequences

Old builds that rely on client-side credits keep working for paid flows (the server already credited them) and stop
working for forged credits, which is the point. Plan and order fulfilment logic now lives in `src/domains/`.
