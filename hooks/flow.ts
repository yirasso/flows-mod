// The rules of a flow and of a run, with no engine in them: reading a flow.json, where a run's files go,
// and every change a run goes through. register.tsx does the work these decide.

import type { Flow, FlowStep, Run, RunStatus, StepRun, Track } from '../types'

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
  const f = raw as { description?: unknown; cwd?: unknown; steps?: unknown }
  if (!Array.isArray(f.steps) || f.steps.length === 0) return bad('flow.json has no steps')
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
  return { name, description: typeof f.description === 'string' ? f.description : '', ...(typeof f.cwd === 'string' && f.cwd ? { cwd: f.cwd } : {}), steps }
}

// ——— Where a run's files go ———

export const flowDir = (root: string, flow: string): string => `${root}/${flow}`
export const runDir = (root: string, flow: string, id: number): string => `${root}/${flow}/runs/${id}`
/** What step `step` of track `track` handed on. */
export const outFile = (dir: string, track: number, step: number): string => `${dir}/out/${track}-${step}.txt`
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

export function newRun(flow: Flow, id: number, input: string, now: number, owner: string, weekStart: number | null): Run {
  return {
    id,
    flow: flow.name,
    input,
    status: 'running',
    startedAt: now,
    steps: flow.steps,
    ...(flow.cwd ? { cwd: flow.cwd } : {}),
    tracks: [{ from: 0, at: 0, status: 'running', steps: { 0: { status: 'pending' } } }],
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

/** Every failed track back at its failed step, to run again. */
export function retry(run: Run, owner: string, now: number): Run {
  const tracks = run.tracks.map((t): Track => {
    if (t.status !== 'failed') return t
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

/** A short one-line label for an item. */
export const labelOf = (item: string): string => {
  const line = item.replace(/\s+/g, ' ').trim()
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
