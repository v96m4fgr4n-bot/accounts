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

  return (
    <div className="theme-client" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <main className="container-narrow" style={{ width: '100%' }}>
        <div className="card">
          {sent ? (
            <>
              <h1 style={{ fontSize: '1.4rem', margin: '0 0 0.5rem' }}>Check your email</h1>
              <p className="muted" style={{ margin: 0 }}>We&apos;ve sent a sign-in link to {email}.</p>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: '1.4rem', margin: '0 0 1.25rem' }}>Sign in</h1>
              <form onSubmit={submit}>
                <label className="field">
                  <span className="field-label">Email</span>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input"
                  />
                </label>
                <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                  Send sign-in link
                </button>
                {err ? (
                  <p style={{ color: 'oklch(45% 0.18 25)', marginTop: '0.75rem', marginBottom: 0 }}>{err}</p>
                ) : null}
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
