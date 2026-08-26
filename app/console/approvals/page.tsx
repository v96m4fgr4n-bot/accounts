import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { formatMoney } from '@/lib/format';
import { setApprovalThreshold, approveItem, signOffStockCount } from './actions';

const DECISION_TYPES = [
  { value: 'credit_purchase', label: 'Credit purchase' },
  { value: 'supplier_payment', label: 'Supplier payment' },
  { value: 'casual_labour', label: 'Casual labour payment' },
];

type Purchase = {
  id: string;
  description: string;
  amount: number;
  currency: 'USD' | 'ZWG';
  purchased_at: string;
  supplier: string | null;
};
type SupplierPayment = {
  id: string;
  amount: number;
  currency: 'USD' | 'ZWG';
  paid_at: string;
  suppliers: { name: string } | { name: string }[] | null;
};
type CasualLabourPayment = {
  id: string;
  description: string;
  amount: number;
  currency: 'USD' | 'ZWG';
  paid_at: string;
  casual_workers: { name: string } | { name: string }[] | null;
};
type StockCount = {
  id: string;
  counted_quantity: number;
  counted_at: string;
  inventory_items: { name: string } | { name: string }[] | null;
};

function oneName(rel: { name: string } | { name: string }[] | null) {
  return (Array.isArray(rel) ? rel[0] : rel)?.name ?? '—';
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
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

  if (!tenantId) {
    return (
      <main style={{ padding: '2rem', maxWidth: 640 }}>
        <h1>Approvals</h1>
        {tenants.length === 0 ? (
          <p>No clients assigned to you yet.</p>
        ) : (
          <ul>
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/console/approvals?tenant=${t.id}`}>{t.name}</a>
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

  const [{ data: thresholds }, { data: purchases }, { data: supplierPayments }, { data: casualLabour }, { data: stockCounts }] =
    await Promise.all([
      supabase
        .from('approval_thresholds')
        .select('decision_type, currency, threshold_amount')
        .eq('tenant_id', tenantId),
      supabase
        .from('purchases')
        .select('id, description, amount, currency, purchased_at, supplier')
        .eq('tenant_id', tenantId)
        .eq('needs_approval', true)
        .is('approved_by', null)
        .order('purchased_at'),
      supabase
        .from('supplier_payments')
        .select('id, amount, currency, paid_at, suppliers (name)')
        .eq('tenant_id', tenantId)
        .eq('needs_approval', true)
        .is('approved_by', null)
        .order('paid_at'),
      supabase
        .from('casual_labour_payments')
        .select('id, description, amount, currency, paid_at, casual_workers (name)')
        .eq('tenant_id', tenantId)
        .eq('needs_approval', true)
        .is('approved_by', null)
        .order('paid_at'),
      supabase
        .from('stock_counts')
        .select('id, counted_quantity, counted_at, inventory_items (name)')
        .eq('tenant_id', tenantId)
        .is('signed_off_by', null)
        .order('counted_at'),
    ]);

  const thresholdMap = new Map((thresholds ?? []).map((t) => [`${t.decision_type}:${t.currency}`, t.threshold_amount]));

  return (
    <main style={{ padding: '2rem', maxWidth: 900 }}>
      <p>
        <a href="/console/approvals">All clients</a>
      </p>
      <h1>{tenant?.name ?? 'Approvals'}</h1>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Approval thresholds</h2>
        <p style={{ fontSize: '0.9em' }}>
          Transactions over these amounts are flagged for your review after posting — the client&apos;s own daily
          cash-sheet review stays the primary control below any threshold. Leave a decision type/currency unset for
          no flagging.
        </p>
        <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: '1rem' }}>
          <thead>
            <tr>
              {['Decision', 'Currency', 'Threshold'].map((h) => (
                <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.3rem' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DECISION_TYPES.flatMap((d) =>
              (['USD', 'ZWG'] as const).map((currency) => (
                <tr key={`${d.value}:${currency}`}>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{d.label}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{currency}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                    <form action={setApprovalThreshold} style={{ display: 'flex', gap: '0.4rem' }}>
                      <input type="hidden" name="tenant_id" value={tenantId} />
                      <input type="hidden" name="decision_type" value={d.value} />
                      <input type="hidden" name="currency" value={currency} />
                      <input
                        type="number"
                        name="threshold_amount"
                        step="0.01"
                        min="0.01"
                        defaultValue={thresholdMap.get(`${d.value}:${currency}`) ?? ''}
                        placeholder="unset"
                        style={{ padding: '0.2rem', width: '7rem' }}
                      />
                      <button type="submit" style={{ padding: '0.2rem 0.5rem' }}>
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>Pending approvals</h2>
        {!purchases?.length && !supplierPayments?.length && !casualLabour?.length ? (
          <p>Nothing flagged for review.</p>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['Type', 'Date', 'Detail', 'Amount', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.3rem' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(purchases as Purchase[] | null ?? []).map((p) => (
                <tr key={p.id}>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>Credit purchase</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{p.purchased_at.slice(0, 10)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                    {p.description}
                    {p.supplier ? ` (${p.supplier})` : ''}
                  </td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{formatMoney(p.amount, p.currency)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                    <ApproveForm table="purchases" id={p.id} tenantId={tenantId} />
                  </td>
                </tr>
              ))}
              {(supplierPayments as SupplierPayment[] | null ?? []).map((sp) => (
                <tr key={sp.id}>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>Supplier payment</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{sp.paid_at.slice(0, 10)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{oneName(sp.suppliers)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{formatMoney(sp.amount, sp.currency)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                    <ApproveForm table="supplier_payments" id={sp.id} tenantId={tenantId} />
                  </td>
                </tr>
              ))}
              {(casualLabour as CasualLabourPayment[] | null ?? []).map((cl) => (
                <tr key={cl.id}>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>Casual labour</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{cl.paid_at.slice(0, 10)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                    {cl.description} ({oneName(cl.casual_workers)})
                  </td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{formatMoney(cl.amount, cl.currency)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                    <ApproveForm table="casual_labour_payments" id={cl.id} tenantId={tenantId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Stock counts awaiting sign-off</h2>
        {!stockCounts?.length ? (
          <p>Nothing awaiting sign-off.</p>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['Item', 'Counted', 'Quantity', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.3rem' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(stockCounts as StockCount[]).map((sc) => (
                <tr key={sc.id}>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{oneName(sc.inventory_items)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{sc.counted_at.slice(0, 10)}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>{sc.counted_quantity}</td>
                  <td style={{ padding: '0.3rem', borderBottom: '1px solid #eee' }}>
                    <form action={signOffStockCount}>
                      <input type="hidden" name="stock_count_id" value={sc.id} />
                      <input type="hidden" name="tenant_id" value={tenantId} />
                      <button type="submit" style={{ padding: '0.2rem 0.5rem' }}>
                        Sign off
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function ApproveForm({ table, id, tenantId }: { table: string; id: string; tenantId: string }) {
  return (
    <form action={approveItem}>
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="tenant_id" value={tenantId} />
      <button type="submit" style={{ padding: '0.2rem 0.5rem' }}>
        Approve
      </button>
    </form>
  );
}
