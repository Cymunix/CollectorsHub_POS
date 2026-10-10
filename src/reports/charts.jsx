import React, { useEffect, useRef, useState } from 'react'

// Draw at the container's real width so text stays at its normal size.
function useWidth(initial = 640) {
  const ref = useRef(null)
  const [width, setWidth] = useState(initial)
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => { const w = Math.round(entry.contentRect.width); if (w > 100) setWidth(w) })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

// Small SVG charts in the CollectorsHub palette. Series colours were checked with the
// palette validator (blue #3B6EA8 then dark gold #B18425 pass contrast and colour-blind
// separation on white). Single-series charts need no legend; two series always get one.
export const SERIES = ['#3B6EA8', '#B18425']
const INK = '#17253D'
const MUTED = '#526176'
const GRID = '#E3E8EF'

const niceMax = (value) => {
  if (!(value > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(value))
  const n = value / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

export function Empty({ title = 'No data for this period', text = 'Completed sales within the selected period will appear here.' }) {
  return <div className="rp-empty"><strong>{title}</strong><span>{text}</span></div>
}

// Horizontal bars: categories, payment methods, employees, locations. Click a bar to drill down.
export function HBars({ rows, label = 'label', value = 'net', format, onSelect, max = 10 }) {
  const list = (rows || []).filter((row) => Number(row[value]) !== 0).slice(0, max)
  if (!list.length) return <Empty />
  const top = Math.max(...list.map((row) => Math.abs(Number(row[value]) || 0)), 0)
  return (
    <div className="rp-hbars" role="list">
      {list.map((row, index) => {
        const v = Number(row[value]) || 0
        const width = top ? Math.max(2, Math.abs(v) / top * 100) : 0
        const Tag = onSelect ? 'button' : 'div'
        return (
          <Tag key={`${row[label]}-${index}`} type={onSelect ? 'button' : undefined} className={`rp-hbar${onSelect ? ' clickable' : ''}`} role="listitem" onClick={onSelect ? () => onSelect(row) : undefined} title={`${row[label]}: ${format(v)}`}>
            <span className="rp-hbar-label">{row[label]}</span>
            <span className="rp-hbar-track"><span className={`rp-hbar-fill${v < 0 ? ' neg' : ''}`} style={{ width: `${width}%` }} /></span>
            <span className="rp-hbar-value">{format(v)}</span>
          </Tag>
        )
      })}
    </div>
  )
}

// Vertical columns with a y axis (hours, weekdays, time series). Hover shows the exact value.
export function Columns({ rows, label = 'label', value = 'net', format, axisLabel, height = 180, onSelect, series = null }) {
  const [hover, setHover] = useState(-1)
  const [box, w] = useWidth()
  const list = rows || []
  if (!list.length || list.every((row) => (series ? series.every((s) => !Number(row[s.key])) : !Number(row[value])))) return <Empty />
  const totals = list.map((row) => (series ? series.reduce((sum, s) => sum + Math.max(0, Number(row[s.key]) || 0), 0) : Math.max(0, Number(row[value]) || 0)))
  const top = niceMax(Math.max(...totals))
  const pad = { l: 56, r: 8, t: 10, b: 28 }
  const plotW = w - pad.l - pad.r
  const plotH = height - pad.t - pad.b
  const step = plotW / list.length
  const barW = Math.max(3, Math.min(36, step - 4))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top)
  const labelEvery = Math.ceil(list.length / Math.max(4, Math.floor(w / 60)))
  return (
    <div className="rp-chart" ref={box}>
      {series ? <div className="rp-legend">{series.map((s, i) => <span key={s.key}><i style={{ background: SERIES[i] }} />{s.label}</span>)}</div> : null}
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={axisLabel || 'Chart'} onMouseLeave={() => setHover(-1)}>
        {ticks.map((tick) => {
          const y = pad.t + plotH - (tick / top) * plotH
          return <g key={tick}><line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke={GRID} strokeWidth="1" /><text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize="11" fill={MUTED}>{format(tick, true)}</text></g>
        })}
        {list.map((row, i) => {
          const x = pad.l + i * step + (step - barW) / 2
          let yBase = pad.t + plotH
          const segs = series ? series.map((s, k) => ({ v: Math.max(0, Number(row[s.key]) || 0), color: SERIES[k] })) : [{ v: Math.max(0, Number(row[value]) || 0), color: SERIES[0] }]
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onClick={onSelect ? () => onSelect(row) : undefined} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
              <rect x={pad.l + i * step} y={pad.t} width={step} height={plotH} fill="transparent" />
              {segs.map((seg, k) => {
                const h = (seg.v / top) * plotH
                yBase -= h
                return h > 0 ? <rect key={k} x={x} y={yBase + (k ? 0 : 0)} width={barW} height={Math.max(0, h - (k < segs.length - 1 ? 0 : 0))} rx="3" fill={seg.color} opacity={hover === -1 || hover === i ? 1 : 0.55} stroke="#fff" strokeWidth={series ? 1 : 0} /> : null
              })}
              {i % labelEvery === 0 ? <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize="11" fill={MUTED}>{row[label]}</text> : null}
            </g>
          )
        })}
        <line x1={pad.l} x2={w - pad.r} y1={pad.t + plotH} y2={pad.t + plotH} stroke={MUTED} strokeWidth="1" />
      </svg>
      {hover >= 0 ? (
        <div className="rp-tooltip"><strong>{list[hover][label]}</strong>{series ? series.map((s, i) => <span key={s.key}><i style={{ background: SERIES[i] }} />{s.label}: {format(Number(list[hover][s.key]) || 0)}</span>) : <span>{format(Number(list[hover][value]) || 0)}{list[hover].count != null ? ` · ${list[hover].count} sale${Number(list[hover].count) === 1 ? '' : 's'}` : ''}</span>}</div>
      ) : <div className="rp-tooltip placeholder">{axisLabel}</div>}
    </div>
  )
}

