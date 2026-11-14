import type { MemberStatus, Post } from '../types'

export type Edge = { from: string; to: string; count: number; isLatest: boolean }
export type GraphNode = { name: string; status: MemberStatus | 'coordinator' }

// Each member keeps one color everywhere: a theme key for the pane's text, its hex twin for the graph.
const HUES = [
  ['suggestion', '#5b8def'],
  ['success', '#2fa66a'],
  ['warning', '#c9a227'],
  ['permission', '#8b7cf6'],
  ['planMode', '#3f9fa0'],
  ['autoAccept', '#b65fd6'],
  ['remember', '#4fb0c6'],
  ['merged', '#a371f7'],
] as const
export function hueOf(name: string): readonly [string, string] {
  if (name === 'coordinator') return ['claude', '#d97757']
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]!
}

const FONT = 'font-family="-apple-system, system-ui, sans-serif"'

// A member's avatar: a rounded tile in its color with its initials; the coordinator's is a hub.
export function avatarSvg(name: string, size = 28): string {
  const hex = hueOf(name)[1]
  const tile = `<rect x="0.5" y="0.5" width="27" height="27" rx="7" fill="${hex}" fill-opacity="0.14" stroke="${hex}" stroke-opacity="0.35"/>`
  const mark =
    name === 'coordinator'
      ? `<g stroke="${hex}" stroke-width="1.6"><line x1="14" y1="14" x2="14" y2="7.5"/><line x1="14" y1="14" x2="8.4" y2="17.3"/><line x1="14" y1="14" x2="19.6" y2="17.3"/></g>` +
        `<g fill="${hex}"><circle cx="14" cy="14" r="3"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="17.5" r="2"/><circle cx="20" cy="17.5" r="2"/></g>`
      : `<text x="14" y="18.2" text-anchor="middle" font-size="11" font-weight="700" ${FONT} fill="${hex}">${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28">${tile}${mark}</svg>`
}

