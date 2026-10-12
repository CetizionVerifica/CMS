'use client';
// Last-resort error page, shown when the root layout itself fails. It replaces <html>, so it can't rely on the app
// stylesheet having loaded; it keeps to plain markup.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en-IN">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '48px 16px' }}>
        <main style={{ maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: 22 }}>PlanetPulse Compliance didn’t load</h1>
          <p>
            Something went wrong on our side. Try again, and if it keeps happening, share the
            reference with support.
          </p>
          {error.digest ? <p>Reference: {error.digest}</p> : null}
          <button type="button" onClick={reset} style={{ minHeight: 44, padding: '0 16px' }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
