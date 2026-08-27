import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { todayIsoDate } from '@/lib/format';
import {
  addComplianceItem,
  updateComplianceStatus,
  addTaxSetting,
  updateTenantCompliance,
  logPenalty,
} from './actions';
import { StatusBadge } from '@/components/StatusBadge';

const OBLIGATION_TYPES = [
  { value: 'presumptive_tax', label: 'Presumptive tax' },
  { value: 'vat_return', label: 'VAT return' },
  { value: 'paye_return', label: 'PAYE return' },
  { value: 'council_licence_renewal', label: 'Council licence renewal' },
  { value: 'other', label: 'Other' },
];

const STATUSES = ['not_started', 'prepared', 'filed', 'confirmed'];

export default async function CompliancePage({
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
    .select('role, tenants (id, name, formalization_stage, vat_registered)');
  const isConsultant = memberships?.some((m) => m.role === 'consultant') ?? false;
  if (!isConsultant) redirect('/client');

  const tenants = (memberships ?? [])
    .map((m) => (Array.isArray(m.tenants) ? m.tenants[0] : m.tenants))
    .filter((t): t is { id: string; name: string; formalization_stage: string; vat_registered: boolean } =>
      Boolean(t),
    );

  const params = await searchParams;
  const tenantId = params.tenant;
  const currency: 'USD' | 'ZWG' = params.currency === 'ZWG' ? 'ZWG' : 'USD';

  if (!tenantId) {
    return (
      <div className="container-narrow">
        <h1>Compliance</h1>
        {tenants.length === 0 ? (
          <p className="muted">No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/compliance?tenant=${t.id}`}>{t.name}</a>
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

  const [{ data: items }, { data: taxSettings }, { data: cashDay }] = await Promise.all([
    supabase
      .from('compliance_items')
      .select('id, obligation_type, period_label, due_date, status, note')
      .eq('tenant_id', tenantId)
      .order('due_date'),
    supabase
      .from('tax_settings')
      .select('setting_key, value, effective_from, note')
      .order('setting_key')
      .order('effective_from', { ascending: false }),
    supabase
      .from('cash_days')
      .select('id, status')
      .eq('trade_date', todayIsoDate())
      .eq('currency', currency)
      .maybeSingle(),
  ]);

  // Latest tax_settings row per key only.
  const latestSettings = new Map<string, { value: number; effective_from: string; note: string | null }>();
  for (const s of taxSettings ?? []) {
    if (!latestSettings.has(s.setting_key)) latestSettings.set(s.setting_key, s);
  }

  const today = todayIsoDate();

  return (
    <>
      <div className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark" />
          <span>Console</span>
        </div>
        <span className="muted">/ Compliance</span>
      </div>
      <div className="container">
        <p>
          <a href="/console/compliance">All clients</a>
        </p>
        <h1>{tenant?.name ?? 'Compliance'}</h1>

        <section className="card" style={{ marginBottom: '2rem' }}>
          <h2>Formalization</h2>
          <form action={updateTenantCompliance}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <div className="field">
              <span className="field-label">Stage</span>
              <select name="formalization_stage" defaultValue={tenant?.formalization_stage} className="input">
                <option value="unregistered">Unregistered</option>
                <option value="presumptive">Presumptive tax</option>
                <option value="registered">Formally registered</option>
              </select>
            </div>
            <label style={{ display: 'block', marginBottom: '1rem' }}>
              <input type="checkbox" name="vat_registered" defaultChecked={tenant?.vat_registered} /> VAT registered
            </label>
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          </form>
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Compliance calendar</h2>
          {!items || items.length === 0 ? (
            <p className="muted">Nothing tracked yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ marginBottom: '1rem' }}>
                <thead>
                  <tr>
                    {['Due', 'Type', 'Period', 'Status', 'Note'].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const overdue = item.due_date < today && item.status !== 'confirmed' && item.status !== 'filed';
                    const severity = overdue ? 'urgent' : item.status === 'filed' || item.status === 'confirmed' ? 'ok' : 'pending';
                    return (
                      <tr key={item.id}>
                        <td>
                          {item.due_date}
                          {overdue && (
                            <>
                              {' '}
                              <StatusBadge severity="urgent">overdue</StatusBadge>
                            </>
                          )}
                        </td>
                        <td>{OBLIGATION_TYPES.find((o) => o.value === item.obligation_type)?.label ?? item.obligation_type}</td>
                        <td>{item.period_label ?? '—'}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <StatusBadge severity={severity}>{item.status.replace('_', ' ')}</StatusBadge>
                            <form action={updateComplianceStatus} style={{ display: 'flex', gap: '0.3rem' }}>
                              <input type="hidden" name="item_id" value={item.id} />
                              <select name="status" defaultValue={item.status} className="input" style={{ width: 'auto' }}>
                                {STATUSES.map((s) => (
                                  <option key={s} value={s}>
                                    {s.replace('_', ' ')}
                                  </option>
                                ))}
                              </select>
                              <button type="submit" className="btn btn-secondary btn-sm">
                                Update
                              </button>
                            </form>
                          </div>
                        </td>
                        <td>{item.note ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <form action={addComplianceItem} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <select name="obligation_type" required className="input" style={{ width: 'auto' }}>
              {OBLIGATION_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input type="text" name="period_label" placeholder="Period (e.g. 2026-04)" className="input" style={{ width: 'auto' }} />
            <input type="date" name="due_date" required className="input" style={{ width: 'auto' }} />
            <input type="text" name="note" placeholder="Note (optional)" className="input" style={{ width: 'auto' }} />
            <button type="submit" className="btn btn-primary">
              Add
            </button>
          </form>
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2>Tax settings</h2>
          <p className="muted" style={{ fontSize: '0.9em' }}>
            Shared across every client — confirm current figures with ZIMRA / a registered tax practitioner before
            relying on them.
          </p>
          {latestSettings.size === 0 ? (
            <p className="muted">Nothing recorded yet.</p>
          ) : (
            <ul>
              {[...latestSettings.entries()].map(([key, s]) => (
                <li key={key}>
                  <strong>{key}</strong>: {s.value} (effective {s.effective_from}
                  {s.note ? ` — ${s.note}` : ''})
                </li>
              ))}
            </ul>
          )}
          <form action={addTaxSetting} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="text" name="setting_key" placeholder="setting key (e.g. vat_threshold_usd)" required className="input" style={{ width: 'auto' }} />
            <input type="number" name="value" step="0.0001" required className="input" style={{ width: '8rem' }} />
            <input type="date" name="effective_from" required className="input" style={{ width: 'auto' }} />
            <input type="text" name="note" placeholder="Note (optional)" className="input" style={{ width: 'auto' }} />
            <button type="submit" className="btn btn-primary">
              Record
            </button>
          </form>
        </section>

        <section>
          <h2>Log a penalty or interest charge</h2>
          <p className="muted" style={{ fontSize: '0.9em' }}>Tracked separately from ordinary expenses so the cause gets fixed.</p>
          {cashDay && cashDay.status === 'open' ? (
            <form action={logPenalty} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="hidden" name="tenant_id" value={tenantId} />
              <input type="hidden" name="cash_day_id" value={cashDay.id} />
              <input type="hidden" name="currency" value={currency} />
              <input type="text" name="description" placeholder="What was it for" required className="input" style={{ width: 'auto' }} />
              <input type="number" name="amount" step="0.01" min="0" placeholder={`Amount (${currency})`} required className="input" style={{ width: 'auto' }} />
              {currency === 'ZWG' && (
                <input type="number" name="exchange_rate_to_usd" step="0.0001" min="0" placeholder="Rate used today" required className="input" style={{ width: 'auto' }} />
              )}
              <button type="submit" className="btn btn-primary">
                Log
              </button>
            </form>
          ) : (
            <p className="muted" style={{ fontSize: '0.9em' }}>
              <a href={`/console/compliance?tenant=${tenantId}&currency=${currency}`}>
                Today&apos;s {currency} cash day isn&apos;t open on the client side yet
              </a>{' '}
              — a penalty logs against the day&apos;s till like any other cash-out.
            </p>
          )}
          <nav className="nav-tabs" style={{ marginTop: '0.75rem' }}>
            <a href={`/console/compliance?tenant=${tenantId}&currency=USD`} className={`nav-tab ${currency === 'USD' ? 'active' : ''}`}>
              USD
            </a>
            <a href={`/console/compliance?tenant=${tenantId}&currency=ZWG`} className={`nav-tab ${currency === 'ZWG' ? 'active' : ''}`}>
              ZWG
            </a>
          </nav>
        </section>
      </div>
    </>
  );
}
