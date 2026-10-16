-- Production's trigger_update_wallet_balance / update_wallet_balance(), copied from the audit export (16 Oct 2026).
-- Note what it does NOT do: service_payment, debit, photo_wish, celebrity_call, voice_call, plan_upgrade and earning
-- rows never change the balance, and a negative amount on a debit type credits the user. The ledger must land on the
-- intended balance regardless; tests load this to prove it.
create or replace function public.update_wallet_balance() returns trigger language plpgsql security definer as $$
begin
  if (tg_op = 'INSERT' and new.status = 'completed') then
    if new.transaction_type in ('deposit', 'admin_credit', 'referral_commission') then
      update profiles set wallet_balance = wallet_balance + new.amount where id = new.user_id;
    elsif new.transaction_type in ('withdrawal', 'music_generation', 'music_download', 'greeting_card_generation',
                                   'celebrity_subscription', 'ugc_video', 'image_promotion', 'booking') then
      update profiles set wallet_balance = wallet_balance - new.amount where id = new.user_id;
    end if;
  end if;
  if (tg_op = 'UPDATE' and new.status = 'approved' and old.status = 'pending') then
    update profiles set wallet_balance = wallet_balance + new.amount where id = new.user_id;
    new.status := 'completed';
    new.processed_at := now();
  end if;
  if (tg_op = 'UPDATE' and new.status = 'completed' and old.status != 'completed') then
    if new.transaction_type in ('withdrawal', 'music_generation', 'music_download', 'greeting_card_generation',
                                'celebrity_subscription', 'ugc_video', 'image_promotion', 'booking') then
      update profiles set wallet_balance = wallet_balance - new.amount where id = new.user_id;
    end if;
  end if;
  return new;
end $$;

create trigger trigger_update_wallet_balance before insert or update on public.wallet_transactions
for each row execute function public.update_wallet_balance();
