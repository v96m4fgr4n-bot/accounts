'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';
import { parseRate } from '@/lib/parse-rate';

export async function recordSupplierPayment(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const currency = String(formData.get('currency'));

  const { error } = await supabase.from('supplier_payments').insert({
    tenant_id: String(formData.get('tenant_id')),
    supplier_id: String(formData.get('supplier_id')),
    cash_day_id: String(formData.get('cash_day_id')),
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/creditors');
}
