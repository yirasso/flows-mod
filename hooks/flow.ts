// The rules of a flow and of a run, with no engine in them: reading a flow.json, where a run's files go,
// and every change a run goes through. register.tsx does the work these decide.

import type { Flow, FlowInput, FlowStep, JsonSchema, Run, RunStatus, StepRun, Track } from '../types'

export const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/
const TYPES = ['agent', 'code', 'approval', 'each']
/** What an agent step may always use: reading, the web, and writing (which the folder check narrows). */
export const BASE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Write', 'Edit']
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
export const PREVIEW = 2000
export const MAX_ITEMS = 100

/** A flow.json's text as a flow, or the flow with `error` saying what is wrong with it. */
export function parseFlow(name: string, text: string): Flow {
  const bad = (error: string): Flow => ({ name, description: '', steps: [], error })
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return bad('flow.json is not valid JSON')
  }
  if (!raw || typeof raw !== 'object') return bad('flow.json is not an object')
  const f = raw as { description?: unknown; cwd?: unknown; inputs?: unknown; maxTokens?: unknown; steps?: unknown }
  if (!Array.isArray(f.steps) || f.steps.length === 0) return bad('flow.json has no steps')
  if (f.inputs !== undefined && (!Array.isArray(f.inputs) || f.inputs.some(x => !x || typeof x !== 'object' || typeof (x as FlowInput).id !== 'string' || !/^[a-zA-Z][\w-]{0,47}$/.test((x as FlowInput).id)))) return bad('flow.json has inputs that are not a list of { id, description, type }')
  const ids = new Set<string>()
  const steps: FlowStep[] = []
  for (const [i, s] of (f.steps as Partial<FlowStep>[]).entries()) {
    const at = `step ${i + 1}`
    if (!s || typeof s !== 'object') return bad(`${at} is not an object`)
    if (typeof s.type !== 'string' || !TYPES.includes(s.type)) return bad(`${at} has no type (agent, code, approval or each)`)
    const id = typeof s.id === 'string' && NAME.test(s.id) ? s.id : `step-${i + 1}`
    if (ids.has(id)) return bad(`${at} repeats the id "${id}"`)
    ids.add(id)
    if (s.type === 'agent' && (typeof s.instruction !== 'string' || !s.instruction.trim())) return bad(`${at} is an agent with no instruction`)
    if (s.type === 'code' && (typeof s.file !== 'string' || !s.file || s.file.includes('..') || /^([a-z]:|[\\/])/i.test(s.file))) return bad(`${at} is code with no file inside the flow's folder`)
    if (s.type === 'each' && steps.some(x => x.type === 'each')) return bad(`${at} is a second "each": a flow has one at most`)
    if (s.type === 'each' && i === f.steps.length - 1) return bad(`${at} is an "each" with no step after it`)
    steps.push({ ...s, id, type: s.type as FlowStep['type'], name: typeof s.name === 'string' && s.name ? s.name : id })
  }
  return {
    name,
    description: typeof f.description === 'string' ? f.description : '',
    ...(typeof f.cwd === 'string' && f.cwd ? { cwd: f.cwd } : {}),
    ...(Array.isArray(f.inputs) && f.inputs.length ? { inputs: f.inputs as FlowInput[] } : {}),
    ...(typeof f.maxTokens === 'number' && f.maxTokens > 0 ? { maxTokens: f.maxTokens } : {}),
    steps,
  }
}

// ——— Where a run's files go ———

export const flowDir = (root: string, flow: string): string => `${root}/${flow}`
export const runDir = (root: string, flow: string, id: number): string => `${root}/${flow}/runs/${id}`
/** What step `step` of track `track` handed on. */
export const outFile = (dir: string, track: number, step: number): string => `${dir}/out/${track}-${step}.txt`
/**
 * Where the agent of one try of a step writes its result. A file of its own per try (`token` is when the
 * try started): the Write tool refuses a file that exists and it has not read, so the file must not be there.
 */
export const resultFile = (dir: string, track: number, step: number, token: number): string => `${dir}/out/${track}-${step}.result-${token}.txt`
/** What step `step` of track `track` receives: the run's input, the track's item, or the step before's output. */
export function inFile(dir: string, run: Run, track: number, step: number): string {
  const t = run.tracks[track]
  if (t && step > t.from) return outFile(dir, track, step - 1)
  return track === 0 ? `${dir}/out/input.txt` : `${dir}/out/${track}-item.txt`
}

// ——— Paths, for the folder check ———

