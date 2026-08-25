'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';

export async function addAsset(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.from('assets').insert({
    tenant_id: String(formData.get('tenant_id')),
    name: String(formData.get('name')),
    cost: Number(formData.get('cost')),
    currency: String(formData.get('currency')),
    acquired_at: String(formData.get('acquired_at')),
    useful_life_months: Number(formData.get('useful_life_months')),
    created_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/assets');
}

export async function runDepreciation(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.rpc('run_asset_depreciation', {
    p_asset_id: String(formData.get('asset_id')),
    p_period_through: String(formData.get('period_through')),
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/assets');
}

export async function disposeAsset(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.rpc('dispose_asset', {
    p_asset_id: String(formData.get('asset_id')),
    p_disposed_at: String(formData.get('disposed_at')),
    p_proceeds: Number(formData.get('proceeds') || 0),
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/assets');
}
