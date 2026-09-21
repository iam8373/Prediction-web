'use client'

/**
 * Last-resort error boundary — a failure in the root layout itself.
 *
 * This component *replaces* the root layout, so the stylesheet the layout
 * imports is not available. The styling below is deliberately inline and
 * self-contained: if the CSS pipeline or a provider is what broke, this page
 * must still render something readable.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: '#0f1513',
          color: '#eaf2ef',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ width: '100%', maxWidth: '420px', textAlign: 'center' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>Predik is having a problem</h1>
          <p style={{ marginTop: '10px', fontSize: '14px', lineHeight: 1.55, color: '#a9bdb6' }}>
            The app failed to start this page. Your wallet balance and positions are unchanged.
            Please try again in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '20px',
              padding: '10px 18px',
              borderRadius: '12px',
              border: 'none',
              background: '#3ddc97',
              color: '#08110e',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <p style={{ marginTop: '22px', fontSize: '11px', color: '#7c8f89' }}>
            {error.digest ? `Reference ${error.digest} · ` : ''}
            <a href="/api/health" style={{ color: '#7c8f89' }}>
              system status
            </a>
          </p>
        </div>
      </body>
    </html>
  )
}
