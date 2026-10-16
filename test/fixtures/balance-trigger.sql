-- Optional: emulates the Supabase trigger that is believed to keep profiles.wallet_balance in step with
-- wallet_transactions (credit types add, debit types subtract |amount|, completed rows only). Loaded by tests that
-- check the ledger's self-correction with and without a trigger.
create or replace function public.apply_wallet_transaction() returns trigger language plpgsql as $$
begin
  if new.status <> 'completed' then return new; end if;
  if new.transaction_type in ('deposit', 'admin_credit', 'commission_earning', 'referral_commission', 'refund') then
    update public.profiles set wallet_balance = wallet_balance + abs(new.amount) where id = new.user_id;
  else
    update public.profiles set wallet_balance = wallet_balance - abs(new.amount) where id = new.user_id;
  end if;
  return new;
end $$;

create trigger wallet_transactions_apply after insert on public.wallet_transactions
for each row execute function public.apply_wallet_transaction();
