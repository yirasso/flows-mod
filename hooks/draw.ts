// The pane's drawings for the desktop app: each is one SVG, drawn from plain values, with no engine in it.
// The worker of an agent step is a pixel crab in the costume of the step's role, which walks while it works.
// The technique (rects on a grid, grouped by class, moved by CSS) follows the savvy-progress mod; the crab
// and its wardrobe are drawn from scratch here.

/** Where a step stands, as its row draws it. `starting` is an agent step whose agent has not started yet. */
export type Tone = 'pending' | 'starting' | 'running' | 'waiting' | 'done' | 'failed' | 'ended'
export type StepKind = 'agent' | 'code' | 'approval' | 'each'

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
const CLAY = '#D97757'
const INK = '#1F1E1D'
const WOOD = '#7A5A3A'
const STEEL = '#8A8A86'
/** Paper is a class, not a color: near white on the dark theme, a shade darker on the light one, to show on both. */
const PAPER = '.pp'
const GREEN = '#2E9E6B'
const RED = '#D8443C'
const AMBER = '#D9962B'

/** Each role's accent, the color of its costume and of its row. */
export const ROLE_COLOR: Record<string, string> = {
  researcher: '#378ADD',
  writer: '#7F77DD',
  builder: '#E39A1F',
  designer: '#D4537E',
  coder: '#1D9E75',
  reviewer: '#639922',
  analyst: '#0F9AA8',
  messenger: '#E0524A',
}
const PLAIN = '#8A8A86'
export const colorOf = (role: string | undefined): string => ROLE_COLOR[role ?? ''] ?? PLAIN

// Text and surfaces in both themes. The motion plays whatever the system says about animations: Tomás keeps
// them off in Windows and wants his own tools to move all the same (his rule in Nau too).
const CSS = `<style>
.t{fill:#1c1c1a}.s{fill:#66665f}.m{fill:#9a9a93}.k{fill:#e8e7e3}.tile{fill:#f2f1ed}.pp{fill:#cfcdc4}
@media (prefers-color-scheme: dark){.t{fill:#eeeeec}.s{fill:#a6a6a0}.m{fill:#77776f}.k{fill:#2f2f2d}.tile{fill:#252523}.pp{fill:#f4f3ee}}
.live{animation:pulse 1s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}
.run .la{animation:step .5s steps(1) infinite}.run .lb{animation:step .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run .it{transform-box:fill-box;transform-origin:50% 100%;animation:wag 1s ease-in-out infinite}
@keyframes step{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}@keyframes wag{50%{transform:rotate(12deg)}}
</style>`

export const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A text cut to the width it has, by what a letter of that size takes on average. */
export function fit(text: string, size: number, width: number): string {
  const line = oneLine(text)
  const room = Math.max(1, Math.floor(width / (size * 0.54)))
  return line.length > room ? `${line.slice(0, Math.max(1, room - 1))}…` : line
}

