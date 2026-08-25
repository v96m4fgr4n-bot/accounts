'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';
import { parseRate } from '@/lib/parse-rate';

export async function recordCustomerPayment(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const currency = String(formData.get('currency'));

  const { error } = await supabase.from('customer_payments').insert({
    tenant_id: String(formData.get('tenant_id')),
    customer_id: String(formData.get('customer_id')),
    cash_day_id: String(formData.get('cash_day_id')),
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/debtors');
}
