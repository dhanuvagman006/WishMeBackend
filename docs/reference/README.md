# Reference snapshots

Copies of two documents from the app repository (`Sdata0605/wishme-mobile-app`, branch
`claude/backend-migration-plan-f28c94`), taken on 16 Oct 2026 so this repository is self-contained:

- `BACKEND_CONTRACT_INVENTORY.md`: every endpoint the app calls, with the request fields it sends and the response
  fields it reads. This is the contract the compat surface implements. File paths in it are relative to the app repo.
- `BACKEND_MIGRATION_PLAN.md`: the migration plan. This backend follows its phasing, shared-database strategy and
  money rules; it differs in one deliberate way, documented in `docs/adr/0001-supabase-compatible-gateway.md`: the
  app keeps speaking the Supabase protocol, so it needs no code changes to switch.

The originals in the app repository are the ones to update; refresh these copies when they change.
