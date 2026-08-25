'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';
import { getOrCreateCasualWorkerId } from '@/lib/refs';
import { parseRate } from '@/lib/parse-rate';

export async function logCasualLabourPayment(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const tenantId = String(formData.get('tenant_id'));
  const currency = String(formData.get('currency'));
  const workerName = String(formData.get('worker_name') || '').trim();
  if (!workerName) throw new Error('Enter who was paid.');

  const workerId = await getOrCreateCasualWorkerId(supabase, tenantId, workerName);

  const { error } = await supabase.from('casual_labour_payments').insert({
    tenant_id: tenantId,
    worker_id: workerId,
    cash_day_id: String(formData.get('cash_day_id')),
    description: String(formData.get('description')),
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/client/labour');
}
