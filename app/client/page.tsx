import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';

export default async function ClientHome() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, name, formalization_stage');

  return (
    <main style={{ padding: '2rem', maxWidth: 640 }}>
      <h1>Your business</h1>
      {tenants && tenants.length > 0 ? (
        <ul>
          {tenants.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong> — {t.formalization_stage}
            </li>
          ))}
        </ul>
      ) : (
        <p>No business is linked to this login yet. Contact your consultant.</p>
      )}
      {tenants && tenants.length > 0 && (
        <p>
          <a href="/client/day">Go to today&apos;s cash sheet</a>
        </p>
      )}
    </main>
  );
}
