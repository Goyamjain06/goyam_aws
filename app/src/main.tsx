import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import '@fontsource/mukta/400.css'
import '@fontsource/mukta/500.css'
import '@fontsource/mukta/700.css'
import '@fontsource/mukta/800.css'
import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import './styles.css'
import { DataCtx } from './lib/data'
import type { AQData } from './lib/model'
import Landing from './pages/Landing'
import Rider from './pages/Rider'
import Station from './pages/Station'

function App() {
  const [data, setData] = useState<AQData | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    fetch('/data/delhi_aq.json').then(r => r.json()).then(setData).catch(() => setErr('Air data file is missing. Run analysis/build_dataset.py, then reload.'))
  }, [])
  if (err) return <p className="boot">{err}</p>
  if (!data) return <p className="boot">हवा का डेटा लोड हो रहा है…</p>
  return (
    <DataCtx.Provider value={data}>
      {data.meta.sample && (
        <div className="sample-banner" role="alert">
          Sample data. These numbers are synthetic. Run <code>analysis/build_dataset.py</code> for real Delhi readings.
        </div>
      )}
      <Routes>
        <Route path="/" element={<Shell><Landing /></Shell>} />
        <Route path="/station" element={<Shell><Station /></Shell>} />
        <Route path="/rider" element={<Rider />} />
      </Routes>
    </DataCtx.Provider>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">RideClean</Link>
        <nav>
          <NavLink to="/rider">Rider app</NavLink>
          <NavLink to="/station">Station planner</NavLink>
        </nav>
      </header>
      {children}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </StrictMode>,
)