// The replay's position as a slider: the track, the part played in the accent, a knob at the post shown.
export function scrubSvg(at: number, total: number): string {
  const x = 7 + (346 * at) / Math.max(1, total)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="14" viewBox="0 0 360 14">` +
    `<rect x="7" y="5.5" width="346" height="3" rx="1.5" fill="${'#8b8b8b'}" fill-opacity="0.3"/>` +
    `<rect x="7" y="5.5" width="${(x - 7).toFixed(1)}" height="3" rx="1.5" fill="#d97757"/>` +
    `<circle cx="${x.toFixed(1)}" cy="7" r="5.5" fill="#d97757" stroke="#ffffff" stroke-width="2"/></svg>`
  )
}

// The active tab's underline.
export const barSvg = (width: number, hex: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="2" viewBox="0 0 ${width} 2"><rect width="${width}" height="2" rx="1" fill="${hex}"/></svg>`

// The @mention arrows of the first `upTo` posts, counted, and which arrows the last of them drew.
export function edges(list: Post[], upTo = list.length): Edge[] {
  const shown = list.slice(0, upTo)
  const count = new Map<string, number>()
  for (const p of shown) for (const t of p.to) count.set(`${p.from}\t${t}`, (count.get(`${p.from}\t${t}`) ?? 0) + 1)
  const last = shown.at(-1)
  return [...count].map(([k, n]) => {
    const [from = '', to = ''] = k.split('\t')
    return { from, to, count: n, isLatest: !!last && last.from === from && last.to.includes(to) }
  })
}

// Drawn as an image whose background the mod cannot see: the SVG's own style follows the color scheme,
// and every color it falls back to is a mid tone that reads on light and dark alike.
const INK = '#8b8b8b'
const ACCENT = '#d97757'
const DOT = { active: '#2fa66a', waiting: '#c9a227' } as const
const W = 640
const H = 400
const PILL_H = 32
const STYLE =
  `<style>` +
  `.t{fill:#2b2b2b}.e{stroke:#2b2b2b}.m{fill:#2b2b2b}.p{fill:#ffffff}.c{fill:#6b6b6b}` +
  `@media (prefers-color-scheme: dark){.t{fill:#ececec}.e{stroke:#ececec}.m{fill:#ececec}.p{fill:#1f1f1f}.c{fill:#a8a8a8}}` +
  `</style>`

const pillWidth = (name: string) => Math.max(84, name.length * 8.2 + 46)

// Members as name pills around an ellipse, the coordinator at the top. One curve per direction, so a
// two-way pair bows apart; its width is the post count, the count written beside it, the latest post lit.
export function graphSvg(nodes: GraphNode[], list: Edge[]): string {
  const cx = W / 2
  const cy = H / 2
  const rx = W / 2 - 100
  const ry = H / 2 - 50
  const at = new Map(
    nodes.map((n, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, nodes.length)
      return [n.name, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), hw: pillWidth(n.name) / 2, hh: PILL_H / 2 }] as const
    }),
  )
  // Where the segment from a pill's center toward (dx, dy) leaves the pill.
  const edgeOf = (p: { x: number; y: number; hw: number; hh: number }, dx: number, dy: number, pad: number) => {
    const t = Math.min((p.hw + pad) / (Math.abs(dx) || 1e-9), (p.hh + pad) / (Math.abs(dy) || 1e-9))
    return { x: p.x + dx * t, y: p.y + dy * t }
  }
  const curves: string[] = []
  const labels: string[] = []
  // The latest arrows go last, over the rest.
  for (const e of [...list].sort((a, b) => Number(a.isLatest) - Number(b.isLatest))) {
    const a = at.get(e.from)
    const b = at.get(e.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    // The bend is to the right of the direction of travel, so A→B and B→A part ways.
    const bend = Math.min(46, len * 0.16)
    const qx = (a.x + b.x) / 2 + (-dy / len) * bend
    const qy = (a.y + b.y) / 2 + (dx / len) * bend
    const s0 = edgeOf(a, qx - a.x, qy - a.y, 3)
    const s1 = edgeOf(b, qx - b.x, qy - b.y, 7)
    const width = Math.min(4.5, 1.1 + e.count * 0.55)
    curves.push(
      e.isLatest
        ? `<path d="M${f(s0.x)} ${f(s0.y)}Q${f(qx)} ${f(qy)} ${f(s1.x)} ${f(s1.y)}" fill="none" stroke="${ACCENT}" stroke-width="${f(width + 0.6)}" stroke-linecap="round" marker-end="url(#hot)"/>`
        : `<path class="e" d="M${f(s0.x)} ${f(s0.y)}Q${f(qx)} ${f(qy)} ${f(s1.x)} ${f(s1.y)}" fill="none" stroke="${INK}" stroke-opacity="0.38" stroke-width="${f(width)}" stroke-linecap="round" marker-end="url(#tip)"/>`,
    )
    if (e.count > 1 || e.isLatest) {
      // The count sits just outside the curve's midpoint, on the side it bows to.
      const mx = 0.25 * s0.x + 0.5 * qx + 0.25 * s1.x + (-dy / len) * 11
      const my = 0.25 * s0.y + 0.5 * qy + 0.25 * s1.y + (dx / len) * 11 + 4
      labels.push(
        `<text x="${f(mx)}" y="${f(my)}" text-anchor="middle" font-size="12" font-weight="600" ${FONT} ${e.isLatest ? `fill="${ACCENT}"` : `class="c" fill="${INK}"`}>${e.count}</text>`,
      )
    }
  }
  const pills = nodes.flatMap(n => {
    const p = at.get(n.name)!
    const gone = n.status === 'killed'
    const hue = n.status === 'coordinator' ? ACCENT : hueOf(n.name)[1]
    const x = p.x - p.hw
    const y = p.y - p.hh
    const ring =
      n.status === 'active'
        ? `<circle cx="${f(x + 18)}" cy="${f(p.y)}" r="4.5" fill="${DOT.active}"/>`
        : n.status === 'waiting'
          ? `<circle cx="${f(x + 18)}" cy="${f(p.y)}" r="4" fill="none" stroke="${DOT.waiting}" stroke-width="1.8"/>`
          : n.status === 'coordinator'
            ? `<circle cx="${f(x + 18)}" cy="${f(p.y)}" r="4.5" fill="${ACCENT}"/>`
            : `<circle cx="${f(x + 18)}" cy="${f(p.y)}" r="4" fill="none" stroke="${INK}" stroke-width="1.5"/>`
    return [
      `<rect class="p" x="${f(x)}" y="${f(y)}" width="${f(p.hw * 2)}" height="${PILL_H}" rx="${PILL_H / 2}" fill="#ffffff" fill-opacity="0.9"/>`,
      `<rect x="${f(x)}" y="${f(y)}" width="${f(p.hw * 2)}" height="${PILL_H}" rx="${PILL_H / 2}" fill="${hue}" fill-opacity="${gone ? 0.04 : 0.1}" stroke="${gone ? INK : hue}" stroke-width="1.5"${gone ? ' stroke-dasharray="4 3"' : ''}/>`,
      ring,
      `<text x="${f(x + 30)}" y="${f(p.y + 4.5)}" font-size="13.5" font-weight="${n.status === 'coordinator' ? 650 : 550}" ${FONT} ${gone ? `fill="${INK}"` : 'class="t" fill="#2b2b2b"'}>${n.name}</text>`,
    ]
  })
  const marker = (id: string, color: string, cls = '') =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path ${cls} d="M0 1L10 5L0 9z" fill="${color}"/></marker>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${STYLE}` +
    `<defs>${marker('tip', INK, 'fill-opacity="0.6"')}${marker('hot', ACCENT)}</defs>${curves.join('')}${labels.join('')}${pills.join('')}</svg>`
  )
}

const f = (n: number) => n.toFixed(1)
