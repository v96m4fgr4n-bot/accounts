-- Phase 3 (part 3): Basic Inventory (Blueprint §6.1, §6.2, §6.4).
--
-- Deliberately scoped to an item master + recorded stock counts, with NO
-- automatic quantity-on-hand tracking and NO auto-posted count-adjustment
-- journal. Both are flagged in docs/erp-blueprint.md rather than silently
-- built partially or wrong:
--
--   - Perpetual quantity tracking would mean every sale references
--     specific inventory_items with quantities sold. Phase 1/2 sales are
--     intentionally free-text ("what was sold") — line-item capture is
--     §4.2's POS upgrade, explicitly "optional, later stage" in the
--     Blueprint. Building quantity deduction now would mean either a
--     bigger rework of the sales flow than this phase's scope, or a
--     shadow tracking system disconnected from what's actually captured.
--   - §6.4's `DR Inventory / CR Inventory Adjustment` pattern needs a
--     system-computed "expected" figure to diff the physical count
--     against. The GL's Inventory account balance could stand in for
--     that (it only ever increases from purchases, since no COGS is
--     posted yet — see the §4.2 note added in Phase 2) but a count-vs-
--     book variance computed that way would conflate real shrinkage with
--     the COGS that was never relieved from the account — actively
--     misleading if posted as a P&L gain/loss. Recording the count as a
--     snapshot (§6.4's own "investigate before adjusting") without
--     auto-posting is the honest default until real quantity tracking
--     exists.

create table inventory_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  name             text not null,
  unit_of_measure  text,
  reorder_point    numeric(14, 2) check (reorder_point >= 0),
  cost_price       numeric(14, 2) check (cost_price >= 0),
  selling_price    numeric(14, 2) check (selling_price >= 0),
  created_at       timestamptz not null default now(),

  unique (tenant_id, name)
);

create index inventory_items_tenant_idx on inventory_items (tenant_id);

create table stock_counts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete restrict,
  inventory_item_id   uuid not null references inventory_items(id) on delete restrict,
  counted_at          timestamptz not null default now(),
  counted_quantity    numeric(14, 2) not null check (counted_quantity >= 0),
  -- §6.4: solo-owner compensating control is a timestamped photo of the
  -- count sheet/shelves in place of a second counter. Supabase Storage
  -- integration isn't wired up yet (no bucket/upload flow exists in this
  -- phase) — this holds a URL once that exists; NULL is a valid count
  -- today, not an error.
  photo_url           text,
  note                text,
  recorded_by         uuid not null references auth.users(id),
  created_at          timestamptz not null default now()
);

create index stock_counts_item_idx on stock_counts (inventory_item_id);
create index stock_counts_tenant_counted_at_idx on stock_counts (tenant_id, counted_at desc);

alter table inventory_items enable row level security;
alter table stock_counts    enable row level security;

alter table inventory_items force row level security;
alter table stock_counts    force row level security;

create policy inventory_items_select_members on inventory_items for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy inventory_items_insert_members on inventory_items for insert
  to authenticated with check (public.is_tenant_member(tenant_id));

create policy stock_counts_select_members on stock_counts for select
  to authenticated using (public.is_tenant_member(tenant_id));
create policy stock_counts_insert_members on stock_counts for insert
  to authenticated with check (public.is_tenant_member(tenant_id) and recorded_by = auth.uid());
