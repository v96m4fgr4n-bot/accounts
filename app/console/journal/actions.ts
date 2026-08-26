'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';

export async function reverseJournalEntry(formData: FormData) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { error } = await supabase.rpc('reverse_journal', {
    p_journal_entry_id: String(formData.get('journal_entry_id')),
    p_reason: String(formData.get('reason')),
  });
  if (error) throw new Error(error.message);

  revalidatePath('/console/journal');
}