// Line over time with a hover crosshair.
export function LineChart({ rows, label = 'bucket', value = 'net', format, axisLabel, height = 200, onSelect }) {
  const [hover, setHover] = useState(-1)
  const [box, w] = useWidth()
  const list = rows || []
  if (list.length < 2) return <Columns rows={list} label={label} value={value} format={format} axisLabel={axisLabel} height={height} onSelect={onSelect} />
  const values = list.map((row) => Number(row[value]) || 0)
  const top = niceMax(Math.max(...values, 0))
  const bottom = Math.min(0, ...values)
  const span = top - bottom || 1
  const pad = { l: 56, r: 10, t: 10, b: 28 }
  const plotW = w - pad.l - pad.r
  const plotH = height - pad.t - pad.b
  const xAt = (i) => pad.l + (i / (list.length - 1)) * plotW
  const yAt = (v) => pad.t + plotH - ((v - bottom) / span) * plotH
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')
  const labelEvery = Math.ceil(list.length / Math.max(4, Math.floor(w / 90)))
  return (
    <div className="rp-chart" ref={box}>
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={axisLabel || 'Chart'} onMouseLeave={() => setHover(-1)}
        onMouseMove={(event) => { const box = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - box.left) / box.width * w; setHover(Math.max(0, Math.min(list.length - 1, Math.round((x - pad.l) / plotW * (list.length - 1))))) }}
        onClick={onSelect && hover >= 0 ? () => onSelect(list[hover]) : undefined} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => { const v = bottom + f * span; const y = yAt(v); return <g key={f}><line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke={GRID} /><text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize="11" fill={MUTED}>{format(v, true)}</text></g> })}
        {bottom < 0 ? <line x1={pad.l} x2={w - pad.r} y1={yAt(0)} y2={yAt(0)} stroke={MUTED} /> : null}
        <path d={path} fill="none" stroke={SERIES[0]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {list.map((row, i) => (i % labelEvery === 0 || i === list.length - 1 ? <text key={i} x={xAt(i)} y={height - 8} textAnchor="middle" fontSize="11" fill={MUTED}>{String(row[label]).slice(5)}</text> : null))}
        {hover >= 0 ? <g><line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + plotH} stroke={INK} strokeDasharray="3 3" /><circle cx={xAt(hover)} cy={yAt(values[hover])} r="5" fill={SERIES[0]} stroke="#fff" strokeWidth="2" /></g> : null}
      </svg>
      {hover >= 0 ? <div className="rp-tooltip"><strong>{list[hover][label]}</strong><span>{format(values[hover])}{list[hover].count != null ? ` · ${list[hover].count} sale${Number(list[hover].count) === 1 ? '' : 's'}` : ''}</span></div> : <div className="rp-tooltip placeholder">{axisLabel}</div>}
    </div>
  )
}