/** A path with forward slashes, no trailing one, lower case (Windows compares that way). */
export const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Whether `path` (absolute, or relative to `cwd`) lies in one of `roots`. A path with `..` never does. */
export function inside(path: string, cwd: string, roots: readonly string[]): boolean {
  if (!path || path.split(/[\\/]/).includes('..')) return false
  const abs = /^([a-z]:|[\\/])/i.test(path) ? norm(path) : `${norm(cwd)}/${norm(path)}`
  return roots.some(r => abs === norm(r) || abs.startsWith(`${norm(r)}/`))
}

// ——— A run's changes ———

export type RunOptions = { from?: number; vars?: Record<string, unknown>; dry?: boolean }

/** A new run. With `from`, it starts at that step, the input standing for what the step before would have handed on. */
export function newRun(flow: Flow, id: number, input: string, now: number, owner: string, weekStart: number | null, o: RunOptions = {}): Run {
  const from = o.from ?? 0
  return {
    id,
    flow: flow.name,
    input,
    status: 'running',
    startedAt: now,
    steps: flow.steps,
    ...(flow.cwd ? { cwd: flow.cwd } : {}),
    ...(o.vars ? { vars: o.vars } : {}),
    ...(o.dry ? { dry: true } : {}),
    ...(flow.maxTokens ? { maxTokens: flow.maxTokens } : {}),
    tracks: [{ from, at: from, status: 'running', steps: { [from]: { status: 'pending' } } }],
    weekStart,
    owner,
    beat: now,
  }
}

const stepOf = (t: Track): StepRun | undefined => t.steps[t.at]
const setStep = (t: Track, i: number, s: StepRun): Track => ({ ...t, steps: { ...t.steps, [i]: s } })
const setTrack = (run: Run, i: number, t: Track): Run => ({ ...run, tracks: run.tracks.map((x, j) => (j === i ? t : x)) })

/** The run with its status worked out from its tracks, and `endedAt` set the moment nothing is left to do. */
export function settle(run: Run, now: number): Run {
  const steps = run.tracks.flatMap(t => (t.status === 'running' ? [stepOf(t)] : []))
  let status: RunStatus
  if (steps.some(s => s?.status === 'running' || s?.status === 'pending') || run.tracks.some(t => t.status === 'queued')) status = 'running'
  else if (steps.some(s => s?.status === 'waiting')) status = 'waiting'
  else if (run.tracks.some(t => t.status === 'failed')) status = run.halt ?? 'failed'
  else status = 'done'
  const over = status !== 'running' && status !== 'waiting'
  const { endedAt: _was, ...rest } = run
  return { ...rest, status, ...(over ? { endedAt: run.endedAt ?? now } : {}) }
}

/** The queued item tracks that may start now, given how many run at once. */
export function promote(run: Run): Run {
  const each = run.steps.find(s => s.type === 'each')
  let room = Math.max(1, Math.min(10, each?.parallel ?? 3)) - run.tracks.filter(t => t.item !== undefined && t.status === 'running').length
  return { ...run, tracks: run.tracks.map(t => (t.status === 'queued' && room-- > 0 ? { ...t, status: 'running' as const } : t)) }
}

/** The steps waiting to be started, as `[track, step]`. */
export const pending = (run: Run): [number, number][] => run.tracks.flatMap((t, i): [number, number][] => (t.status === 'running' && stepOf(t)?.status === 'pending' ? [[i, t.at]] : []))

/** Step `step` of track `track` taken to run (or to wait, for an approval); null when it is no longer pending. */
export function claim(run: Run, track: number, step: number, now: number): Run | null {
  const t = run.tracks[track]
  const s = t?.steps[step]
  if (!t || t.status !== 'running' || t.at !== step || s?.status !== 'pending') return null
  const waits = run.steps[step]?.type === 'approval'
  return setTrack(run, track, setStep(t, step, { ...s, status: waits ? 'waiting' : 'running', startedAt: now }))
}

export type Outcome = { output?: string; error?: string; tokens?: number; end?: string }

/**
 * A step's result written into the run: done and on to the next step, failed, or the flow ended early.
 * Null when the step is not the one that was started at `token` (it was stopped, sent back or retried since).
 */
export function finish(run: Run, track: number, step: number, token: number, o: Outcome, now: number): Run | null {
  const t = run.tracks[track]
  const s = t?.steps[step]
  if (!t || !s || s.startedAt !== token || (s.status !== 'running' && s.status !== 'waiting')) return null
  const base = { ...s, endedAt: now, ...(o.tokens !== undefined ? { tokens: (s.tokens ?? 0) + o.tokens } : {}) }
  if (o.error !== undefined) return setTrack(run, track, { ...setStep(t, step, { ...base, status: 'failed', error: o.error }), status: 'failed' })
  const done = setStep(t, step, { ...base, status: 'done', preview: (o.output ?? '').slice(0, PREVIEW) })
  if (o.end !== undefined) {
    // Ended early on the main track: the whole flow is over. On an item's track: that item alone.
    return { ...setTrack(run, track, { ...done, status: 'ended' }), ...(track === 0 ? { ended: o.end } : {}) }
  }
  const next = step + 1
  if (next >= run.steps.length) return setTrack(run, track, { ...done, status: 'done' })
  return setTrack(run, track, { ...setStep(done, next, { status: 'pending' }), at: next })
}

