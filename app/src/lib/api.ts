// Talks to the Saans backend on AWS Lambda. If it's unreachable, answers on-device with the same model.
import * as m from './model'
import type { AQData, BreakSpot, Trip } from './model'

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || ''

export type Air = { pm25: number; source: 'live' | 'typical'; station: string; station_km: number; category: { en: string; hi: string }; typical_for_hour: number }
export type Cards = {
  air?: Air; trip?: Trip; breaks?: BreakSpot[]; shift?: { hours: number; cigarettes: number }
  timing?: ReturnType<typeof m.timing>
}
export type Answer = { reply: string; cards: Cards; engine: string; ms?: number; audio_mp3_b64?: string | null; today?: { cigarettes: number; trips: unknown[] } }

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}

export async function liveAir(d: AQData, lat: number, lon: number): Promise<Air> {
  if (API_URL) {
    try {
      const r = await withTimeout(fetch(`${API_URL}/live?lat=${lat}&lon=${lon}`), 6000)
      if (r.ok) return await r.json()
    } catch { /* fall through to typical */ }
  }
  const pm = m.expectedPm(d, lat, lon, m.istHour())
  const near = m.nearestStations(d, lat, lon, 1)[0]
  return { pm25: Math.round(pm), source: 'typical', station: near.s.name, station_km: Math.round(near.km * 10) / 10, category: m.category(pm), typical_for_hour: Math.round(pm) }
}

export async function liveAll(): Promise<{ id: number; pm25: number | null; live: boolean }[] | null> {
  if (!API_URL) return null
  try {
    const r = await withTimeout(fetch(`${API_URL}/live?all=1`), 15000)
    if (r.ok) return (await r.json()).stations
  } catch { /* offline */ }
  return null
}

export async function ask(d: AQData, text: string, ctx: { lat: number; lon: number; shift_start: number; rider_id: string }): Promise<Answer> {
  if (API_URL) {
    try {
      const r = await withTimeout(fetch(`${API_URL}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...ctx, speak: true }),
      }), 28000)
      if (r.ok) return await r.json()
    } catch { /* fall back to on-device answer */ }
  }
  return localAnswer(d, text, ctx)
}

// ---- on-device fallback (same intents as backend/src/saans/fallback.py)
const has = (t: string, words: string[]) => words.some(w => t.toLowerCase().includes(w))
const TIME = ['kab', 'कब', 'time', 'samay', 'समय', 'nikl', 'निकल']
const DOSE = ['aaj', 'आज', 'dose', 'kitna', 'कितना', 'kitni', 'cigarette', 'सिगरेट', 'shift']

export async function localAnswer(d: AQData, text: string, ctx: { lat: number; lon: number; shift_start: number }): Promise<Answer> {
  const t0 = performance.now()
  const air = await liveAir(d, ctx.lat, ctx.lon)
  const livePm = air.source === 'live' ? air.pm25 : null
  const cards: Cards = { air }
  const parts: string[] = []
  const places = m.placesInText(d, text)
  const goingTo = /\b(jaa|ja|tak|pahunch|deliver)/i.test(text) || /जा|तक/.test(text)
  if (places.length >= 2 || (places.length === 1 && goingTo)) {
    const a = places.length >= 2 ? places[0] : { name: 'आपकी जगह', lat: ctx.lat, lon: ctx.lon }
    const b = places.length >= 2 ? places[1] : places[0]
    const tr = m.trip(d, a, b, livePm)
    cards.trip = tr
    parts.push(`${a.name} से ${b.name} तक करीब ${tr.minutes} मिनट लगेंगे, इसमें आप ${m.cigHi(tr.cigarettes)} जितना धुआँ साँस में लेंगे।`)
    parts.push(tr.saving_pct_if_wait >= 15 && tr.best_departure.hour !== tr.depart_hour
      ? `अगर ${m.hourHi(tr.best_departure.hour)} निकलें तो ${tr.saving_pct_if_wait}% कम धुआँ लगेगा।`
      : 'अभी निकलना ठीक है, मास्क ज़रूर पहनें।')
    cards.breaks = m.cleanBreaks(d, b.lat, b.lon, 2)
  } else if (has(text, DOSE)) {
    const hours = Math.max(0, Math.min(14, m.istHour() + m.istMinute() / 60 - ctx.shift_start))
    const s = m.shiftDose(d, ctx.lat, ctx.lon, ctx.shift_start, hours, livePm)
    cards.shift = s
    parts.push(s.hours <= 0 ? `आपकी शिफ़्ट ${m.hourHi(ctx.shift_start)} शुरू होगी, अभी तक का धुआँ गिना नहीं गया।`
      : `आज की शिफ़्ट में अब तक आपने ${m.cigHi(s.cigarettes)} जितना धुआँ लिया है।`)
    parts.push(`20 मिनट किसी बंद, ठंडी जगह पर रुकने से उस समय का ${Math.round((1 - m.INDOOR_FACTOR / d.constants.onroad_factor) * 100)}% धुआँ बचेगा।`)
    cards.breaks = m.cleanBreaks(d, ctx.lat, ctx.lon, 2)
  } else if (has(text, TIME)) {
    const tm = m.timing(d, ctx.lat, ctx.lon, livePm)
    cards.timing = tm
    parts.push(tm.best.hour !== tm.now_hour && tm.saving_pct >= 10
      ? `अगले 6 घंटों में ${m.hourHi(tm.best.hour)} हवा सबसे साफ़ रहती है, अभी से ${tm.saving_pct}% कम धुआँ।`
      : 'अगले कुछ घंटों में हवा ऐसी ही रहेगी, अभी निकलना ठीक है।')
  } else {
    const spots = m.cleanBreaks(d, ctx.lat, ctx.lon, 3)
    cards.breaks = spots
    if (spots[0]) parts.push(`सबसे पास साफ़ हवा वाली जगह ${spots[0].name} है, करीब ${spots[0].minutes} मिनट दूर। मेट्रो स्टेशन के अंदर सड़क से कम धुआँ होता है, वहाँ थोड़ा आराम कर लें।`)
  }
  return { reply: [`अभी हवा ${air.category.hi} है, PM2.5 ${air.pm25}।`, ...parts].join(' '), cards, engine: 'on-device', ms: Math.round(performance.now() - t0) }
}

// ---- speech out: Amazon Polly audio if the backend sent it, else the browser's Hindi voice
let current: HTMLAudioElement | null = null
export function speak(ans: Answer) {
  current?.pause()
  window.speechSynthesis?.cancel()
  if (ans.audio_mp3_b64) {
    current = new Audio(`data:audio/mpeg;base64,${ans.audio_mp3_b64}`)
    current.play().catch(() => {})
    return
  }
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(ans.reply)
    u.lang = 'hi-IN'
    const v = window.speechSynthesis.getVoices().find(x => x.lang.startsWith('hi'))
    if (v) u.voice = v
    window.speechSynthesis.speak(u)
  }
}
