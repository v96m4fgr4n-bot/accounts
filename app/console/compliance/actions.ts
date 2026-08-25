'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';
import { parseRate } from '@/lib/parse-rate';

export async function addComplianceItem(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.from('compliance_items').insert({
    tenant_id: String(formData.get('tenant_id')),
    obligation_type: String(formData.get('obligation_type')),
    period_label: String(formData.get('period_label') || '') || null,
    due_date: String(formData.get('due_date')),
    note: String(formData.get('note') || '') || null,
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/compliance');
}

export async function updateComplianceStatus(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase
    .from('compliance_items')
    .update({ status: String(formData.get('status')) })
    .eq('id', String(formData.get('item_id')));
  if (error) throw new Error(error.message);

  revalidatePath('/console/compliance');
}

export async function addTaxSetting(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.from('tax_settings').insert({
    setting_key: String(formData.get('setting_key')),
    value: Number(formData.get('value')),
    effective_from: String(formData.get('effective_from')),
    note: String(formData.get('note') || '') || null,
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/compliance');
}

export async function updateTenantCompliance(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase
    .from('tenants')
    .update({
      formalization_stage: String(formData.get('formalization_stage')),
      vat_registered: formData.get('vat_registered') === 'on',
    })
    .eq('id', String(formData.get('tenant_id')));
  if (error) throw new Error(error.message);

  revalidatePath('/console/compliance');
}

export async function logPenalty(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const currency = String(formData.get('currency'));
  const complianceItemId = String(formData.get('compliance_item_id') || '');

  const { error } = await supabase.from('compliance_penalties').insert({
    tenant_id: String(formData.get('tenant_id')),
    cash_day_id: String(formData.get('cash_day_id')),
    compliance_item_id: complianceItemId || null,
    description: String(formData.get('description')),
    amount: Number(formData.get('amount')),
    currency,
    exchange_rate_to_usd: parseRate(currency, formData),
    recorded_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/compliance');
}
