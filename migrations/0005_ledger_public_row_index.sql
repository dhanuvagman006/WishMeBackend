-- Lookup from a public history row (wallet_transactions / celebrity_wallet_transactions id) back to the ledger entry
-- that wrote it. Used by the nightly invariant check to tell ledger movements from legacy trigger movements.
create index if not exists ledger_entries_public_row_idx on wishme.ledger_entries (public_row_id) where public_row_id is not null;
