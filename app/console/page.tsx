import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';

export default async function ConsoleHome() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('role');
  const isConsultant = memberships?.some((m) => m.role === 'consultant') ?? false;
  if (!isConsultant) redirect('/client');

  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, formalization_stage');

  return (
    <main style={{ padding: '2rem', maxWidth: 960 }}>
      <h1>Console</h1>
      <p>Signed in as {user.email}.</p>
      <h2>Assigned clients</h2>
      {tenants && tenants.length > 0 ? (
        <ul>
          {tenants.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong> — {t.formalization_stage}
            </li>
          ))}
        </ul>
      ) : (
        <p>No clients assigned to you yet.</p>
      )}
    </main>
  );
}
