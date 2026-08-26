'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';

const APPROVABLE_TABLES = ['purchases', 'supplier_payments', 'casual_labour_payments'] as const;
type ApprovableTable = (typeof APPROVABLE_TABLES)[number];

export async function setApprovalThreshold(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const tenantId = String(formData.get('tenant_id'));
  const decisionType = String(formData.get('decision_type'));
  const currency = String(formData.get('currency'));
  const raw = String(formData.get('threshold_amount') || '').trim();

  if (!raw) {
    const { error } = await supabase
      .from('approval_thresholds')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('decision_type', decisionType)
      .eq('currency', currency);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('approval_thresholds').upsert(
      {
        tenant_id: tenantId,
        decision_type: decisionType,
        currency,
        threshold_amount: Number(raw),
        updated_by: user.id,
      },
      { onConflict: 'tenant_id,decision_type,currency' },
    );
    if (error) throw new Error(error.message);
  }

  revalidatePath('/console/approvals');
}

export async function approveItem(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const table = String(formData.get('table')) as ApprovableTable;
  if (!APPROVABLE_TABLES.includes(table)) throw new Error('Unknown table.');

  const { error } = await supabase
    .from(table)
    .update({ approved_by: user.id, approved_at: new Date().toISOString() })
    .eq('id', String(formData.get('id')));
  if (error) throw new Error(error.message);

  revalidatePath('/console/approvals');
}

export async function signOffStockCount(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase
    .from('stock_counts')
    .update({ signed_off_by: user.id, signed_off_at: new Date().toISOString() })
    .eq('id', String(formData.get('stock_count_id')));
  if (error) throw new Error(error.message);

  revalidatePath('/console/approvals');
}
