import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Cigarettes from '../components/Cigarettes'
import { ask, liveAir, speak, type Air, type Answer } from '../lib/api'
import { useData } from '../lib/data'
import * as m from '../lib/model'

type SR = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null }

const store = {
  get: (k: string, dflt: string) => { try { return localStorage.getItem(k) ?? dflt } catch { return dflt } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

export default function Rider() {
  const d = useData()
  const [pos, setPos] = useState<{ lat: number; lon: number; demo: boolean }>({ ...m.DTU, demo: true })
  const [air, setAir] = useState<Air | null>(null)
  const [shiftStart, setShiftStart] = useState(() => Number(store.get('saans-shift', '9')))
  const [riderId] = useState(() => { const id = store.get('saans-rider', 'r-' + Math.random().toString(36).slice(2, 8)); store.set('saans-rider', id); return id })
  const [text, setText] = useState('')
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ans, setAns] = useState<Answer | null>(null)
  const [heard, setHeard] = useState('')
  const recRef = useRef<SR | null>(null)

  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      p => { if (m.haversineKm(p.coords.latitude, p.coords.longitude, m.DTU.lat, m.DTU.lon) < 80) setPos({ lat: p.coords.latitude, lon: p.coords.longitude, demo: false }) },
      () => {}, { enableHighAccuracy: true, timeout: 8000 })
  }, [])
  useEffect(() => { liveAir(d, pos.lat, pos.lon).then(setAir) }, [d, pos])
  useEffect(() => { store.set('saans-shift', String(shiftStart)) }, [shiftStart])

  const shift = useMemo(() => {
    const hrs = Math.max(0, Math.min(14, m.istHour() + m.istMinute() / 60 - shiftStart))
    return m.shiftDose(d, pos.lat, pos.lon, shiftStart, hrs, air?.source === 'live' ? air.pm25 : null)
  }, [d, pos, shiftStart, air])

  const pm = air?.pm25 ?? m.expectedPm(d, pos.lat, pos.lon, m.istHour())
  const nearby = d.breaks.length ? m.cleanBreaks(d, pos.lat, pos.lon, 1)[0] : null
  const suggestions = [
    nearby ? `${nearby.name} से ${d.zones[d.zones.length - 1].name} जा रहा हूँ` : `${d.zones[0].name} से ${d.zones[d.zones.length - 1].name} जा रहा हूँ`,
    'पास में साफ़ हवा कहाँ है?',
    'आज कितना धुआँ लिया?',
    'कब निकलूँ?',
  ]

  async function submit(q: string) {
    const query = q.trim()
    if (!query || busy) return
    setBusy(true); setHeard(query); setText('')
    try {
      const a = await ask(d, query, { lat: pos.lat, lon: pos.lon, shift_start: shiftStart, rider_id: riderId })
      setAns(a); speak(a)
    } finally { setBusy(false) }
  }

  function toggleMic() {
    const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }
    const Ctor = W.SpeechRecognition || W.webkitSpeechRecognition
    if (!Ctor) { alertNoMic(); return }
    if (listening) { recRef.current?.stop(); return }
    const rec = new Ctor()
    rec.lang = 'hi-IN'; rec.interimResults = true; rec.continuous = false
    let finalText = ''
    rec.onresult = e => {
      const r = Array.from(e.results as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>)
      const t = r.map(x => x[0].transcript).join(' ')
      setText(t)
      if (r[r.length - 1].isFinal) finalText = t
    }
    rec.onend = () => { setListening(false); if (finalText) submit(finalText) }
    rec.onerror = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
  }
  function alertNoMic() { setHeard(''); setAns({ reply: 'इस ब्राउज़र में आवाज़ से पूछना नहीं चलता। नीचे लिखकर पूछें।', cards: {}, engine: 'ui' }) }

  const haze = m.smogColor(pm)
  return (
    <main className="rider" style={{ ['--haze' as string]: haze }}>
      <header className="r-top">
        <Link to="/" className="brand">साँस</Link>
        <div className={`air-chip band-${m.bandIndex(pm)}`}>
          <span className="pm">{Math.round(pm)}</span>
          <span className="pm-meta">PM2.5, {m.category(pm).hi}<br /><small>{air?.source === 'live' ? `लाइव, ${air.station.split(',')[0]}` : 'इस समय का आम स्तर'}</small></span>
        </div>
      </header>

      <section className="r-dose" aria-live="polite">
        <p className="r-label">आज की शिफ़्ट में अब तक</p>
        <div className="r-dose-row">
          <b className="r-num">{shift.cigarettes.toFixed(1)}</b>
          <span className="r-unit">सिगरेट जितना धुआँ</span>
        </div>
        <Cigarettes value={shift.cigarettes} size="sm" max={8} />
        <p className="r-shift">
          शिफ़्ट शुरू हुई
          <select value={shiftStart} onChange={e => setShiftStart(Number(e.target.value))} aria-label="शिफ़्ट शुरू होने का समय">
            {Array.from({ length: 12 }, (_, i) => i + 5).map(h => <option key={h} value={h}>{m.hourHi(h)}</option>)}
          </select>
          {pos.demo && <small>, जगह: DTU (डेमो)</small>}
        </p>
      </section>

      <section className="r-answer">
        {heard && <p className="you">“{heard}”</p>}
        {busy && <p className="thinking">सोच रहा हूँ…</p>}
        {ans && !busy && (
          <>
            <p className="reply">{ans.reply}</p>
            <AnswerCards ans={ans} />
            <button className="link-btn" onClick={() => speak(ans)}>फिर से सुनें</button>
          </>
        )}
        {!heard && !ans && <p className="hint">माइक दबाकर हिंदी में पूछें, जैसे “आनंद विहार से नोएडा जा रहा हूँ”।</p>}
      </section>

      <section className="r-ask">
        <div className="chips">
          {suggestions.map(s => <button key={s} onClick={() => submit(s)} disabled={busy}>{s}</button>)}
        </div>
        <form onSubmit={e => { e.preventDefault(); submit(text) }} className="ask-row">
          <button type="button" className={`mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-label={listening ? 'सुनना बंद करें' : 'बोलकर पूछें'} disabled={busy}>
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" fill="currentColor" /></svg>
          </button>
          <input value={text} onChange={e => setText(e.target.value)} placeholder={listening ? 'सुन रहा हूँ…' : 'या यहाँ लिखें'} aria-label="सवाल" />
          <button type="submit" className="send" disabled={busy || !text.trim()}>पूछें</button>
        </form>
        {ans && <p className="engine">{ans.engine.startsWith('strands') ? 'Amazon Nova (Strands agent) से जवाब' : 'फ़ोन पर बना जवाब (ऑफ़लाइन)'}{ans.ms ? `, ${(ans.ms / 1000).toFixed(1)} सेकंड` : ''}</p>}
      </section>
    </main>
  )
}

function AnswerCards({ ans }: { ans: Answer }) {
  const c = ans.cards
  return (
    <div className="cards">
      {c.trip && (
        <div className="card trip">
          <div className="card-head"><b>{c.trip.from}</b> से <b>{c.trip.to}</b></div>
          <div className="trip-row">
            <Cigarettes value={c.trip.cigarettes} size="sm" max={4} />
            <div>
              <p className="big">{c.trip.cigarettes < 0.1 ? '<0.1' : c.trip.cigarettes.toFixed(2)} <small>सिगरेट</small></p>
              <p>{c.trip.minutes} मिनट, {c.trip.distance_km} km, सड़क पर PM2.5 {c.trip.onroad_pm25}</p>
            </div>
          </div>
          <Timeline options={c.trip.options} best={c.trip.best_departure.hour} />
        </div>
      )}
      {c.timing && !c.trip && (
        <div className="card">
          <div className="card-head">अगले 6 घंटे</div>
          <Timeline options={c.timing.options} best={c.timing.best.hour} />
        </div>
      )}
      {c.breaks && c.breaks.length > 0 && (
        <div className="card breaks">
          <div className="card-head">साफ़ हवा में आराम</div>
          {c.breaks.map(b => (
            <a key={b.name} href={b.maps} target="_blank" rel="noreferrer" className="spot">
              <span>{b.name}</span><span>{b.minutes} मिनट</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

function Timeline({ options, best }: { options: { hour: number; pm25: number }[]; best: number }) {
  const max = Math.max(...options.map(o => o.pm25))
  return (
    <div className="timeline" role="list" aria-label="अगले घंटों में धुआँ">
      {options.map((o, i) => (
        <div key={i} role="listitem" className={`tl ${o.hour === best ? 'best' : ''}`}>
          <span className="tl-bar" style={{ height: `${Math.max(8, (o.pm25 / max) * 56)}px`, background: m.smogColor(o.pm25) }} />
          <span className="tl-h">{i === 0 ? 'अभी' : m.hourEn(o.hour)}</span>
        </div>
      ))}
    </div>
  )
}
