'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';
import { parseRate } from '@/lib/parse-rate';

export async function addBankAccount(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.from('bank_accounts').insert({
    tenant_id: String(formData.get('tenant_id')),
    bank_name: String(formData.get('bank_name')),
    account_number: String(formData.get('account_number')),
    currency: String(formData.get('currency')),
    opening_balance: Number(formData.get('opening_balance') || 0),
    opened_at: String(formData.get('opened_at') || new Date().toISOString().slice(0, 10)),
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/banking');
}

export async function logBankDeposit(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const currency = String(formData.get('currency'));

  const { error } = await supabase.from('bank_deposits').insert({
    tenant_id: String(formData.get('tenant_id')),
    bank_account_id: String(formData.get('bank_account_id')),
    cash_day_id: String(formData.get('cash_day_id')),
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/banking');
}

export async function recordReconciliation(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.from('bank_reconciliations').insert({
    tenant_id: String(formData.get('tenant_id')),
    bank_account_id: String(formData.get('bank_account_id')),
    statement_date: String(formData.get('statement_date')),
    statement_closing_balance: Number(formData.get('statement_closing_balance')),
    note: String(formData.get('note') || '') || null,
    reconciled_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/banking');
}
