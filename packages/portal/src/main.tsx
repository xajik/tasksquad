import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import { onAuthStateChanged } from 'firebase/auth'
import { useState, useEffect } from 'react'
import { auth } from './lib/firebase'
import { localGraphToken } from './lib/localGraph'
import { identifyUser, initAnalytics } from './lib/analytics'
import Landing from './pages/Landing'
import HowTo from './pages/HowTo'
import Demo from './pages/Demo'
import Login from './pages/Login'
import CLIAuth from './pages/CLIAuth'
import MobileAuth from './pages/MobileAuth'
import Dashboard from './pages/Dashboard'
import Pricing from './pages/Pricing'
import Privacy from './pages/Privacy'
import Terms from './pages/Terms'
import DocsLayout from './components/DocsLayout'
import './index.css'

initAnalytics();

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  console.log('[App] render, authed=', authed, 'path=', window.location.pathname)

  useEffect(() => {
    if (localGraphToken()) { setAuthed(true); return }
    if (!auth) {
      console.warn('[App] Firebase auth not configured, skipping auth state subscription')
      setAuthed(false)
      return
    }
    console.log('[App] subscribing to onAuthStateChanged')
    return onAuthStateChanged(auth, (user) => {
      console.log('[App] onAuthStateChanged fired, user=', user?.email ?? null)
      if (user) {
        identifyUser(user.uid, { email: user.email });
      } else {
        identifyUser(null);
      }
      setAuthed(!!user);
    })
  }, [])

  return (
    <BrowserRouter>
      {localGraphToken() && <div role="status" className="border-b bg-secondary px-4 py-2 text-center text-sm">Local test environment · separate database · agents: {import.meta.env.VITE_LOCAL_GRAPH_AGENTS ?? 'local'}</div>}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/howto" element={<HowTo />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/policy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/auth/cli" element={<CLIAuth />} />
        <Route path="/mobile/authorize" element={<MobileAuth />} />
        <Route path="/docs/*" element={<DocsLayout />} />
        {authed === null ? null : (
          <>
            <Route path="/auth" element={authed ? <Navigate to="/dashboard" /> : <Login />} />
            <Route path="/dashboard/*" element={authed ? <Dashboard /> : <Navigate to="/auth" />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>,
)
