export function formatMoney(amount: number, currency: 'USD' | 'ZWG') {
  const symbol = currency === 'USD' ? '$' : 'ZWG ';
  return `${symbol}${amount.toFixed(2)}`;
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function startOfCurrentMonthIsoDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}