/** The "each" step done: the main track ends there and one queued track per item starts after it. */
export function split(run: Run, step: number, token: number, labels: readonly string[], now: number): Run | null {
  const t = run.tracks[0]
  const s = t?.steps[step]
  if (!t || !s || s.startedAt !== token || s.status !== 'running') return null
  const main: Track = { ...setStep(t, step, { ...s, status: 'done', endedAt: now, preview: `${labels.length} item${labels.length === 1 ? '' : 's'}` }), status: 'done' }
  const items = labels.map((item): Track => ({ item, from: step + 1, at: step + 1, status: 'queued', steps: { [step + 1]: { status: 'pending' } } }))
  return { ...run, tracks: [main, ...items] }
}

/** The agent step before `step` in its track, to send an approval back to; -1 when there is none. */
export function agentBefore(run: Run, track: number, step: number): number {
  const from = run.tracks[track]?.from ?? 0
  for (let i = step - 1; i >= from; i--) if (run.steps[i]?.type === 'agent') return i
  return -1
}

/** An approval answered "send back": the agent before it runs again with the note, and the steps after it are forgotten. */
export function sendBack(run: Run, track: number, step: number, note: string): Run | null {
  const t = run.tracks[track]
  const to = agentBefore(run, track, step)
  if (!t || t.steps[step]?.status !== 'waiting' || to < 0) return null
  const steps: Record<string, StepRun> = {}
  for (const [k, v] of Object.entries(t.steps)) if (Number(k) < to) steps[k] = v
  steps[to] = { status: 'pending', note, ...(t.steps[to]?.tokens !== undefined ? { tokens: t.steps[to]?.tokens } : {}) }
  return setTrack(run, track, { ...t, at: to, steps })
}

/**
 * A step's agent asked to do it again, with what was wrong in its result: back to pending, its tries counted.
 * Null when the step is no longer the one started at `token`.
 */
export function again(run: Run, track: number, step: number, token: number, note: string, tokens: number): Run | null {
  const t = run.tracks[track]
  const s = t?.steps[step]
  if (!t || !s || s.startedAt !== token || s.status !== 'running') return null
  return setTrack(run, track, setStep(t, step, { status: 'pending', note, tries: (s.tries ?? 0) + 1, tokens: (s.tokens ?? 0) + tokens }))
}

/** Every running or waiting step marked failed with `error` (the run stopped, or its session closed). */
export function halt(run: Run, why: 'stopped' | 'interrupted', error: string, now: number): Run {
  const tracks = run.tracks.map((t): Track => {
    if (t.status === 'queued') return { ...t, status: 'failed', steps: { ...t.steps, [t.at]: { status: 'failed', error } } }
    const s = stepOf(t)
    if (t.status !== 'running' || !s || s.status === 'done' || s.status === 'failed') return t
    return { ...setStep(t, t.at, { ...s, status: 'failed', error, endedAt: now }), status: 'failed' }
  })
  return { ...run, tracks, halt: why }
}

/** Every failed track back at its failed step, to run again; with `only`, that track alone. */
export function retry(run: Run, owner: string, now: number, only?: number): Run {
  const tracks = run.tracks.map((t, i): Track => {
    if (t.status !== 'failed' || (only !== undefined && i !== only)) return t
    const s = stepOf(t)
    const again: StepRun = { status: 'pending', ...(s?.note !== undefined ? { note: s.note } : {}), ...(s?.tokens !== undefined ? { tokens: s.tokens } : {}) }
    return { ...setStep(t, t.at, again), status: t.item !== undefined ? 'queued' : 'running' }
  })
  const { halt: _halt, endedAt: _ended, weekEnd: _week, ...rest } = run
  return { ...rest, tracks, owner, beat: now }
}

/** The items an "each" step makes of its input: a JSON array's entries, else its non-empty lines. */
export function itemsOf(text: string): string[] {
  let items: string[]
  try {
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) throw new Error('not a list')
    items = raw.map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
  } catch {
    items = text.split(/\r?\n/)
  }
  return items.map(x => x.trim()).filter(Boolean).slice(0, MAX_ITEMS)
}

