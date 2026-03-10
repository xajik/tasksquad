import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { useState, useEffect } from 'react'
import { auth } from './lib/firebase'
import { identifyUser, trackEvent, initAnalytics } from './lib/analytics'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Pricing from './pages/Pricing'
import './index.css'

initAnalytics();

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      if (user) {
        identifyUser(user.uid, { email: user.email });
      } else {
        identifyUser(null);
      }
      setAuthed(!!user);
    })
  }, [])

  if (authed === null) return null

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/auth" element={authed ? <Navigate to="/dashboard" /> : <Login />} />
        <Route path="/dashboard/*" element={authed ? <Dashboard /> : <Navigate to="/auth" />} />
      </Routes>
    </BrowserRouter>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
