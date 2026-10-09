import { Link } from 'react-router-dom'
import Cigarettes from '../components/Cigarettes'
import HourCurve from '../components/HourCurve'
import { useData } from '../lib/data'
import { category, hourEn, smogColor } from '../lib/model'

const fmtDate = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export default function Landing() {
  const d = useData()
  const h = d.headline
  const over = d.daily_city_mean.filter(x => x.pm25 > d.constants.naaqs_24h).length
  return (
    <main className="landing">
      <section className="hero">
        <div className="hero-copy">
          <h1>A delivery rider's 10-hour shift in Delhi's smog season is {h.typical_shift.cigarettes.toFixed(1)} cigarettes a day.</h1>
          <p className="lede">
            Amazon already stops deliveries from 1 to 4 pm in a heatwave. Smog has no such rule, so riders breathe it all shift without knowing how much.
            RideClean tells each rider their dose in Hindi and gives station managers the pollution version of the heat rule.
          </p>
          <div className="cta-row">
            <Link className="btn primary" to="/rider">Open the rider app</Link>
            <Link className="btn" to="/station">Open the station planner</Link>
          </div>
        </div>
        <div className="hero-meter">
          <Cigarettes value={h.typical_shift.cigarettes} label={`${h.typical_shift.cigarettes} cigarettes per 10am to 8pm shift`} />
          <p>10am to 8pm shift, on the road, typical day</p>
          <p className="cig-scale">1 cigarette ≈ {Math.round(d.constants.cig_ugm3_hours / 24)} µg/m³ of PM2.5 for a day</p>
        </div>
      </section>

      <section className="facts">
        <div><b>{h.times_who}×</b><span>the WHO limit, on average, across {d.meta.stations} monitors</span></div>
        <div><b>{h.pct_hours_over_naaqs}%</b><span>of hours above India's own PM2.5 limit</span></div>
        <div><b>{h.best_vs_worst_saving_pct}%</b><span>less smoke on the best shift ({hourEn(h.best_shift.start)} start) than the worst ({hourEn(h.worst_shift.start)})</span></div>
        <p className="pm-explain">PM2.5 = tiny smoke particles that reach your lungs</p>
      </section>

      <section className="block">
        <h2>When the air is worst</h2>
        <p className="sub">
          Typical PM2.5 by hour across Delhi NCR, {fmtDate(d.meta.period.start)} to {fmtDate(d.meta.period.end)}.
          The worst four hours are {hourEn(h.red_hours.start)} to {hourEn(h.red_hours.end)}; the cleanest are {hourEn(h.clean_hours.start)} to {hourEn(h.clean_hours.end)}.
        </p>
        <HourCurve values={d.city_hourly_median} red={h.red_hours} clean={h.clean_hours} who={d.constants.who_24h} naaqs={d.constants.naaqs_24h} />
      </section>

      <section className="block">
        <h2>Every day of the season</h2>
        <p className="sub">{over} of {d.daily_city_mean.length} days averaged above India's limit of 60 µg/m³. Each square is one day; darker means more smoke.</p>
        <div className="days" role="list">
          {d.daily_city_mean.map(x => (
            <span key={x.date} role="listitem" className="day" style={{ background: smogColor(x.pm25) }}
              title={`${fmtDate(x.date)}: ${Math.round(x.pm25)} µg/m³ (${category(x.pm25).en})`} />
          ))}
        </div>
        <Legend />
      </section>

      <section className="block method">
        <h2>How the numbers are made</h2>
        <ul>
          <li>Hourly PM2.5 from {d.meta.stations} government monitors in Delhi NCR ({d.meta.station_hours.toLocaleString('en-IN')} station-hours), from the OpenAQ archive hosted on AWS Open Data.</li>
          <li>Riders on two-wheelers breathe about 30% more PM2.5 than the nearest monitor shows (Delhi on-road study, Atmospheric Environment, 2015). RideClean multiplies by 1.3.</li>
          <li>22 µg/m³ of PM2.5 for a day is roughly one cigarette (Berkeley Earth). Breathing is faster while riding, so these figures are conservative.</li>
          <li>Clean-air break spots are metro stations from OpenStreetMap. Enclosed spaces cut exposure; an AC car sits at half the road level in the same study.</li>
        </ul>
        <p className="sub">Doses are estimates from monitor data, not personal sensor readings.</p>
      </section>
    </main>
  )
}

export function Legend() {
  const steps = [15, 45, 75, 105, 200, 300]
  return (
    <div className="legend" aria-label="PM2.5 bands">
      {steps.map(s => (
        <span key={s}><i style={{ background: smogColor(s) }} />{category(s).en}</span>
      ))}
    </div>
  )
}
