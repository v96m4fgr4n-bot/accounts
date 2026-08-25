import type { SupabaseClient } from '@supabase/supabase-js';

export async function getPrimaryTenant(supabase: SupabaseClient) {
  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('tenant_id, role, tenants (id, name, formalization_stage)')
    .order('created_at', { ascending: true })
    .limit(1);

  const membership = memberships?.[0];
  if (!membership) return null;

  const tenant = Array.isArray(membership.tenants)
    ? membership.tenants[0]
    : membership.tenants;

  return tenant
    ? { id: tenant.id as string, name: tenant.name as string }
    : null;
}
