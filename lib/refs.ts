import type { SupabaseClient } from '@supabase/supabase-js';

// Customers/suppliers are created implicitly the first time the app
// looks one up by name and doesn't find it — same "no separate setup
// step" spirit as the rest of the client app (CLAUDE.md: no accounting
// jargon, no extra ceremony for a solo owner).

export async function getOrCreateCustomerId(
  supabase: SupabaseClient,
  tenantId: string,
  name: string,
) {
  const { data: existing } = await supabase
    .from('customers')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await supabase
    .from('customers')
    .insert({ tenant_id: tenantId, name })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return created.id as string;
}

export async function getOrCreateSupplierId(
  supabase: SupabaseClient,
  tenantId: string,
  name: string,
) {
  const { data: existing } = await supabase
    .from('suppliers')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await supabase
    .from('suppliers')
    .insert({ tenant_id: tenantId, name })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return created.id as string;
}
