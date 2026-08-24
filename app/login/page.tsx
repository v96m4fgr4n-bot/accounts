'use client';

import { useState } from 'react';
import { createBrowserSupabase } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) setErr(error.message);
    else setSent(true);
  }

  if (sent) {
    return (
      <main style={{ padding: '2rem', maxWidth: 480 }}>
        <p>Check your email for a sign-in link.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: '2rem', maxWidth: 480 }}>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label style={{ display: 'block', marginBottom: '0.5rem' }}>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: 'block', width: '100%', padding: '0.5rem' }}
          />
        </label>
        <button type="submit" style={{ padding: '0.5rem 1rem' }}>
          Send sign-in link
        </button>
        {err ? <p style={{ color: 'crimson' }}>{err}</p> : null}
      </form>
    </main>
  );
}
