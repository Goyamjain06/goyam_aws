// 24-hour PM2.5 profile with the "red hours" and "clean hours" windows marked. Hover for values.
import { useState } from 'react'
import { category, hourEn } from '../lib/model'

type Props = { values: number[]; red: { start: number; end: number }; clean: { start: number; end: number }; who: number; naaqs: number }

export default function HourCurve({ values, red, clean, who, naaqs }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720, H = 240, L = 44, R = 12, T = 16, B = 30
  const max = Math.ceil(Math.max(...values, naaqs) / 50) * 50
  const x = (h: number) => L + (h / 23) * (W - L - R)
  const y = (v: number) => T + (1 - v / max) * (H - T - B)
  const path = values.map((v, h) => `${h ? 'L' : 'M'}${x(h)},${y(v)}`).join(' ')
  const band = (w: { start: number; end: number }, cls: string, text: string) => {
    const s = w.start, e = w.end > w.start ? w.end : w.end + 24
    const segs = e <= 24 ? [[s, e]] : [[s, 24], [0, e - 24]]
    const labelSeg = segs.reduce((best, sg, i) => (sg[1] - sg[0] > segs[best][1] - segs[best][0] ? i : best), 0)
    return segs.map(([a, b], i) => (
      <g key={cls + i}>
        <rect className={cls} x={x(Math.min(a, 23))} y={T} width={Math.max(4, x(Math.min(b, 23.99)) - x(Math.min(a, 23)))} height={H - T - B} />
        {i === labelSeg && <text className="band-label" x={x(Math.min(a, 23)) + 6} y={T + 14}>{text}</text>}
      </g>
    ))
  }
  const ticks = Array.from({ length: max / 50 + 1 }, (_, i) => i * 50)
  return (
    <figure className="hour-curve">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Typical PM2.5 by hour of day in Delhi NCR"
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((e.clientX - r.left) / r.width) * W
          setHover(Math.max(0, Math.min(23, Math.round(((px - L) / (W - L - R)) * 23))))
        }}>
        {band(red, 'win-red', 'Red hours')}
        {band(clean, 'win-clean', 'Cleanest hours')}
        {ticks.map(t => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text className="axis" x={L - 8} y={y(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        <line className="ref" x1={L} x2={W - R} y1={y(naaqs)} y2={y(naaqs)} />
        <text className="ref-label" x={W - R} y={y(naaqs) - 6} textAnchor="end">India's limit, 60</text>
        <line className="ref who" x1={L} x2={W - R} y1={y(who)} y2={y(who)} />
        <text className="ref-label" x={W - R} y={y(who) - 6} textAnchor="end">WHO limit, 15</text>
        <path className="curve" d={path} />
        {[0, 6, 12, 18, 23].map(h => <text key={h} className="axis" x={x(h)} y={H - 8} textAnchor="middle">{hourEn(h)}</text>)}
        {hover !== null && (
          <g>
            <line className="cross" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} />
            <circle className="dot" cx={x(hover)} cy={y(values[hover])} r={5} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{hourEn(hover)}</strong> {Math.round(values[hover])} µg/m³, {category(values[hover]).en.toLowerCase()}
        </div>
      )}
    </figure>
  )
}
