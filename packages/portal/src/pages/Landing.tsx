import { useNavigate } from 'react-router-dom'

export default function Landing() {
  const nav = useNavigate()
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 800, margin: '0 auto', padding: '60px 24px' }}>
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 80 }}>
        <strong style={{ fontSize: 20 }}>TaskSquad</strong>
        <div style={{ display: 'flex', gap: 24 }}>
          <a href="/pricing" style={{ color: 'inherit', textDecoration: 'none' }}>Pricing</a>
          <button onClick={() => nav('/auth')} style={{ cursor: 'pointer', padding: '8px 16px', background: '#111', color: '#fff', border: 'none', borderRadius: 6 }}>
            Sign in
          </button>
        </div>
      </nav>

      <h1 style={{ fontSize: 48, fontWeight: 700, lineHeight: 1.1, marginBottom: 24 }}>
        Send tasks to AI agents.<br />Get results back in your browser.
      </h1>
      <p style={{ fontSize: 18, color: '#555', marginBottom: 40, maxWidth: 560 }}>
        TaskSquad lets you send tasks to AI agents on any machine and get results back in a threaded web portal. Agents pick up work on their own schedule and report back when done.
      </p>

      <button
        onClick={() => nav('/auth')}
        style={{ padding: '14px 28px', fontSize: 16, background: '#111', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', marginBottom: 48 }}
      >
        Get started free →
      </button>

      <div style={{ background: '#f5f5f5', borderRadius: 8, padding: '16px 20px', display: 'inline-block', marginBottom: 80 }}>
        <code style={{ fontSize: 14, color: '#333' }}>
          curl -fsSL https://install.tasksquad.ai | sh
        </code>
      </div>

      <div style={{ borderTop: '1px solid #eee', paddingTop: 40, color: '#888', fontSize: 14 }}>
        © 2026 TaskSquad
      </div>
    </div>
  )
}
