// Talks to the RideClean backend on AWS Lambda. If it's unreachable, answers on-device with the same model.
import * as m from './model'
import type { AQData, BreakSpot, Trip } from './model'

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || ''

export type Air = { pm25: number; source: 'live' | 'typical'; station: string; station_km: number; category: { en: string; hi: string }; typical_for_hour: number }
export type Cards = {
  air?: Air; trip?: Trip; breaks?: BreakSpot[]; shift?: { hours: number; cigarettes: number }
  timing?: ReturnType<typeof m.timing>
}
export type Answer = { reply: string; cards: Cards; engine: string; lang?: 'hi' | 'en'; ms?: number; audio_mp3_b64?: string | null; today?: { cigarettes: number; trips: unknown[] } }

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

export async function ask(d: AQData, text: string, ctx: { lat: number; lon: number; shift_start: number; rider_id: string; lang: 'hi' | 'en' }): Promise<Answer> {
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

// ---- on-device fallback (same intents and wording as backend/src/saans/fallback.py)
export type Lang = 'hi' | 'en'
const has = (t: string, words: string[]) => words.some(w => t.toLowerCase().includes(w))
const TIME = ['kab', 'कब', 'time', 'samay', 'समय', 'nikl', 'निकल', 'when', 'leave']
const DOSE = ['aaj', 'आज', 'dose', 'kitna', 'कितना', 'kitni', 'cigarette', 'सिगरेट', 'shift', 'today', 'how much']
const GOING = /\b(jaa|ja|tak|pahunch|deliver|going|go to|reach|to)\b|जा|तक/i

type Vars = Record<string, string | number>
const T: Record<Lang, Record<string, (v: Vars) => string>> = {
  hi: {
    here: () => 'आपकी जगह',
    trip: v => `${v.a} से ${v.b} तक करीब ${v.m} मिनट लगेंगे, इसमें आप ${v.c} जितना धुआँ साँस में लेंगे।`,
    wait: v => `अगर ${v.h} निकलें तो ${v.p}% कम धुआँ लगेगा।`,
    goNow: () => 'अभी निकलना ठीक है, मास्क ज़रूर पहनें।',
    notStarted: v => `आपकी शिफ़्ट ${v.h} शुरू होगी, अभी तक का धुआँ गिना नहीं गया।`,
    dose: v => `आज की शिफ़्ट में अब तक आपने ${v.c} जितना धुआँ लिया है।`,
    breakTip: v => `20 मिनट किसी बंद, ठंडी जगह पर रुकने से उस समय का ${v.p}% धुआँ बचेगा।`,
    bestTime: v => `अगले 6 घंटों में ${v.h} हवा सबसे साफ़ रहती है, अभी से ${v.p}% कम धुआँ।`,
    same: () => 'अगले कुछ घंटों में हवा ऐसी ही रहेगी, अभी निकलना ठीक है।',
    spot: v => `सबसे पास साफ़ हवा वाली जगह ${v.n} है, करीब ${v.m} मिनट दूर।`,
    spotTip: () => 'मेट्रो स्टेशन के अंदर सड़क से कम धुआँ होता है, वहाँ थोड़ा आराम कर लें।',
    lead: v => `अभी हवा ${v.cat} है, PM2.5 ${v.pm}।`,
  },
  en: {
    here: () => 'your location',
    trip: v => `${v.a} to ${v.b} takes about ${v.m} minutes, and you will breathe ${v.c} worth of smoke.`,
    wait: v => `Leave at ${v.h} and you will breathe ${v.p}% less smoke.`,
    goNow: () => 'Leaving now is fine. Wear a mask.',
    notStarted: v => `Your shift starts at ${v.h}, so nothing is counted yet.`,
    dose: v => `So far in today's shift you have breathed ${v.c} worth of smoke.`,
    breakTip: v => `A 20-minute break somewhere enclosed and cool saves ${v.p}% of the smoke for that time.`,
    bestTime: v => `In the next 6 hours the air is cleanest at ${v.h}, ${v.p}% less smoke than now.`,
    same: () => 'The air will stay about the same for the next few hours, so leaving now is fine.',
    spot: v => `The nearest clean-air spot is ${v.n}, about ${v.m} minutes away.`,
    spotTip: () => 'Inside a metro station there is less smoke than on the road. Take a short rest there.',
    lead: v => `The air is ${v.cat} right now, PM2.5 ${v.pm}.`,
  },
}

export async function localAnswer(d: AQData, text: string, ctx: { lat: number; lon: number; shift_start: number; lang?: Lang }): Promise<Answer> {
  const t0 = performance.now()
  const lang: Lang = ctx.lang === 'en' ? 'en' : 'hi'
  const L = T[lang]
  const air = await liveAir(d, ctx.lat, ctx.lon)
  const livePm = air.source === 'live' ? air.pm25 : null
  const cards: Cards = { air }
  const parts: string[] = []
  const places = m.placesInText(d, text)
  if (places.length >= 2 || (places.length === 1 && GOING.test(text))) {
    const a = places.length >= 2 ? places[0] : { name: L.here({}), lat: ctx.lat, lon: ctx.lon }
    const b = places.length >= 2 ? places[1] : places[0]
    const tr = m.trip(d, a, b, livePm)
    cards.trip = tr
    parts.push(L.trip({ a: a.name, b: b.name, m: tr.minutes, c: m.cigLabel(tr.cigarettes, lang) }))
    parts.push(tr.saving_pct_if_wait >= 15 && tr.best_departure.hour !== tr.depart_hour
      ? L.wait({ h: m.hourLabel(tr.best_departure.hour, lang), p: tr.saving_pct_if_wait }) : L.goNow({}))
    cards.breaks = m.cleanBreaks(d, b.lat, b.lon, 2)
  } else if (has(text, DOSE)) {
    const hours = Math.max(0, Math.min(14, m.istHour() + m.istMinute() / 60 - ctx.shift_start))
    const s = m.shiftDose(d, ctx.lat, ctx.lon, ctx.shift_start, hours, livePm)
    cards.shift = s
    parts.push(s.hours <= 0 ? L.notStarted({ h: m.hourLabel(ctx.shift_start, lang) }) : L.dose({ c: m.cigLabel(s.cigarettes, lang) }))
    parts.push(L.breakTip({ p: Math.round((1 - m.INDOOR_FACTOR / d.constants.onroad_factor) * 100) }))
    cards.breaks = m.cleanBreaks(d, ctx.lat, ctx.lon, 2)
  } else if (has(text, TIME)) {
    const tm = m.timing(d, ctx.lat, ctx.lon, livePm)
    cards.timing = tm
    parts.push(tm.best.hour !== tm.now_hour && tm.saving_pct >= 10 ? L.bestTime({ h: m.hourLabel(tm.best.hour, lang), p: tm.saving_pct }) : L.same({}))
  } else {
    const spots = m.cleanBreaks(d, ctx.lat, ctx.lon, 3)
    cards.breaks = spots
    if (spots[0]) parts.push(L.spot({ n: spots[0].name, m: spots[0].minutes }), L.spotTip({}))
  }
  const cat = lang === 'en' ? air.category.en.toLowerCase() : air.category.hi
  return { reply: [L.lead({ cat, pm: air.pm25 }), ...parts].join(' '), cards, engine: 'on-device', lang, ms: Math.round(performance.now() - t0) }
}

// ---- speech out: Amazon Polly audio if the backend sent it, else the browser's own voice
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
    const en = ans.lang === 'en'
    u.lang = en ? 'en-IN' : 'hi-IN'
    const voices = window.speechSynthesis.getVoices()
    const v = en ? (voices.find(x => x.lang === 'en-IN') ?? voices.find(x => x.lang.startsWith('en'))) : voices.find(x => x.lang.startsWith('hi'))
    if (v) u.voice = v
    window.speechSynthesis.speak(u)
  }
}
