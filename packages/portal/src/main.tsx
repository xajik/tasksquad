import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { useState, useEffect } from 'react'
import { auth } from './lib/firebase'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => setAuthed(!!user))
  }, [])

  if (authed === null) return null

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
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
