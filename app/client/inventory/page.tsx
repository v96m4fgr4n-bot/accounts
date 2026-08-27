import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { getPrimaryTenant } from '@/lib/tenant';
import { StatusBadge } from '@/components/StatusBadge';
import { addInventoryItem, logStockCount } from './actions';

export default async function InventoryPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const tenant = await getPrimaryTenant(supabase);
  if (!tenant) {
    return (
      <main className="container-narrow">
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>No business is linked to this login yet. Contact your consultant.</p>
        </div>
      </main>
    );
  }

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure, reorder_point')
    .order('name');

  const { data: recentCounts } = await supabase
    .from('stock_counts')
    .select('id, inventory_item_id, counted_quantity, counted_at, note')
    .order('counted_at', { ascending: false })
    .limit(20);

  const latestCountByItem = new Map<string, { counted_quantity: number; counted_at: string }>();
  for (const c of recentCounts ?? []) {
    if (!latestCountByItem.has(c.inventory_item_id)) {
      latestCountByItem.set(c.inventory_item_id, c);
    }
  }

  return (
    <main className="container-narrow">
      <p className="muted" style={{ marginBottom: 0 }}>{tenant.name}</p>
      <h1 style={{ marginTop: '0.25rem' }}>Stock</h1>

      {items && items.length > 0 ? (
        <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '1.5rem' }}>
          {items.map((item) => {
            const latest = latestCountByItem.get(item.id);
            const low =
              item.reorder_point != null &&
              latest != null &&
              latest.counted_quantity <= item.reorder_point;
            return (
              <div key={item.id} className="card">
                <strong>{item.name}</strong>
                {item.unit_of_measure ? <span className="muted"> ({item.unit_of_measure})</span> : ''}
                <div style={{ marginTop: '0.3rem' }}>
                  {latest ? (
                    <span className="muted">
                      last counted {latest.counted_quantity} on{' '}
                      {latest.counted_at.slice(0, 10)}
                    </span>
                  ) : (
                    <span className="muted">not counted yet</span>
                  )}
                  {low ? (
                    <span style={{ marginLeft: '0.5rem' }}>
                      <StatusBadge severity="urgent">Reorder soon</StatusBadge>
                    </span>
                  ) : null}
                </div>
                <form action={logStockCount} style={{ marginTop: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' }}>
                  <input type="hidden" name="tenant_id" value={tenant.id} />
                  <input type="hidden" name="inventory_item_id" value={item.id} />
                  <input
                    type="number"
                    name="counted_quantity"
                    step="0.01"
                    min="0"
                    placeholder="Count now"
                    required
                    className="input input-inline"
                    style={{ width: '8rem' }}
                  />
                  <input
                    type="text"
                    name="note"
                    placeholder="Note (optional)"
                    className="input input-inline"
                  />
                  <button type="submit" className="btn btn-primary btn-sm">
                    Log count
                  </button>
                </form>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">No stock items yet.</p>
      )}

      <section className="card">
        <h2>Add a stock item</h2>
        <form action={addInventoryItem}>
          <input type="hidden" name="tenant_id" value={tenant.id} />
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" name="name" required className="input" />
          </label>
          <label className="field">
            <span className="field-label">Unit (e.g. each, box, kg)</span>
            <input type="text" name="unit_of_measure" className="input" />
          </label>
          <label className="field">
            <span className="field-label">Reorder when stock falls to</span>
            <input type="number" name="reorder_point" step="0.01" min="0" className="input" />
          </label>
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
            Add item
          </button>
        </form>
      </section>
    </main>
  );
}
