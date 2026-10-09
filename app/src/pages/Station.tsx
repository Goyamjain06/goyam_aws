import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { liveAll } from '../lib/api'
import { useData } from '../lib/data'
import * as m from '../lib/model'
import type { AQData } from '../lib/model'
import { Legend } from './Landing'

const NAMES = ['Ramesh', 'Sunil', 'Arif', 'Pooja', 'Deepak', 'Imran', 'Vikas', 'Sanjay', 'Neha', 'Ravi', 'Ajay', 'Salman',
  'Manoj', 'Kavita', 'Rohit', 'Anil', 'Farhan', 'Gaurav', 'Sachin', 'Mohit']

type Rider = { name: string; zone: string; start: number }

// A made-up roster so the planner has something to plan. A real station would load its own.
function roster(d: AQData): Rider[] {
  const starts = [7, 8, 9, 10, 10, 11, 12, 13, 14]
  return NAMES.map((name, i) => ({ name, zone: d.zones[(i * 7) % d.zones.length].name, start: starts[(i * 5) % starts.length] }))
}

function shiftCigs(d: AQData, zone: string, start: number, scale = 1) {
  const z = d.zones.find(x => x.name === zone)!
  let sum = 0
  for (let i = 0; i < d.constants.shift_hours; i++) sum += z.hourly_median[(start + i) % 24]
  return m.cigarettes(d, sum * d.constants.onroad_factor * scale)
}

// Cleanest 10-hour start for this zone, kept inside working hours (6am to 2pm start)
function bestStart(d: AQData, zone: string) {
  let best = 6
  for (let s = 6; s <= 14; s++) if (shiftCigs(d, zone, s) < shiftCigs(d, zone, best)) best = s
  return best
}