/** A text broken into at most `lines` lines of the width it has; the last one is cut. */
function wrap(text: string, size: number, width: number, lines: number): string[] {
  const room = Math.max(8, Math.floor(width / (size * 0.54)))
  const out: string[] = []
  let line = ''
  for (const word of oneLine(text).split(' ')) {
    if (!line || `${line} ${word}`.length <= room) line = line ? `${line} ${word}` : word
    else {
      out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out.length > lines ? [...out.slice(0, lines - 1), fit(out.slice(lines - 1).join(' '), size, width)] : out
}

// ——— The characters: a 30×28 grid ———

type Put = (x: number, y: number, w: number, h: number, color: string, part?: 'la' | 'lb' | 'it') => void

/** The crab itself: body, eyes, claws and four legs. */
function body(put: Put): void {
  put(8, 10, 14, 1, CLAY)
  put(7, 11, 16, 10, CLAY)
  put(8, 21, 14, 1, CLAY)
  put(11, 14, 2, 3, INK)
  put(17, 14, 2, 3, INK)
  put(4, 15, 3, 2, CLAY)
  put(2, 12, 3, 3, CLAY)
  put(23, 15, 3, 2, CLAY)
  put(25, 12, 3, 3, CLAY)
  put(9, 22, 2, 3, CLAY, 'la')
  put(13, 22, 2, 3, CLAY, 'lb')
  put(16, 22, 2, 3, CLAY, 'la')
  put(20, 22, 2, 3, CLAY, 'lb')
}

/** What each role wears and holds; the held thing (`it`) moves while the crab works. */
const WARDROBE: Record<string, (put: Put, c: string) => void> = {
  // A deerstalker and a magnifying glass.
  researcher: (put, c) => {
    put(10, 6, 10, 3, WOOD)
    put(10, 8, 10, 1, c)
    put(8, 9, 14, 1, '#5E4429')
    put(25, 5, 4, 5, c, 'it')
    put(26, 6, 2, 3, '#CFE6FB', 'it')
    put(26, 10, 1, 2, '#5E4429', 'it')
  },
  // A scarf and a quill.
  writer: (put, c) => {
    put(8, 19, 14, 1, c)
    put(19, 20, 2, 3, c)
    put(26, 6, 1, 6, '#5E4429', 'it')
    put(25, 2, 3, 5, PAPER, 'it')
    put(24, 3, 1, 3, c, 'it')
    put(26, 1, 1, 1, PAPER, 'it')
  },
  // A hard hat and a hammer.
  builder: (put, c) => {
    put(14, 4, 2, 1, c)
    put(10, 5, 10, 4, c)
    put(8, 9, 14, 1, c)
    put(26, 6, 1, 6, WOOD, 'it')
    put(24, 4, 5, 2, STEEL, 'it')
  },
  // A beret and a paintbrush.
  designer: (put, c) => {
    put(15, 5, 1, 1, c)
    put(10, 6, 11, 2, c)
    put(9, 8, 13, 1, c)
    put(26, 6, 1, 6, WOOD, 'it')
    put(26, 5, 1, 1, STEEL, 'it')
    put(26, 2, 1, 3, c, 'it')
  },
  // Headphones and a laptop.
  coder: (put, c) => {
    put(9, 7, 12, 1, '#3A3A38')
    put(8, 8, 1, 3, '#3A3A38')
    put(21, 8, 1, 3, '#3A3A38')
    put(6, 11, 2, 4, c)
    put(22, 11, 2, 4, c)
    put(24, 10, 5, 5, '#3A3A38', 'it')
    put(25, 11, 3, 3, c, 'it')
    put(23, 15, 7, 1, STEEL, 'it')
  },
  // Glasses and a clipboard.
  reviewer: (put, c) => {
    for (const x of [10, 16]) {
      put(x, 13, 4, 1, c)
      put(x, 17, 4, 1, c)
      put(x, 14, 1, 3, c)
      put(x + 3, 14, 1, 3, c)
    }
    put(14, 15, 2, 1, c)
    put(24, 5, 5, 7, PAPER, 'it')
    put(25, 4, 3, 1, STEEL, 'it')
    put(25, 7, 3, 1, c, 'it')
    put(25, 9, 3, 1, STEEL, 'it')
  },
  // A visor and a bar chart.
  analyst: (put, c) => {
    put(8, 8, 14, 2, c)
    put(5, 9, 4, 1, c)
    put(24, 8, 1, 3, c, 'it')
    put(26, 6, 1, 5, c, 'it')
    put(28, 4, 1, 7, c, 'it')
    put(24, 11, 5, 1, STEEL, 'it')
  },
  // A cap and a letter.
  messenger: (put, c) => {
    put(10, 6, 10, 3, c)
    put(18, 9, 6, 1, c)
    put(24, 6, 6, 5, PAPER, 'it')
    put(24, 6, 1, 1, c, 'it')
    put(25, 7, 1, 1, c, 'it')
    put(26, 8, 2, 1, c, 'it')
    put(28, 7, 1, 1, c, 'it')
    put(29, 6, 1, 1, c, 'it')
  },
}

/** The drawings of the steps that are not agents, in one color. */
const ICONS: Record<Exclude<StepKind, 'agent'>, (put: Put, c: string) => void> = {
  // A terminal window with a prompt.
  code: (put, c) => {
    put(5, 6, 20, 3, c)
    put(5, 9, 1, 13, c)
    put(24, 9, 1, 13, c)
    put(5, 21, 20, 1, c)
    put(8, 12, 2, 2, c)
    put(10, 14, 2, 2, c)
    put(8, 16, 2, 2, c)
    put(14, 17, 6, 2, c)
  },
  // A raised hand.
  approval: (put, c) => {
    put(9, 8, 2, 6, c)
    put(12, 5, 2, 9, c)
    put(15, 6, 2, 8, c)
    put(18, 9, 2, 5, c)
    put(9, 13, 11, 8, c)
    put(5, 13, 3, 3, c)
    put(7, 15, 2, 3, c)
    put(11, 21, 8, 3, c)
  },
  // A stack of three.
  each: (put, c) => {
    put(8, 6, 14, 4, c)
    put(8, 12, 14, 4, c)
    put(8, 18, 14, 4, c)
  },
}

/** One step's picture at `x,y`, `scale` times its 30×28 grid: the role's crab, or the kind's drawing. */
export function picture(x: number, y: number, scale: number, kind: StepKind, role: string | undefined, tone: Tone): string {
  const parts: Record<string, string[]> = { bd: [], la: [], lb: [], it: [] }
  const put: Put = (px, py, w, h, color, part) => void parts[part ?? 'bd']?.push(`<rect x="${px}" y="${py}" width="${w}" height="${h}" ${color.startsWith('.') ? `class="${color.slice(1)}"` : `fill="${color}"`}/>`)
  if (kind === 'agent') {
    body(put)
    WARDROBE[role ?? '']?.(put, colorOf(role))
  } else ICONS[kind](put, tone === 'waiting' ? AMBER : tone === 'failed' ? RED : tone === 'done' ? GREEN : STEEL)
  const dim = tone === 'pending' || tone === 'ended' ? ' opacity="0.45"' : ''
  const groups = Object.entries(parts).map(([part, rects]) => (rects.length ? `<g class="${part}">${rects.join('')}</g>` : ''))
  return `<g transform="translate(${x} ${y}) scale(${scale})" shape-rendering="crispEdges"${tone === 'running' ? ' class="run"' : ''}${dim}>${groups.join('')}</g>`
}

// ——— The pane's parts ———

const svg = (w: number, h: number, inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${CSS}${inner}</svg>`
const text = (x: number, y: number, size: number, cls: string, value: string, more = ''): string => `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${more}>${xml(value)}</text>`
const END = ' text-anchor="end" font-variant-numeric="tabular-nums"'
const toneColor = (tone: Tone, accent: string): string => (tone === 'failed' ? RED : tone === 'waiting' ? AMBER : accent)

/** What a row shows at its right edge: a tick, a cross, a pulsing dot, or a word. */
function mark(w: number, y: number, tone: Tone, accent: string): string {
  if (tone === 'done') return `<path d="M${w - 13} ${y - 4} l3.5 3.5 l7 -8" fill="none" stroke="${GREEN}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (tone === 'failed') return `<path d="M${w - 11} ${y - 9} l8 8 m0 -8 l-8 8" fill="none" stroke="${RED}" stroke-width="1.8" stroke-linecap="round"/>`
  if (tone === 'running') return `<circle class="live" cx="${w - 6}" cy="${y - 4}" r="4" fill="${accent}"/>`
  if (tone === 'waiting') return text(w, y, 11, 's', 'needs you', `${END} style="fill:${AMBER}"`)
  if (tone === 'starting') return text(w, y, 11, 's', 'starting', END)
  return ''
}

export type HeaderData = {
  name: string
  description: string
  /** `Run 2 · done`, or nothing before the first run. */
  run: string
  tone: Tone
  /** The three tiles: what the run took of the week, its tokens, its time. */
  week: string
  tokens: string
  time: string
  /** The weekly limit's percent used now, or null when the session does not say. */
  limit: number | null
  /** Why the run ended early, or what is wrong with the flow. */
  note: string
  isError: boolean
}

/** The top of the pane: the flow, its run, three tiles and the weekly limit. */
export function header(w: number, d: HeaderData): { source: string; height: number } {
  const lines = d.description ? wrap(d.description, 12, w, 2) : []
  let y = 16
  let out = text(0, y, 15, 't', fit(d.name, 15, w - 150), ' font-weight="700"')
  if (d.run) {
    const color = d.tone === 'done' ? GREEN : d.tone === 'running' ? CLAY : toneColor(d.tone, STEEL)
    out += text(w - 13, y, 12, 's', d.run, END)
    out += `<circle${d.tone === 'running' ? ' class="live"' : ''} cx="${w - 4}" cy="${y - 4}" r="3.5" fill="${color}"/>`
  }
  for (const line of lines) out += text(0, (y += 17), 12, 's', line)
  y += 12
  const gap = 8
  const tw = (w - gap * 2) / 3
  for (const [i, [label, value]] of [['Week', d.week], ['Tokens', d.tokens], ['Time', d.time]].entries()) {
    const x = i * (tw + gap)
    out += `<rect class="tile" x="${x}" y="${y}" width="${tw}" height="46" rx="8"/>`
    out += text(x + 10, y + 17, 11, 's', label ?? '')
    out += text(x + 10, y + 36, 15, 't', value ?? '', ' font-weight="600" font-variant-numeric="tabular-nums"')
  }
  y += 46
  if (d.limit !== null) {
    const used = Math.max(0, Math.min(100, d.limit))
    y += 20
    out += text(0, y, 11, 's', 'Weekly limit')
    out += text(w, y, 11, 's', `${Math.round(used)}% used`, END)
    y += 7
    out += `<rect class="k" x="0" y="${y}" width="${w}" height="4" rx="2"/>`
    out += `<rect x="0" y="${y}" width="${Math.max(used > 0 ? 4 : 0, (w * used) / 100)}" height="4" rx="2" fill="${used >= 85 ? RED : used >= 65 ? AMBER : CLAY}"/>`
    y += 4
  }
  if (d.note) out += text(0, (y += 19), 11, 's', fit(d.note, 11, w), d.isError ? ` style="fill:${RED}"` : '')
  return { source: svg(w, y + 6, out), height: y + 6 }
}

export type RowData = {
  kind: StepKind
  role?: string
  tone: Tone
  /** `1. Find three facts`. */
  title: string
  /** `researcher`, colored, for an agent; empty otherwise. */
  tag: string
  /** `haiku · low`, `code`, `for each · 3 at once`. */
  meta: string
  /** `0:04 · 6.9k`. */
  stats: string
  /** The start of what the step handed on, its error, or what it waits for. */
  line: string
}

/** One step: its picture, its name, what runs it, how it went, and a line about its result. */
export function row(w: number, d: RowData): { source: string; height: number } {
  const accent = d.kind === 'agent' ? colorOf(d.role) : STEEL
  const x = 50
  const quiet = d.tone === 'pending' || d.tone === 'ended'
  let out = picture(0, 5, 1.3, d.kind, d.role, d.tone)
  out += text(x, 17, 13, quiet ? 's' : 't', fit(d.title, 13, w - x - 70), ' font-weight="600"')
  out += mark(w, 17, d.tone, accent)
  const meta = fit(d.meta, 11, w - x - (d.tag.length + d.stats.length) * 6.2 - 24)
  out += `<text x="${x}" y="33" font-family="${FONT}" font-size="11">${d.tag ? `<tspan fill="${accent}">${xml(d.tag)}</tspan><tspan class="${quiet ? 'm' : 's'}" dx="7">${xml(meta)}</tspan>` : `<tspan class="${quiet ? 'm' : 's'}">${xml(meta)}</tspan>`}</text>`
  if (d.stats) out += text(w, 33, 11, 's', d.stats, END)
  out += `<rect class="k" x="${x}" y="40" width="${w - x}" height="3" rx="1.5"/>`
  if (!quiet && d.tone !== 'starting') out += `<rect${d.tone === 'running' || d.tone === 'waiting' ? ' class="live"' : ''} x="${x}" y="40" width="${w - x}" height="3" rx="1.5" fill="${d.tone === 'done' ? accent : toneColor(d.tone, accent)}"/>`
  if (!d.line) return { source: svg(w, 50, out), height: 50 }
  out += text(x, 58, 11, 'm', fit(d.line, 11, w - x), d.tone === 'failed' ? ` style="fill:${RED}"` : d.tone === 'waiting' ? ` style="fill:${AMBER}"` : '')
  return { source: svg(w, 66, out), height: 66 }
}

export type ItemData = { role?: string; tone: Tone; label: string; stats: string; line: string }

/** One item of a for-each, under its step: a small worker, the item, and a line about its result. */
export function item(w: number, d: ItemData): { source: string; height: number } {
  const accent = colorOf(d.role)
  const x = 90
  const quiet = d.tone === 'pending' || d.tone === 'ended'
  let out = `<rect class="k" x="56" y="0" width="2" height="${d.line ? 40 : 26}" rx="1"/>`
  out += picture(62, 3, 0.62, 'agent', d.role, d.tone)
  out += text(x, 15, 12, quiet ? 's' : 't', fit(d.label, 12, w - x - d.stats.length * 6.2 - 30))
  if (d.stats) out += text(w - 22, 15, 11, 's', d.stats, END)
  out += mark(w, 15, d.tone === 'waiting' || d.tone === 'starting' ? 'pending' : d.tone, accent)
  if (!d.line) return { source: svg(w, 26, out), height: 26 }
  out += text(x, 32, 11, 'm', fit(d.line, 11, w - x), d.tone === 'failed' ? ` style="fill:${RED}"` : d.tone === 'waiting' ? ` style="fill:${AMBER}"` : '')
  return { source: svg(w, 40, out), height: 40 }
}
