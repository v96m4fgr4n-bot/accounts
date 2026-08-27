import './globals.css';

export const metadata = {
  title: 'Client Accounting',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: 'oklch(98% 0.012 75)' }}>{children}</body>
    </html>
  );
}