export default function Station() {
  const d = useData()
  const [live, setLive] = useState<Map<number, number> | null>(null)
  const [applied, setApplied] = useState(false)
  useEffect(() => {
    liveAll().then(rows => {
      if (rows) setLive(new Map(rows.filter(r => r.live && r.pm25 != null).map(r => [r.id, r.pm25 as number])))
    })
  }, [])

  const riders = useMemo(() => roster(d), [d])
  const plan = useMemo(() => riders.map(r => {
    const now = shiftCigs(d, r.zone, r.start)
    const bs = bestStart(d, r.zone)
    const better = shiftCigs(d, r.zone, bs)
    return { ...r, now, bestStart: bs, better, gain: now - better }
  }).sort((a, b) => b.now - a.now), [d, riders])
  const flagged = plan.filter(p => p.gain / p.now >= 0.1)
  const before = plan.reduce((a, p) => a + p.now, 0)
  const after = plan.reduce((a, p) => a + (applied && flagged.includes(p) ? p.better : p.now), 0)
  const h = d.headline

  return (
    <main className="station">
      <section className="st-head">
        <div>
          <h1>Station planner</h1>
          <p className="sub">Delhi NCR, typical air from {d.meta.stations} monitors, {d.meta.period.start} to {d.meta.period.end}.{live ? ` Live readings from ${live.size} monitors.` : ''}</p>
        </div>
        <div className="rule">
          <p>The smog rule for this season</p>
          <b>{m.hourEn(h.red_hours.start)} to {m.hourEn(h.red_hours.end)}</b>
          <span>Worst four hours, averaging {Math.round(h.red_hours.avg_pm25)} µg/m³. Keep riders off the road or near a break spot.</span>
        </div>
      </section>

      <section className="block">
        <h2>Smoke by zone and hour</h2>
        <p className="sub">Typical PM2.5 at street level for each zone. The outlined band is the red hours window. Hover a cell for the value.</p>
        <Heatmap d={d} />
        <Legend />
      </section>

      <section className="block">
        <div className="fleet-head">
          <div>
            <h2>Today's roster</h2>
            <p className="sub">Example roster of {plan.length} riders on 10-hour shifts. Riders whose dose drops by 10% or more with a different start time are marked.</p>
          </div>
          <div className="fleet-total">
            <span>Fleet dose today</span>
            <b>{after.toFixed(1)} <small>cigarettes</small></b>
            {applied && <em>{Math.round((1 - after / before) * 100)}% less than the current roster</em>}
            <button className={`btn ${applied ? '' : 'primary'}`} onClick={() => setApplied(a => !a)}>
              {applied ? 'Undo the new shift times' : `Move ${flagged.length} riders to cleaner shifts`}
            </button>
          </div>
        </div>
        <table className="roster">
          <thead><tr><th>Rider</th><th>Zone</th><th>Shift</th><th className="num">Dose</th><th>Cleaner start</th></tr></thead>
          <tbody>
            {plan.map(p => {
              const moved = applied && flagged.includes(p)
              const start = moved ? p.bestStart : p.start
              const dose = moved ? p.better : p.now
              return (
                <tr key={p.name} className={moved ? 'moved' : ''}>
                  <td>{p.name}</td>
                  <td>{p.zone}</td>
                  <td>{m.hourEn(start)} to {m.hourEn((start + 10) % 24)}</td>
                  <td className="num"><span className="dose-bar" style={{ width: `${Math.min(100, (dose / plan[0].now) * 100)}%` }} />{dose.toFixed(2)}</td>
                  <td>{flagged.includes(p) ? (moved ? 'Moved' : `${m.hourEn(p.bestStart)}, ${Math.round((p.gain / p.now) * 100)}% less`) : 'Already near the best'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="block">
        <h2>Where the next rest points should go</h2>
        <p className="sub">Metro stations ranked by the street-level smoke around them from 9am to 9pm. Combine with delivery density to choose sites for new rest points.</p>
        <div className="siting">
          <SitingMap d={d} live={live} />
          <ol className="site-list">
            {d.siting.slice(0, 10).map(s => (
              <li key={s.name}>
                <span>{s.name}<small>{s.zone}</small></span>
                <b>{s.rider_cigs_per_shift.toFixed(1)}<small> cig/shift</small></b>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </main>
  )
}

function Heatmap({ d }: { d: AQData }) {
  const [tip, setTip] = useState<{ z: string; h: number; v: number } | null>(null)
  const { start, end } = d.headline.red_hours
  const inRed = (h: number) => (end > start ? h >= start && h < end : h >= start || h < end)
  return (
    <div className="heat-wrap" onMouseLeave={() => setTip(null)}>
      <table className="heat">
        <thead>
          <tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className={inRed(h) ? 'red' : ''}>{h % 3 === 0 ? m.hourEn(h) : ''}</th>)}</tr>
        </thead>
        <tbody>
          {d.zones.map(z => (
            <tr key={z.name}>
              <th scope="row">{z.name}</th>
              {z.hourly_median.map((v, h) => {
                const onroad = v * d.constants.onroad_factor
                return (
                  <td key={h} className={inRed(h) ? 'red' : ''} style={{ background: m.smogColor(onroad) }}
                    onMouseEnter={() => setTip({ z: z.name, h, v: onroad })}
                    aria-label={`${z.name}, ${m.hourEn(h)}: ${Math.round(onroad)}`} />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="heat-tip" aria-live="polite">
        {tip ? <><b>{tip.z}, {m.hourEn(tip.h)}</b>: {Math.round(tip.v)} µg/m³ on the road ({m.category(tip.v).en.toLowerCase()}), {(tip.v / d.constants.who_24h).toFixed(0)}× the WHO limit</> : 'Hover a cell to see the value.'}
      </p>
    </div>
  )
}

const pin = (n: number) => L.divIcon({ className: 'pin', html: `<span>${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] })

function SitingMap({ d, live }: { d: AQData; live: Map<number, number> | null }) {
  const hour = m.istHour()
  return (
    <MapContainer center={[28.62, 77.2]} zoom={10} scrollWheelZoom={false} className="map">
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
      {d.stations.map(s => {
        const pm = live?.get(s.id) ?? s.hourly_median[hour]
        return (
          <CircleMarker key={s.id} center={[s.lat, s.lon]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: m.smogColor(pm), fillOpacity: 1 }}>
            <Tooltip>{s.name}: {Math.round(pm)} µg/m³ {live?.has(s.id) ? 'now' : `typical at ${m.hourEn(hour)}`}</Tooltip>
          </CircleMarker>
        )
      })}
      {d.siting.slice(0, 10).map((s, i) => (
        <Marker key={s.name} position={[s.lat, s.lon]} icon={pin(i + 1)}>
          <Tooltip>{i + 1}. {s.name}: {s.rider_cigs_per_shift.toFixed(1)} cigarettes per shift</Tooltip>
        </Marker>
      ))}
    </MapContainer>
  )
}
