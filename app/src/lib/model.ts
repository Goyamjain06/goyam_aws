import { findInText, phonetic } from './translit'
// Exposure model. Mirrors backend/src/saans/core.py so the app keeps working offline.

export type Station = {
  id: number; name: string; lat: number; lon: number; zone: string; provider?: string
  hourly_median: number[]; hourly_p90: number[]; mean: number; days_over_naaqs: number; days: number
}
export type Zone = { name: string; lat: number; lon: number; hourly_median: number[]; mean: number; stations: number[] }
export type Spot = { name: string; lat: number; lon: number; type: string }
export type Siting = { name: string; lat: number; lon: number; work_hours_pm25: number; rider_cigs_per_shift: number; zone: string }
export type Shift = { start: number; cigarettes: number }
export type AQData = {
  meta: { sample: boolean; source: string; period: { start: string; end: string }; stations: number; station_hours: number; generated_at: string }
  constants: { onroad_factor: number; cig_ugm3_hours: number; who_24h: number; naaqs_24h: number; shift_hours: number }
  headline: {
    city_mean_pm25: number; times_who: number; pct_hours_over_naaqs: number; pct_days_over_naaqs: number
    typical_shift: Shift; best_shift: Shift; worst_shift: Shift; best_vs_worst_saving_pct: number
    red_hours: { start: number; end: number; avg_pm25: number }; clean_hours: { start: number; end: number; avg_pm25: number }
    worst_zone: string; cleanest_zone: string
  }
  city_hourly_median: number[]; shifts: Shift[]
  daily_city_mean: { date: string; pm25: number }[]
  zones: Zone[]; stations: Station[]; breaks: Spot[]; siting: Siting[]
}

export const RIDE_SPEED_KMH = 20
export const ROAD_DETOUR = 1.3
export const INDOOR_FACTOR = 0.5
export const DTU = { lat: 28.7499, lon: 77.117 }

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = 6371, rad = Math.PI / 180
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(a))
}

