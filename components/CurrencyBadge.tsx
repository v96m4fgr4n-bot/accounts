export function CurrencyBadge({ currency }: { currency: 'USD' | 'ZWG' }) {
  return <span className={currency === 'USD' ? 'badge badge-usd' : 'badge badge-zwg'}>{currency}</span>;
}

export function Money({ amount, currency }: { amount: number; currency: 'USD' | 'ZWG' }) {
  const symbol = currency === 'USD' ? '$' : 'ZWG ';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <span className="money">
        {symbol}
        {amount.toFixed(2)}
      </span>
      <CurrencyBadge currency={currency} />
    </span>
  );
}
