import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Cigarettes from '../components/Cigarettes'
import { ask, liveAir, speak, type Air, type Answer, type Lang } from '../lib/api'
import { useData } from '../lib/data'
import * as m from '../lib/model'

type SR = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null }

const store = {
  get: (k: string, dflt: string) => { try { return localStorage.getItem(k) ?? dflt } catch { return dflt } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

const UI = {
  hi: {
    brand: 'RideClean', navHome: 'होम', navStation: 'स्टेशन प्लानर', switchTo: 'English', switchLabel: 'Switch to English',
    live: (s: string) => `लाइव, ${s}`, typical: 'इस समय का आम स्तर',
    soFar: 'आज की शिफ़्ट में अब तक', unit: 'सिगरेट जितना धुआँ', shiftStarted: 'शिफ़्ट शुरू हुई', shiftLabel: 'शिफ़्ट शुरू होने का समय',
    demoPlace: ', जगह: DTU (डेमो)', thinking: 'सोच रहा हूँ…', replay: 'फिर से सुनें',
    hint: 'माइक दबाकर हिंदी में पूछें, जैसे “आनंद विहार से नोएडा जा रहा हूँ”।',
    going: (a: string, b: string) => `${a} से ${b} जा रहा हूँ`,
    chips: ['पास में साफ़ हवा कहाँ है?', 'आज कितना धुआँ लिया?', 'कब निकलूँ?'],
    micOn: 'सुनना बंद करें', micOff: 'बोलकर पूछें', listening: 'सुन रहा हूँ…', typeHere: 'या यहाँ लिखें', question: 'सवाल', ask: 'पूछें',
    engineAI: 'Amazon Nova (Strands agent) से जवाब', engineLocal: 'फ़ोन पर बना जवाब (ऑफ़लाइन)', engineRules: 'नियमों से बना जवाब', secs: 'सेकंड',
    noMic: 'इस ब्राउज़र में आवाज़ से पूछना नहीं चलता। नीचे लिखकर पूछें।',
    pmExplain: 'PM2.5 = बहुत बारीक धुएँ के कण जो फेफड़ों तक पहुँचते हैं', airLabel: 'हवा',
    example: 'आनंद विहार से राजीव चौक', exampleQuery: 'आनंद विहार से राजीव चौक जा रहा हूँ', tryExample: 'उदाहरण आज़माएँ',
    away: (n: number) => `${n} मिनट दूर`, extra: (n: number) => `ब्रेक लेने में आना-जाना मिलाकर लगभग ${n} मिनट extra लगेगा`,
    badgeLive: 'लाइव रीडिंग', badgeEst: 'अनुमान: इस समय का आम स्तर',
    shiftTip: 'शिफ़्ट नहीं बदल सकते? सबसे गंदा समय रात 10 से 2 बजे है, उस दौरान एक 15 मिनट का ब्रेक किसी साफ़ जगह पर लो।',
    cigScale: (n: number) => `1 सिगरेट ≈ दिन भर ${n} µg/m³ PM2.5`,
    from: 'से', cig: 'सिगरेट', min: 'मिनट', road: 'सड़क पर PM2.5', next6: 'अगले 6 घंटे', breakTitle: 'साफ़ हवा में आराम', now: 'अभी', timeline: 'अगले घंटों में धुआँ',
  },
  en: {
    brand: 'RideClean', navHome: 'Home', navStation: 'Station planner', switchTo: 'हिंदी', switchLabel: 'हिंदी में बदलें',
    live: (s: string) => `Live, ${s}`, typical: 'Typical for this hour',
    soFar: "So far in today's shift", unit: 'cigarettes of smoke', shiftStarted: 'Shift started at', shiftLabel: 'Shift start time',
    demoPlace: ', place: DTU (demo)', thinking: 'Thinking…', replay: 'Play again',
    hint: 'Tap the mic and ask, for example “I am going from Anand Vihar to Noida”.',
    going: (a: string, b: string) => `Going from ${a} to ${b}`,
    chips: ['Where is clean air nearby?', 'How much smoke today?', 'When should I leave?'],
    micOn: 'Stop listening', micOff: 'Ask by voice', listening: 'Listening…', typeHere: 'Or type here', question: 'Question', ask: 'Ask',
    engineAI: 'Answer from Amazon Nova (Strands agent)', engineLocal: 'Answered on the phone (offline)', engineRules: 'Rule-based answer', secs: 's',
    noMic: 'Voice input does not work in this browser. Type your question below.',
    pmExplain: 'PM2.5 = tiny smoke particles that reach your lungs', airLabel: 'PM2.5',
    example: 'Anand Vihar to Rajiv Chowk', exampleQuery: 'Going from Anand Vihar to Rajiv Chowk', tryExample: 'Try an example',
    away: (n: number) => `${n} min away`, extra: (n: number) => `Going to a break spot and back will take about ${n} min extra`,
    badgeLive: 'Live reading', badgeEst: 'Estimate: typical level for this hour',
    shiftTip: "Can't change your shift? The dirtiest time is 10 pm to 2 am. During that time, take a 15 minute break at a clean place.",
    cigScale: (n: number) => `1 cigarette ≈ ${n} µg/m³ of PM2.5 for a day`,
    from: 'to', cig: 'cigarettes', min: 'min', road: 'PM2.5 on the road', next6: 'Next 6 hours', breakTitle: 'Rest in cleaner air', now: 'Now', timeline: 'Smoke over the next hours',
  },
}

export default function Rider() {
  const d = useData()
  const [lang, setLang] = useState<Lang>(() => (store.get('saans-lang', 'hi') === 'en' ? 'en' : 'hi'))
  const t = UI[lang]
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
  useEffect(() => { store.set('saans-lang', lang); document.documentElement.lang = lang }, [lang])

  const shift = useMemo(() => {
    const hrs = Math.max(0, Math.min(14, m.istHour() + m.istMinute() / 60 - shiftStart))
    return m.shiftDose(d, pos.lat, pos.lon, shiftStart, hrs, air?.source === 'live' ? air.pm25 : null)
  }, [d, pos, shiftStart, air])

  const pm = air?.pm25 ?? m.expectedPm(d, pos.lat, pos.lon, m.istHour())
  const nearby = d.breaks.length ? m.cleanBreaks(d, pos.lat, pos.lon, 1)[0] : null
  const suggestions = [t.going(nearby ? nearby.name : d.zones[0].name, d.zones[d.zones.length - 1].name), ...t.chips]

  function switchLang() {
    recRef.current?.stop()
    setLang(l => (l === 'hi' ? 'en' : 'hi'))
    setAns(null); setHeard(''); setText('')
  }

  async function submit(q: string) {
    const query = q.trim()
    if (!query || busy) return
    setBusy(true); setHeard(query); setText('')
    try {
      const a = await ask(d, query, { lat: pos.lat, lon: pos.lon, shift_start: shiftStart, rider_id: riderId, lang })
      setAns(a); speak({ ...a, lang: a.lang ?? lang })
    } finally { setBusy(false) }
  }

  function toggleMic() {
    const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }
    const Ctor = W.SpeechRecognition || W.webkitSpeechRecognition
    if (!Ctor) { setHeard(''); setAns({ reply: t.noMic, cards: {}, engine: 'ui' }); return }
    if (listening) { recRef.current?.stop(); return }
    const rec = new Ctor()
    rec.lang = lang === 'en' ? 'en-IN' : 'hi-IN'; rec.interimResults = true; rec.continuous = false
    let finalText = ''
    rec.onresult = e => {
      const r = Array.from(e.results as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>)
      const txt = r.map(x => x[0].transcript).join(' ')
      setText(txt)
      if (r[r.length - 1].isFinal) finalText = txt
    }
    rec.onend = () => { setListening(false); if (finalText) submit(finalText) }
    rec.onerror = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  const cat = lang === 'en' ? m.category(pm).en.toLowerCase() : m.category(pm).hi
  const engineText = !ans ? '' : ans.engine.startsWith('strands') ? t.engineAI : ans.engine === 'rules' ? t.engineRules : t.engineLocal
  return (
    <main className="rider" style={{ ['--haze' as string]: m.smogColor(pm) }}>
      <header className="r-top">
        <Link to="/" className="brand">{t.brand}</Link>
        <div className="r-top-right">
          <button className="lang-toggle" onClick={switchLang} aria-label={t.switchLabel} lang={lang === 'hi' ? 'en' : 'hi'}>{t.switchTo}</button>
          <div className={`air-chip band-${m.bandIndex(pm)}`}>
            <span className="pm">{Math.round(pm)}</span>
            <span className="pm-meta">{lang === 'hi' ? `${t.airLabel}: ${cat}` : `${t.airLabel}, ${cat}`}<br /><small>{air?.source === 'live' ? t.live(air.station.split(',')[0]) : t.typical}</small></span>
          </div>
        </div>
      </header>
      <nav className="r-nav">
        <Link to="/">{t.navHome}</Link>
        <Link to="/station">{t.navStation}</Link>
      </nav>
      <p className="pm-explain">{t.pmExplain}</p>

      <section className="r-dose" aria-live="polite">
        <p className="r-label">{t.soFar}</p>
        <div className="r-dose-row">
          <b className="r-num">{shift.cigarettes.toFixed(1)}</b>
          <span className="r-unit">{t.unit}</span>
        </div>
        <Cigarettes value={shift.cigarettes} size="sm" max={8} />
        <p className="cig-scale">{t.cigScale(Math.round(d.constants.cig_ugm3_hours / 24))}</p>
        <p className="r-shift">
          {t.shiftStarted}
          <select value={shiftStart} onChange={e => setShiftStart(Number(e.target.value))} aria-label={t.shiftLabel}>
            {Array.from({ length: 12 }, (_, i) => i + 5).map(h => <option key={h} value={h}>{m.hourLabel(h, lang)}</option>)}
          </select>
          {pos.demo && <small>{t.demoPlace}</small>}
        </p>
      </section>

      <section className="r-answer">
        {heard && <p className="you">“{heard}”</p>}
        {busy && <p className="thinking">{t.thinking}</p>}
        {ans && !busy && (
          <>
            <p className="reply">{ans.reply}</p>
            <AnswerCards ans={ans} lang={lang} live={air?.source === 'live'} />
            {ans.engine !== 'ui' && <button className="link-btn" onClick={() => speak({ ...ans, lang: ans.lang ?? lang })}>{t.replay}</button>}
          </>
        )}
        {!heard && !ans && (
          <div className="try-example">
            <button onClick={() => submit(t.exampleQuery)} disabled={busy}>
              <small>{t.tryExample}</small>
              {t.example}
            </button>
            <p className="hint">{t.hint}</p>
          </div>
        )}
      </section>

      <section className="r-ask">
        <div className="chips">
          {suggestions.map(s => <button key={s} onClick={() => submit(s)} disabled={busy}>{s}</button>)}
        </div>
        <form onSubmit={e => { e.preventDefault(); submit(text) }} className="ask-row">
          <button type="button" className={`mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-label={listening ? t.micOn : t.micOff} disabled={busy}>
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" fill="currentColor" /></svg>
          </button>
          <input value={text} onChange={e => setText(e.target.value)} placeholder={listening ? t.listening : t.typeHere} aria-label={t.question} />
          <button type="submit" className="send" disabled={busy || !text.trim()}>{t.ask}</button>
        </form>
        {ans && ans.engine !== 'ui' && <p className="engine">{engineText}{ans.ms ? `, ${(ans.ms / 1000).toFixed(1)} ${t.secs}` : ''}</p>}
      </section>
    </main>
  )
}

function AnswerCards({ ans, lang, live }: { ans: Answer; lang: Lang; live: boolean }) {
  const t = UI[lang]
  const c = ans.cards
  const badge = (isLive: boolean) => <p className={`src-badge ${isLive ? 'live' : ''}`}>{isLive ? t.badgeLive : t.badgeEst}</p>
  return (
    <div className="cards">
      {c.trip && (
        <div className="card trip">
          <div className="card-head">{lang === 'en' ? 'From ' : ''}<b>{c.trip.from}</b> {t.from} <b>{c.trip.to}</b></div>
          <div className="trip-row">
            <Cigarettes value={c.trip.cigarettes} size="sm" max={4} />
            <div>
              <p className="big">{c.trip.cigarettes < 0.1 ? '<0.1' : c.trip.cigarettes.toFixed(2)} <small>{t.cig}</small></p>
              <p>{c.trip.minutes} {t.min}, {c.trip.distance_km} km, {t.road} {c.trip.onroad_pm25}</p>
            </div>
          </div>
          <Timeline options={c.trip.options} best={c.trip.best_departure.hour} lang={lang} />
          {badge(c.trip.used_live_data)}
        </div>
      )}
      {c.timing && !c.trip && (
        <div className="card">
          <div className="card-head">{t.next6}</div>
          <Timeline options={c.timing.options} best={c.timing.best.hour} lang={lang} />
          {badge(c.air ? c.air.source === 'live' : live)}
          {c.timing.saving_pct < 10 && <p className="shift-tip">{t.shiftTip}</p>}
        </div>
      )}
      {c.breaks && c.breaks.length > 0 && (
        <div className="card breaks">
          <div className="card-head">{t.breakTitle}</div>
          {c.breaks.map(b => (
            <a key={b.name} href={b.maps} target="_blank" rel="noreferrer" className="spot">
              <span>{b.name}, {t.away(b.minutes)}</span>
            </a>
          ))}
          <p className="break-extra">{t.extra(Math.min(...c.breaks.map(b => b.minutes)) * 2)}</p>
        </div>
      )}
    </div>
  )
}

function Timeline({ options, best, lang }: { options: { hour: number; pm25: number }[]; best: number; lang: Lang }) {
  const t = UI[lang]
  const max = Math.max(...options.map(o => o.pm25))
  return (
    <div className="timeline" role="list" aria-label={t.timeline}>
      {options.map((o, i) => (
        <div key={i} role="listitem" className={`tl ${o.hour === best ? 'best' : ''}`}>
          <span className="tl-bar" style={{ height: `${Math.max(8, (o.pm25 / max) * 56)}px`, background: m.smogColor(o.pm25) }} />
          <span className="tl-h">{i === 0 ? t.now : m.hourEn(o.hour)}</span>
        </div>
      ))}
    </div>
  )
}
