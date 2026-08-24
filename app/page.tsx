import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';

export default async function Home() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  // RLS restricts this to the caller's own memberships, so a user with
  // any consultant role anywhere lands in the console; otherwise the
  // client app.
  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('role');

  const hasConsultantRole = memberships?.some((m) => m.role === 'consultant');
  redirect(hasConsultantRole ? '/console' : '/client');
}
