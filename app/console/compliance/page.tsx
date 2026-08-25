import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatMoney, todayIsoDate } from '@/lib/format';
import {
  addComplianceItem,
  updateComplianceStatus,
  addTaxSetting,
  updateTenantCompliance,
  logPenalty,
} from './actions';

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
      <main style={{ padding: '2rem', maxWidth: 640 }}>
        <h1>Compliance</h1>
        {tenants.length === 0 ? (
          <p>No clients assigned to you yet.</p>
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
      </main>
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
    <main style={{ padding: '2rem', maxWidth: 800 }}>
      <p>
        <a href="/console/compliance">All clients</a>
      </p>
      <h1>{tenant?.name ?? 'Compliance'}</h1>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Formalization</h2>
        <form action={updateTenantCompliance}>
          <input type="hidden" name="tenant_id" value={tenantId} />
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            Stage
            <select name="formalization_stage" defaultValue={tenant?.formalization_stage}>
              <option value="unregistered">Unregistered</option>
              <option value="presumptive">Presumptive tax</option>
              <option value="registered">Formally registered</option>
            </select>
          </label>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <input type="checkbox" name="vat_registered" defaultChecked={tenant?.vat_registered} /> VAT registered
          </label>
          <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
            Save
          </button>
        </form>
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Compliance calendar</h2>
        {!items || items.length === 0 ? (
          <p>Nothing tracked yet.</p>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: '1rem' }}>
            <thead>
              <tr>
                {['Due', 'Type', 'Period', 'Status', 'Note'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.3rem' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const overdue = item.due_date < today && item.status !== 'confirmed' && item.status !== 'filed';
                return (
                  <tr key={item.id} style={overdue ? { color: 'crimson' } : undefined}>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                      {item.due_date}
                      {overdue ? ' (overdue)' : ''}
                    </td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                      {OBLIGATION_TYPES.find((o) => o.value === item.obligation_type)?.label ?? item.obligation_type}
                    </td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{item.period_label ?? '—'}</td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                      <form action={updateComplianceStatus} style={{ display: 'inline' }}>
                        <input type="hidden" name="item_id" value={item.id} />
                        <select name="status" defaultValue={item.status} style={{ padding: '0.2rem' }}>
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s.replace('_', ' ')}
                            </option>
                          ))}
                        </select>
                        <button type="submit" style={{ padding: '0.2rem 0.5rem', marginLeft: '0.3rem' }}>
                          Update
                        </button>
                      </form>
                    </td>
                    <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{item.note ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <form action={addComplianceItem}>
          <input type="hidden" name="tenant_id" value={tenantId} />
          <label style={{ marginRight: '0.5rem' }}>
            <select name="obligation_type" required>
              {OBLIGATION_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <input type="text" name="period_label" placeholder="Period (e.g. 2026-04)" style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <input type="date" name="due_date" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <input type="text" name="note" placeholder="Note (optional)" style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
            Add
          </button>
        </form>
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Tax settings</h2>
        <p style={{ fontSize: '0.9em' }}>
          Shared across every client — confirm current figures with ZIMRA / a registered tax practitioner before
          relying on them.
        </p>
        {latestSettings.size === 0 ? (
          <p>Nothing recorded yet.</p>
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
        <form action={addTaxSetting}>
          <input type="text" name="setting_key" placeholder="setting key (e.g. vat_threshold_usd)" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <input type="number" name="value" step="0.0001" required style={{ padding: '0.4rem', marginRight: '0.5rem', width: '8rem' }} />
          <input type="date" name="effective_from" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <input type="text" name="note" placeholder="Note (optional)" style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
          <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
            Record
          </button>
        </form>
      </section>

      <section>
        <h2>Log a penalty or interest charge</h2>
        <p style={{ fontSize: '0.9em' }}>Tracked separately from ordinary expenses so the cause gets fixed.</p>
        {cashDay && cashDay.status === 'open' ? (
          <form action={logPenalty}>
            <input type="hidden" name="tenant_id" value={tenantId} />
            <input type="hidden" name="cash_day_id" value={cashDay.id} />
            <input type="hidden" name="currency" value={currency} />
            <input type="text" name="description" placeholder="What was it for" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
            <input type="number" name="amount" step="0.01" min="0" placeholder={`Amount (${currency})`} required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
            {currency === 'ZWG' && (
              <input type="number" name="exchange_rate_to_usd" step="0.0001" min="0" placeholder="Rate used today" required style={{ padding: '0.4rem', marginRight: '0.5rem' }} />
            )}
            <button type="submit" style={{ padding: '0.4rem 0.75rem' }}>
              Log
            </button>
          </form>
        ) : (
          <p style={{ fontSize: '0.9em' }}>
            <a href={`/console/compliance?tenant=${tenantId}&currency=${currency}`}>
              Today&apos;s {currency} cash day isn&apos;t open on the client side yet
            </a>{' '}
            — a penalty logs against the day&apos;s till like any other cash-out.
          </p>
        )}
        <nav style={{ marginTop: '0.75rem' }}>
          <a href={`/console/compliance?tenant=${tenantId}&currency=USD`} style={{ marginRight: '1rem', fontWeight: currency === 'USD' ? 'bold' : 'normal' }}>
            USD
          </a>
          <a href={`/console/compliance?tenant=${tenantId}&currency=ZWG`} style={{ fontWeight: currency === 'ZWG' ? 'bold' : 'normal' }}>
            ZWG
          </a>
        </nav>
      </section>
    </main>
  );
}
