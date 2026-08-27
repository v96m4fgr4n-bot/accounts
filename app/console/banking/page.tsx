import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatMoney, todayIsoDate } from '@/lib/format';
import { addBankAccount, logBankDeposit, recordReconciliation } from './actions';
import { CurrencyBadge, Money } from '@/components/CurrencyBadge';

export default async function BankingPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; currency?: string }>;
}) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships } = await supabase
    .from('tenant_memberships')
    .select('role, tenants (id, name)');
  const isConsultant = memberships?.some((m) => m.role === 'consultant') ?? false;
  if (!isConsultant) redirect('/client');

  const tenants = (memberships ?? [])
    .map((m) => (Array.isArray(m.tenants) ? m.tenants[0] : m.tenants))
    .filter((t): t is { id: string; name: string } => Boolean(t));

  const params = await searchParams;
  const tenantId = params.tenant;
  const currency: 'USD' | 'ZWG' = params.currency === 'ZWG' ? 'ZWG' : 'USD';

  if (!tenantId) {
    return (
      <div className="container-narrow">
        <h1>Banking</h1>
        {tenants.length === 0 ? (
          <p className="muted">No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/banking?tenant=${t.id}`}>{t.name}</a>
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="/console">Back to console</a>
        </p>
      </div>
    );
  }

  const tenant = tenants.find((t) => t.id === tenantId);

  const { data: bankAccounts } = await supabase
    .from('bank_accounts')
    .select('id, bank_name, account_number, currency, opening_balance, opened_at')
    .eq('tenant_id', tenantId)
    .order('opened_at');

  const balances = await Promise.all(
    (bankAccounts ?? []).map(async (ba) => {
      const { data } = await supabase.rpc('bank_account_balance', { p_bank_account_id: ba.id });
      return { id: ba.id, balance: (data as number) ?? 0 };
    }),
  );
  const balanceById = new Map(balances.map((b) => [b.id, b.balance]));

  const { data: recentReconciliations } = await supabase
    .from('bank_reconciliations')
    .select('id, bank_account_id, statement_date, statement_closing_balance, ledger_balance, note')
    .eq('tenant_id', tenantId)
    .order('statement_date', { ascending: false })
    .limit(10);

  const { data: cashDay } = await supabase
    .from('cash_days')
    .select('id, status')
    .eq('trade_date', todayIsoDate())
    .eq('currency', currency)
    .maybeSingle();

  return (
    <>
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span>Console</span>
        </div>
        <span className="muted">/ Banking</span>
      </div>
      <div className="container">
        <p>
          <a href="/console/banking">All clients</a>
        </p>
        <h1>{tenant?.name ?? 'Banking'}</h1>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Bank accounts</h2>
          {!bankAccounts || bankAccounts.length === 0 ? (
            <p className="muted">No bank account recorded yet — many clients start entirely in cash.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ marginBottom: '1rem' }}>
                <thead>
                  <tr>
                    {['Bank', 'Account', 'Currency', 'Book balance'].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bankAccounts.map((ba) => (
                    <tr key={ba.id}>
                      <td>{ba.bank_name}</td>
                      <td>{ba.account_number}</td>
                      <td>
                        <CurrencyBadge currency={ba.currency} />
                      </td>
                      <td className="money">{formatMoney(balanceById.get(ba.id) ?? 0, ba.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form action={addBankAccount} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <input type="text" name="bank_name" placeholder="Bank name" required className="input" style={{ width: 'auto' }} />
            <input type="text" name="account_number" placeholder="Account number" required className="input" style={{ width: 'auto' }} />
            <select name="currency" className="input" style={{ width: 'auto' }}>
              <option value="USD">USD</option>
              <option value="ZWG">ZWG</option>
            </select>
            <input type="number" name="opening_balance" step="0.01" min="0" placeholder="Opening balance" className="input" style={{ width: '8rem' }} />
            <input type="date" name="opened_at" className="input" style={{ width: 'auto' }} />
            <button type="submit" className="btn btn-primary">
              Add account
            </button>
          </form>
        </section>

        {bankAccounts && bankAccounts.length > 0 && (
          <>
            <section style={{ marginBottom: '2rem' }}>
              <h2>Bank a deposit</h2>
              {cashDay && cashDay.status === 'open' ? (
                <form action={logBankDeposit} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="hidden" name="tenant_id" value={tenantId} />
                  <input type="hidden" name="cash_day_id" value={cashDay.id} />
                  <input type="hidden" name="currency" value={currency} />
                  <select name="bank_account_id" required className="input" style={{ width: 'auto' }}>
                    {bankAccounts
                      .filter((ba) => ba.currency === currency)
                      .map((ba) => (
                        <option key={ba.id} value={ba.id}>
                          {ba.bank_name} ({ba.account_number})
                        </option>
                      ))}
                  </select>
                  <input type="number" name="amount" step="0.01" min="0" placeholder={`Amount (${currency})`} required className="input" style={{ width: 'auto' }} />
                  {currency === 'ZWG' && (
                    <input type="number" name="exchange_rate_to_usd" step="0.0001" min="0" placeholder="Rate used today" required className="input" style={{ width: 'auto' }} />
                  )}
                  <button type="submit" className="btn btn-primary">
                    Log deposit
                  </button>
                </form>
              ) : (
                <p className="muted" style={{ fontSize: '0.9em' }}>
                  Today&apos;s {currency} cash day isn&apos;t open on the client side yet — a deposit logs against the
                  day&apos;s till like any other cash-out.
                </p>
              )}
              <nav className="nav-tabs" style={{ marginTop: '0.5rem' }}>
                <a href={`/console/banking?tenant=${tenantId}&currency=USD`} className={`nav-tab ${currency === 'USD' ? 'active' : ''}`}>
                  USD
                </a>
                <a href={`/console/banking?tenant=${tenantId}&currency=ZWG`} className={`nav-tab ${currency === 'ZWG' ? 'active' : ''}`}>
                  ZWG
                </a>
              </nav>
            </section>

            <section>
              <h2>Reconciliation</h2>
              {recentReconciliations && recentReconciliations.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ marginBottom: '1rem' }}>
                    <thead>
                      <tr>
                        {['Date', 'Bank', 'Statement', 'Books', 'Variance'].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {recentReconciliations.map((r) => {
                        const ba = bankAccounts.find((b) => b.id === r.bank_account_id);
                        const baCurrency = ba?.currency ?? 'USD';
                        const variance = r.statement_closing_balance - (r.ledger_balance ?? 0);
                        return (
                          <tr key={r.id}>
                            <td>{r.statement_date}</td>
                            <td>{ba?.bank_name}</td>
                            <td>
                              <Money amount={r.statement_closing_balance} currency={baCurrency} />
                            </td>
                            <td>
                              <Money amount={r.ledger_balance ?? 0} currency={baCurrency} />
                            </td>
                            <td>
                              {variance !== 0 ? (
                                <Money amount={variance} currency={baCurrency} />
                              ) : (
                                <span className="muted">matched</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <form action={recordReconciliation} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <input type="hidden" name="tenant_id" value={tenantId} />
                <select name="bank_account_id" required className="input" style={{ width: 'auto' }}>
                  {bankAccounts.map((ba) => (
                    <option key={ba.id} value={ba.id}>
                      {ba.bank_name} ({ba.account_number})
                    </option>
                  ))}
                </select>
                <input type="date" name="statement_date" required className="input" style={{ width: 'auto' }} />
                <input type="number" name="statement_closing_balance" step="0.01" placeholder="Statement closing balance" required className="input" style={{ width: 'auto' }} />
                <input type="text" name="note" placeholder="Note (optional)" className="input" style={{ width: 'auto' }} />
                <button type="submit" className="btn btn-primary">
                  Record
                </button>
              </form>
            </section>
          </>
        )}
      </div>
    </>
  );
}
