// The dose meter: smoke breathed, drawn as cigarettes burned down.
type Props = { value: number; max?: number; size?: 'lg' | 'sm'; label?: string }

export default function Cigarettes({ value, max = 10, size = 'lg', label }: Props) {
  const v = Math.max(0, value)
  const n = Math.min(max, Math.max(1, Math.ceil(v)))
  const w = size === 'lg' ? 26 : 16
  const h = size === 'lg' ? 132 : 78
  const filter = h * 0.24
  const paper = h - filter
  return (
    <div className={`cigs cigs-${size}`} role="img" aria-label={label ?? `${v.toFixed(1)} cigarettes`}>
      {Array.from({ length: n }, (_, i) => {
        const burnt = Math.min(1, Math.max(0, v - i)) // 1 = smoked down to the filter
        const left = paper * (1 - burnt)
        const active = i === n - 1 && burnt < 1 && burnt > 0
        return (
          <svg key={i} width={w} height={h + 26} viewBox={`0 0 ${w} ${h + 26}`} aria-hidden>
            {active && (
              <path className="smoke" d={`M${w / 2} ${26 + h - filter - left - 2} c -6 -6 6 -10 0 -16 c -5 -5 5 -8 0 -12`}
                fill="none" stroke="var(--smoke)" strokeWidth="2" strokeLinecap="round" />
            )}
            {left > 0 && <rect x={1} y={26 + h - filter - left} width={w - 2} height={left} rx={2} fill="var(--paper-white)" stroke="var(--line)" />}
            {left > 0 && burnt > 0 && <rect x={1} y={26 + h - filter - left} width={w - 2} height={Math.min(5, left)} rx={2} fill="var(--ember)" />}
            {burnt >= 1 && <rect x={2} y={26 + h - filter - 6} width={w - 4} height={6} rx={2} fill="var(--ash)" />}
            <rect x={1} y={26 + h - filter} width={w - 2} height={filter} rx={2} fill="var(--filter)" />
          </svg>
        )
      })}
      {Math.ceil(v) > max && <span className="cigs-more">+{Math.ceil(v) - max}</span>}
    </div>
  )
}
