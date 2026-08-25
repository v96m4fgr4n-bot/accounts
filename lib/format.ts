export function formatMoney(amount: number, currency: 'USD' | 'ZWG') {
  const symbol = currency === 'USD' ? '$' : 'ZWG ';
  return `${symbol}${amount.toFixed(2)}`;
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