export const istHour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()))
export const istMinute = () => Number(new Intl.DateTimeFormat('en-GB', { minute: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date()))

export const cigarettes = (d: AQData, ugm3Hours: number) => ugm3Hours / d.constants.cig_ugm3_hours

// CPCB AQI bands for PM2.5 (24-h), labels in Hindi and English
export const BANDS = [
  { max: 30, en: 'Good', hi: 'अच्छी' },
  { max: 60, en: 'Satisfactory', hi: 'ठीक' },
  { max: 90, en: 'Moderate', hi: 'मध्यम' },
  { max: 120, en: 'Poor', hi: 'खराब' },
  { max: 250, en: 'Very poor', hi: 'बहुत खराब' },
  { max: Infinity, en: 'Severe', hi: 'गंभीर' },
]
// One-hue "smog" ramp, light to dark, one step per band (validated sequential, see dataviz notes)
export const SMOG = ['#EEF0EA', '#E3D9BC', '#D3B97F', '#B98C45', '#8B5A28', '#4F2B12']
export const bandIndex = (pm: number) => BANDS.findIndex(b => pm <= b.max)
export const category = (pm: number) => BANDS[bandIndex(pm)]
export const smogColor = (pm: number) => SMOG[bandIndex(pm)]

export function nearestStations(d: AQData, lat: number, lon: number, k = 3) {
  return d.stations.map(s => ({ km: haversineKm(lat, lon, s.lat, s.lon), s })).sort((a, b) => a.km - b.km).slice(0, k)
}

export function expectedPm(d: AQData, lat: number, lon: number, hour: number) {
  const pts = nearestStations(d, lat, lon, 3)
  const w = pts.map(p => 1 / Math.max(p.km, 0.5) ** 2)
  return pts.reduce((acc, p, i) => acc + w[i] * p.s.hourly_median[((hour % 24) + 24) % 24], 0) / w.reduce((a, b) => a + b, 0)
}

export type Trip = {
  from: string; to: string; distance_km: number; minutes: number; depart_hour: number
  ambient_pm25: number; onroad_pm25: number; cigarettes: number; times_who: number
  best_departure: { hour: number; pm25: number; cigarettes: number }; saving_pct_if_wait: number
  options: { hour: number; pm25: number; cigarettes: number }[]; used_live_data: boolean
}

export function trip(d: AQData, a: { name: string; lat: number; lon: number }, b: { name: string; lat: number; lon: number }, livePm?: number | null): Trip {
  const c = d.constants
  const km = haversineKm(a.lat, a.lon, b.lat, b.lon) * ROAD_DETOUR
  const minutes = Math.max(5, Math.round((km / RIDE_SPEED_KMH) * 60))
  const hour = istHour()
  const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
  const ridePm = (h: number) => (expectedPm(d, a.lat, a.lon, h) + expectedPm(d, mid.lat, mid.lon, h) + expectedPm(d, b.lat, b.lon, h)) / 3
  const typicalNow = ridePm(hour)
  const ambient = livePm || typicalNow
  const scale = typicalNow ? ambient / typicalNow : 1
  const options = Array.from({ length: 7 }, (_, dh) => {
    const h = (hour + dh) % 24
    const pm = ridePm(h) * scale
    return { hour: h, pm25: Math.round(pm), cigarettes: cigarettes(d, (pm * c.onroad_factor * minutes) / 60) }
  })
  const best = options.reduce((m, o) => (o.pm25 < m.pm25 ? o : m), options[0])
  return {
    from: a.name, to: b.name, distance_km: Math.round(km * 10) / 10, minutes, depart_hour: hour,
    ambient_pm25: Math.round(ambient), onroad_pm25: Math.round(ambient * c.onroad_factor),
    cigarettes: cigarettes(d, (ambient * c.onroad_factor * minutes) / 60),
    times_who: Math.round((ambient * c.onroad_factor) / c.who_24h * 10) / 10,
    best_departure: best, saving_pct_if_wait: options[0].pm25 ? Math.round((1 - best.pm25 / options[0].pm25) * 100) : 0,
    options, used_live_data: !!livePm,
  }
}

export function timing(d: AQData, lat: number, lon: number, livePm?: number | null) {
  const hour = istHour()
  const typical = expectedPm(d, lat, lon, hour)
  const scale = livePm && typical ? livePm / typical : 1
  const options = Array.from({ length: 7 }, (_, dh) => {
    const h = (hour + dh) % 24
    const pm = expectedPm(d, lat, lon, h) * scale
    return { hour: h, pm25: Math.round(pm), cigarettes: cigarettes(d, (pm * d.constants.onroad_factor * 30) / 60) }
  })
  const best = options.reduce((m, o) => (o.pm25 < m.pm25 ? o : m), options[0])
  return { now_hour: hour, options, best, saving_pct: options[0].pm25 ? Math.round((1 - best.pm25 / options[0].pm25) * 100) : 0 }
}

export function shiftDose(d: AQData, lat: number, lon: number, startHour: number, hoursDone: number, livePm?: number | null) {
  let total = 0
  const full = Math.floor(hoursDone)
  for (let i = 0; i < full; i++) total += expectedPm(d, lat, lon, startHour + i)
  total += (hoursDone - full) * expectedPm(d, lat, lon, startHour + full)
  if (livePm && hoursDone > 0) {
    const typ = expectedPm(d, lat, lon, istHour())
    if (typ) total *= livePm / typ
  }
  return { hours: Math.round(hoursDone * 10) / 10, cigarettes: cigarettes(d, total * d.constants.onroad_factor) }
}

export type BreakSpot = { name: string; lat: number; lon: number; km: number; minutes: number; maps: string }
export function cleanBreaks(d: AQData, lat: number, lon: number, k = 3): BreakSpot[] {
  return d.breaks.map(b => ({ km: haversineKm(lat, lon, b.lat, b.lon), b })).sort((x, y) => x.km - y.km).slice(0, k).map(({ km, b }) => ({
    name: b.name, lat: b.lat, lon: b.lon, km: Math.round(km * 10) / 10,
    minutes: Math.max(1, Math.round((km * ROAD_DETOUR) / RIDE_SPEED_KMH * 60)),
    maps: `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lon}&travelmode=two-wheeler`,
  }))
}

// ---------- places (Hindi or English, fuzzy)
type Place = { name: string; lat: number; lon: number; key: string }
let gaz: Place[] | null = null
function gazetteer(d: AQData): Place[] {
  if (gaz) return gaz
  const p: Omit<Place, 'key'>[] = [
    ...d.breaks.map(b => ({ name: b.name, lat: b.lat, lon: b.lon })),
    ...d.stations.map(s => ({ name: s.name.split(',')[0].split(' - ')[0].trim(), lat: s.lat, lon: s.lon })),
    ...d.zones.map(z => ({ name: z.name, lat: z.lat, lon: z.lon })),
  ]
  gaz = p.map(x => ({ ...x, key: phonetic(x.name) })).filter(x => x.key.length > 0)
  return gaz
}

export function placesInText(d: AQData, text: string) {
  const gz = gazetteer(d)
  return findInText(text, gz.map(p => p.key)).map(([, , ki]) => ({ name: gz[ki].name, lat: gz[ki].lat, lon: gz[ki].lon }))
}

// ---------- Hindi helpers
export function hourHi(h: number) {
  h = ((h % 24) + 24) % 24
  const h12 = h % 12 || 12
  const part = h >= 4 && h < 12 ? 'सुबह' : h < 16 && h >= 12 ? 'दोपहर' : h >= 16 && h < 19 ? 'शाम' : 'रात'
  return `${part} ${h12} बजे`
}
export const cigHi = (c: number) => (c < 0.1 ? 'एक सिगरेट के दसवें हिस्से से भी कम' : `लगभग ${Math.round(c * 10) / 10} सिगरेट`)
export const hourEn = (h: number) => { const h12 = h % 12 || 12; return `${h12}${h < 12 ? 'am' : 'pm'}` }
export const hourLabel = (h: number, lang: 'hi' | 'en') => (lang === 'en' ? hourEn(((h % 24) + 24) % 24) : hourHi(h))
export const cigLabel = (c: number, lang: 'hi' | 'en') =>
  lang === 'en' ? (c < 0.1 ? 'less than a tenth of a cigarette' : `about ${Math.round(c * 10) / 10} cigarettes`) : cigHi(c)