/** A run started at a step after the "each": the split counted done, and one queued track per item from that step. */
export function fromItems(run: Run, step: number, labels: readonly string[]): Run {
  const each = run.steps.findIndex(s => s.type === 'each')
  const items = labels.map((item): Track => ({ item, from: step, at: step, status: 'queued', steps: { [step]: { status: 'pending' } } }))
  return { ...run, tracks: [{ from: each, at: each, status: 'done', steps: { [each]: { status: 'done', preview: `${labels.length} item${labels.length === 1 ? '' : 's'}` } } }, ...items] }
}

/** A short one-line label for an item. */
export const labelOf = (item: string): string => {
  // An item that is a JSON object is called by its first text (a lead's name, say), not by its braces.
  const value = item.trimStart().startsWith('{') ? jsonOf(item) : undefined
  const named = value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value).find(v => typeof v === 'string' && v.trim()) : undefined
  const line = (typeof named === 'string' ? named : item).replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/** A run's tokens, over every step of every track. */
export const tokensOf = (run: Run): number => run.tracks.reduce((n, t) => n + Object.values(t.steps).reduce((m, s) => m + (s.tokens ?? 0), 0), 0)

/** The running agent step an agent id belongs to, as `[track, step]`. */
export function agentStep(run: Run, agentId: string): [number, number] | null {
  for (const [i, t] of run.tracks.entries()) {
    const s = stepOf(t)
    if (t.status === 'running' && s?.status === 'running' && s.agentId === agentId) return [i, t.at]
  }
  return null
}

// ——— A step's result checked against its schema ———

/** A result as JSON: the text itself, or inside a ```json fence; undefined when it is none. */
export function jsonOf(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text)
  for (const candidate of [text.trim(), fenced?.[1]?.trim()]) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // not this one
    }
  }
  return undefined
}

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)

/** What does not fit `schema` in `value`, one line each, at most 10; empty when it fits. */
export function misfits(value: unknown, schema: JsonSchema, at = 'the result'): string[] {
  const out: string[] = []
  const t = kind(value)
  if (schema.type && !(schema.type === t || (schema.type === 'number' && t === 'integer'))) return [`${at} should be of type ${schema.type}, not ${t === 'undefined' ? 'missing' : t}`]
  if (schema.enum && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) out.push(`${at} should be one of ${schema.enum.map(x => JSON.stringify(x)).join(', ')}`)
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at} should have at least ${schema.minLength} characters`)
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) out.push(`${at} should be at least ${schema.minimum}`)
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) out.push(`${at} should be at most ${schema.maximum}`)
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at} should have at least ${schema.minItems} items, not ${value.length}`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at} should have at most ${schema.maxItems} items, not ${value.length}`)
    const items = schema.items
    if (items) value.forEach((x, i) => out.push(...misfits(x, items, `${at}[${i}]`)))
  }
  if (t === 'object') {
    const o = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in o)) out.push(`${at} has no "${key}"`)
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in o) out.push(...misfits(o[key], sub, `${at}.${key}`))
  }
  return out.slice(0, 10)
}

/** A made-up value that fits `schema`, for a test run. */
export function sample(schema: JsonSchema | undefined, label: string): unknown {
  if (!schema) return `(test run) ${label}`
  if (schema.enum?.length) return schema.enum[0]
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, sub]) => [k, sample(sub, k)]))
    case 'array':
      return Array.from({ length: Math.max(schema.minItems ?? 2, 1) }, (_, i) => sample(schema.items, `${label} ${i + 1}`))
    case 'number':
    case 'integer':
      return schema.minimum ?? 1
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return `(test run) ${label}`
  }
}

/** `show` with each {{field}} (or {{a.b}}) taken from `value`; a field it lacks stays as written. */
export const fill = (show: string, value: unknown): string =>
  show.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, path: string) => {
    let v: unknown = value
    for (const key of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined
    return v === undefined ? all : typeof v === 'string' ? v : JSON.stringify(v)
  })

/** The values of a flow's inputs from what the person gave, each of its type; or what is wrong with them. */
export function varsOf(inputs: readonly FlowInput[], given: Record<string, unknown>): { vars: Record<string, unknown> } | { error: string } {
  const vars: Record<string, unknown> = {}
  for (const d of inputs) {
    const raw = given[d.id] ?? d.default
    if (raw === undefined || raw === '') {
      if (d.required) return { error: `"${d.id}" is needed${d.description ? ` (${d.description})` : ''}` }
      continue
    }
    if (d.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n)) return { error: `"${d.id}" should be a number, not ${JSON.stringify(raw)}` }
      vars[d.id] = n
    } else if (d.type === 'boolean') vars[d.id] = raw === true || /^(true|yes|sim|1)$/i.test(String(raw).trim())
    else if (d.type === 'list') vars[d.id] = Array.isArray(raw) ? raw.map(String) : String(raw).split(/\s*[,;\n]\s*/).filter(Boolean)
    else vars[d.id] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return { vars }
}
