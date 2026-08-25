'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';

export async function closePeriod(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const tenantId = String(formData.get('tenant_id'));
  const closedThrough = String(formData.get('closed_through'));
  const note = String(formData.get('note') || '') || null;

  const { error } = await supabase.from('period_closes').insert({
    tenant_id: tenantId,
    closed_through: closedThrough,
    closed_by: user.id,
    note,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/reports');
}
