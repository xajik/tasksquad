import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { useState, useEffect } from 'react'
import { auth } from './lib/firebase'
import { identifyUser, initAnalytics } from './lib/analytics'
import Landing from './pages/Landing'
import HowTo from './pages/HowTo'
import Login from './pages/Login'
import CLIAuth from './pages/CLIAuth'
import Dashboard from './pages/Dashboard'
import Pricing from './pages/Pricing'
import './index.css'

initAnalytics();

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  console.log('[App] render, authed=', authed, 'path=', window.location.pathname)

  useEffect(() => {
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
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/howto" element={<HowTo />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/auth/cli" element={<CLIAuth />} />
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
    <App />
  </StrictMode>,
)
