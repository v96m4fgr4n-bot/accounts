type Severity = 'ok' | 'pending' | 'urgent';

export function StatusBadge({ severity, children }: { severity: Severity; children: React.ReactNode }) {
  return <span className={`badge badge-${severity}`}>{children}</span>;
}
