import type { SupabaseClient } from '@supabase/supabase-js';

// Customers/suppliers/casual workers are created implicitly the first
// time the app looks one up by name and doesn't find it — same "no
// separate setup step" spirit as the rest of the client app (CLAUDE.md:
// no accounting jargon, no extra ceremony for a solo owner).

async function getOrCreateByName(
  supabase: SupabaseClient,
  table: string,
  tenantId: string,
  name: string,
) {
  const { data: existing } = await supabase
    .from(table)
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await supabase
    .from(table)
    .insert({ tenant_id: tenantId, name })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return created.id as string;
}

export async function getOrCreateCustomerId(supabase: SupabaseClient, tenantId: string, name: string) {
  return getOrCreateByName(supabase, 'customers', tenantId, name);
}

export async function getOrCreateSupplierId(supabase: SupabaseClient, tenantId: string, name: string) {
  return getOrCreateByName(supabase, 'suppliers', tenantId, name);
}

export async function getOrCreateCasualWorkerId(supabase: SupabaseClient, tenantId: string, name: string) {
  return getOrCreateByName(supabase, 'casual_workers', tenantId, name);
}
