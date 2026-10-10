// Flows: saved multi-step flows (agents, code, approvals, for-each) that this module runs itself, one step
// after another, and shows in a pane. The flows live in ~/.claude/flows/<name>/; flow.ts holds the rules.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flow, FlowStep, Run, StepRun, Track, View } from '../types'
import { BASE_TOOLS, NAME, READ_TOOLS, WRITE_TOOLS, agentBefore, agentStep, claim, finish, flowDir, halt, inFile, inside, itemsOf, labelOf, newRun, outFile, parseFlow, pending, promote, retry, runDir, sendBack, settle, split, tokensOf } from './flow'
import type { Outcome } from './flow'

const PANE = 'flows'
const flows = atom({ plugin: 'flows', key: 'flows' } as const, [])
const runs = atom({ plugin: 'flows', key: 'runs' } as const, {})
const view = atom({ plugin: 'flows', key: 'view' } as const, { flow: null, open: null, confirmDelete: false })
const now = atom({ plugin: 'flows', key: 'now' } as const, 0)
const me = atom({ plugin: 'flows', key: 'me' } as const, '')

/** How often the timer looks at the flows folder, the time limits and the heartbeat. */
const TICK = 5000
/** A run whose session has not said it is alive for this long was interrupted. */
const STALE = 60_000
const active = (run: Run | undefined): boolean => run?.status === 'running' || run?.status === 'waiting'

/** The agent ids of flow steps started since this module loaded, for the guard's own failure. */
const known = new Set<string>()
/** Spawns whose agent id is not written into its run yet; a finished agent waits for them. */
let inflight: Promise<unknown> = Promise.resolve()

// ——— The flows folder ———

async function rootDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home.replace(/\\/g, '/')}/.claude/flows`
}

/** The newest run id in a flow's folder; 0 with none. */
async function latestId($: EngineInterface, root: string, name: string): Promise<number> {
  const dirs = await $.fs.list(`${flowDir(root, name)}/runs`).catch(() => [])
  return Math.max(0, ...dirs.filter(d => d.kind === 'dir' && /^\d+$/.test(d.name)).map(d => Number(d.name)))
}

/** Reads the flows and each one's newest run from disk into the pane's state. */
async function loadFlows($: EngineInterface): Promise<void> {
  const root = await rootDir($)
  const mine = await read($, me)
  const t = await $.clock.now()
  const dirs = (await $.fs.list(root).catch(() => [])).filter(d => d.kind === 'dir' && NAME.test(d.name)).map(d => d.name).sort()
  const list: Flow[] = []
  const fromDisk: Record<string, Run> = {}
  for (const name of dirs) {
    const text = await $.fs.read(`${flowDir(root, name)}/flow.json`).catch(() => null)
    if (text === null) continue
    list.push(parseFlow(name, text))
    const id = await latestId($, root, name)
    if (!id) continue
    try {
      const run = JSON.parse(await $.fs.read(`${runDir(root, name, id)}/run.json`)) as Run
      // A run nobody keeps alive lost its agents with its session.
      fromDisk[name] = active(run) && run.owner !== mine && t - run.beat > STALE ? settle(halt(run, 'interrupted', 'Interrupted: the session running it closed', t), t) : run
    } catch {
      // No run.json yet, or half written: the next tick reads it.
    }
  }
  await update($, flows, was => (JSON.stringify(was) === JSON.stringify(list) ? was : list))
  await update($, runs, was => {
    const next: Record<string, Run> = {}
    for (const f of list) {
      const have = was[f.name]
      const disk = fromDisk[f.name]
      // This session's own run is the truth; another session's is read from disk.
      const keep = have && (have.owner === mine || !disk) && (!disk || have.id >= disk.id) ? have : disk
      if (keep) next[f.name] = keep
    }
    return JSON.stringify(was) === JSON.stringify(next) ? was : next
  })
  await update($, view, v => (v.flow && list.some(f => f.name === v.flow) ? v : { ...v, flow: list[0]?.name ?? null, open: null, confirmDelete: false }))
}

/** Writes a run's current state to its run.json. */
async function saveRun($: EngineInterface, name: string): Promise<void> {
  const run = (await read($, runs))[name]
  if (run) await $.fs.write(`${runDir(await rootDir($), name, run.id)}/run.json`, JSON.stringify(run, null, 1)).catch(() => undefined)
}

/** Applies one change to a flow's run, settles its status, and saves it. Null when `fn` had nothing to change. */
async function mutate($: EngineInterface, name: string, fn: (run: Run) => Run | null): Promise<Run | null> {
  const t = await $.clock.now()
  const box: { run: Run | null } = { run: null }
  await update($, runs, all => {
    const run = all[name]
    const changed = run ? fn(run) : null
    box.run = changed ? settle(promote(changed), t) : null
    return box.run ? { ...all, [name]: box.run } : all
  })
  if (box.run) await saveRun($, name)
  return box.run
}

/** The weekly limit's percent used, or null when the session does not say. */
async function weekUsed($: EngineInterface): Promise<number | null> {
  const usage = await $.session.usage().catch(() => null)
  return usage?.rateLimits.find(l => l.kind === 'seven_day')?.percentUsed ?? null
}

// ——— Running a flow ———

async function startRun($: EngineInterface, name: string, input: string): Promise<string> {
  const flow = (await read($, flows)).find(f => f.name === name)
  if (!flow) return `There is no flow named "${name}".`
  if (flow.error) return `"${name}" cannot run: ${flow.error}.`
  if (active((await read($, runs))[name])) return `"${name}" is already running.`
  const root = await rootDir($)
  const id = (await latestId($, root, name)) + 1
  const t = await $.clock.now()
  await $.fs.write(`${runDir(root, name, id)}/out/input.txt`, input)
  const run = newRun(flow, id, input, t, await read($, me), await weekUsed($))
  await update($, runs, all => ({ ...all, [name]: run }))
  await update($, view, v => ({ ...v, flow: name, open: null, confirmDelete: false }))
  await saveRun($, name)
  void pump($, name)
  return `Started "${name}" (run ${id}).`
}

/** Starts every step that is waiting to start, then closes the run if nothing is left. */
async function pump($: EngineInterface, name: string): Promise<void> {
  const run = (await read($, runs))[name]
  if (!run) return
  for (const [track, step] of pending(run)) {
    const t = await $.clock.now()
    const claimed = await mutate($, name, r => claim(r, track, step, t))
    if (claimed) void work($, name, claimed, track, step, t).catch((err: unknown) => finishStep($, name, track, step, t, { error: String(err) }))
  }
  await closeRun($, name)
}

/** A run that just ended: measures what it cost of the week and says how it went, once. */
async function closeRun($: EngineInterface, name: string): Promise<void> {
  const run = (await read($, runs))[name]
  if (!run || run.endedAt === undefined || run.weekEnd !== undefined) return
  const week = await weekUsed($)
  const closed = await mutate($, name, r => (r.endedAt === undefined || r.weekEnd !== undefined ? null : { ...r, weekEnd: week }))
  if (!closed) return
  if (closed.status === 'done') $.ui.toast(`Flow ${name} finished${closed.ended ? `: ${closed.ended}` : ''}`)
  else if (closed.status === 'failed') $.ui.toast(`Flow ${name} failed`)
}

/** Does the step that was just claimed: an agent, a script, an approval or a split. */
async function work($: EngineInterface, name: string, run: Run, track: number, step: number, token: number): Promise<void> {
  const spec = run.steps[step]
  if (!spec) return
  const root = await rootDir($)
  const dir = runDir(root, name, run.id)
  const input = await $.fs.read(inFile(dir, run, track, step)).catch(() => '')
  if (spec.type === 'approval') {
    await mutate($, name, r => noteStep(r, track, step, token, { preview: input.slice(0, 2000) }))
    $.ui.toast(`Flow ${name} needs your approval`)
    return
  }
  if (spec.type === 'each') {
    const items = itemsOf(input)
    if (items.length === 0) return finishStep($, name, track, step, token, { output: input, end: 'There were no items' })
    for (const [k, item] of items.entries()) await $.fs.write(`${dir}/out/${k + 1}-item.txt`, item)
    await mutate($, name, r => split(r, step, token, items.map(labelOf), token))
    return pump($, name)
  }
  if (spec.type === 'code') {
    const seconds = Math.max(1, Math.min(600, spec.seconds ?? 60))
    const stdin = JSON.stringify({ input, flow: name, run: run.id, track, runDir: dir, cwd: run.cwd ?? dir })
    const r = await $.process.run(['node', `${flowDir(root, name)}/${spec.file ?? ''}`], { cwd: dir, stdin, timeoutMs: seconds * 1000 })
    // Exit 0 hands the output on; exit 3 ends the flow there, its output the reason.
    if (r.exitCode === 0) return finishStep($, name, track, step, token, { output: r.stdout.trimEnd() })
    if (r.exitCode === 3) return finishStep($, name, track, step, token, { output: r.stdout.trimEnd(), end: r.stdout.trim().slice(0, 200) || 'Ended by the code step' })
    return finishStep($, name, track, step, token, { error: (r.stderr.trim() || r.stdout.trim() || `The script exited with code ${r.exitCode}`).slice(-1500) })
  }
  const spawn = startAgent($, name, run, track, step, token, spec, dir, input)
  inflight = Promise.allSettled([inflight, spawn])
  await spawn
}

/** Fields written onto a running or waiting step, if it is still the one started at `token`. */
function noteStep(run: Run, track: number, step: number, token: number, fields: Partial<StepRun>): Run | null {
  const t = run.tracks[track]
  const s = t?.steps[step]
  if (!t || !s || s.startedAt !== token) return null
  return { ...run, tracks: run.tracks.map((x, i) => (i === track ? { ...t, steps: { ...t.steps, [step]: { ...s, ...fields } } } : x)) }
}

async function startAgent($: EngineInterface, name: string, run: Run, track: number, step: number, token: number, spec: FlowStep, dir: string, input: string): Promise<void> {
  const type = `${name}-${spec.id}`.slice(0, 64)
  const cwd = run.cwd ?? dir
  const folders = run.cwd ? `${dir} (this run's folder) and ${run.cwd} (the flow's working folder)` : `${dir} (this run's folder)`
  await $.agent.register({
    name: type,
    description: `Flows: step "${spec.name}" of the flow "${name}".`,
    prompt: [
      `You are one step ("${spec.name}") of an automated flow called "${name}". Nobody is watching: do not ask questions, decide and do the work.`,
      `Your final message is handed to the next step as its input, so make it the result alone: no preamble, no summary of what you did, no offers.`,
      `You may read files anywhere and write files only inside ${folders}. Other tools work only if this step was given them.`,
      `If you cannot do the task, make your final message start with "FLOW-ERROR:" followed by why.`,
    ].join('\n'),
    tools: [...BASE_TOOLS, ...(spec.tools ?? [])],
    model: spec.model ?? 'sonnet',
    effort: spec.effort ?? 'medium',
    omitClaudeMd: true,
  })
  const note = run.tracks[track]?.steps[step]?.note
  const before = note === undefined ? '' : await $.fs.read(outFile(dir, track, step)).catch(() => '')
  const item = run.tracks[track]?.item
  const prompt = [
    `Task:\n${spec.instruction ?? ''}`,
    ...(item !== undefined ? [`This run handles one item of a list (item ${track} of ${run.tracks.length - 1}).`] : []),
    `Input:\n${input || '(none)'}`,
    ...(note !== undefined ? [`You did this before and the reviewer sent it back with this note:\n${note}\n\nYour previous result:\n${before}`] : []),
  ].join('\n\n')
  const description = `${name} #${run.id}: ${spec.name}${item !== undefined ? ` [${track}]` : ''}`
  const started = await $.agent.spawn({ prompt, description, subagentType: `flows:${type}`, cwd })
  if (started.deny !== undefined) return finishStep($, name, track, step, token, { error: `The agent did not start: ${started.deny}` })
  // The id comes with the answer; where it does not, the agent is found in the session's list by its description.
  const agentId = started.agentId ?? (await $.agent.list().catch(() => [])).filter(a => a.description === description && !known.has(a.id)).pop()?.id
  if (!agentId) return finishStep($, name, track, step, token, { error: 'The agent did not start: it has no id' })
  known.add(agentId)
  await mutate($, name, r => noteStep(r, track, step, token, { agentId }))
}

/** Writes a step's result into its run and moves the flow on. */
async function finishStep($: EngineInterface, name: string, track: number, step: number, token: number, o: Outcome): Promise<void> {
  const run = (await read($, runs))[name]
  if (!run) return
  if (o.output !== undefined) await $.fs.write(outFile(runDir(await rootDir($), name, run.id), track, step), o.output)
  const t = await $.clock.now()
  if (await mutate($, name, r => finish(r, track, step, token, o, t))) await pump($, name)
}

/** A subagent's turn ended: if it is a flow step, its answer is the step's result. */
async function agentDone($: EngineInterface, agentId: string, answer: string, reason: string, tokens: number): Promise<void> {
  await inflight
  for (const [name, run] of Object.entries(await read($, runs))) {
    const at = agentStep(run, agentId)
    if (!at) continue
    const token = run.tracks[at[0]]?.steps[at[1]]?.startedAt ?? 0
    const failed = /^\s*FLOW-ERROR:/i.test(answer)
    const o: Outcome = reason !== 'answer' ? { error: `The agent stopped (${reason})${answer.trim() ? `: ${answer.trim().slice(0, 1200)}` : ''}`, tokens } : failed ? { error: answer.replace(/^\s*FLOW-ERROR:\s*/i, '').slice(0, 1500), tokens } : { output: answer, tokens }
    return finishStep($, name, at[0], at[1], token, o)
  }
}

async function stopAgent($: EngineInterface, agentId: string): Promise<void> {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
}

async function stopRun($: EngineInterface, name: string): Promise<string> {
  const run = (await read($, runs))[name]
  if (!run || !active(run)) return `"${name}" is not running.`
  const t = await $.clock.now()
  const ids = run.tracks.flatMap(tr => (tr.status === 'running' && tr.steps[tr.at]?.status === 'running' && tr.steps[tr.at]?.agentId ? [tr.steps[tr.at]?.agentId ?? ''] : []))
  await mutate($, name, r => halt(r, 'stopped', 'Stopped', t))
  for (const id of ids) await stopAgent($, id)
  await closeRun($, name)
  return `Stopped "${name}".`
}

async function retryRun($: EngineInterface, name: string): Promise<void> {
  const t = await $.clock.now()
  const mine = await read($, me)
  if (await mutate($, name, r => (r.tracks.some(tr => tr.status === 'failed') ? retry(r, mine, t) : null))) await pump($, name)
}

/** The person's answer to an approval: on with it, end there, or back to the agent before with a note. */
async function decide($: EngineInterface, name: string, track: number, step: number, answer: 'approve' | 'reject' | 'back', note = ''): Promise<void> {
  const run = (await read($, runs))[name]
  const s = run?.tracks[track]?.steps[step]
  if (!run || s?.status !== 'waiting') return
  if (answer === 'back') {
    if (await mutate($, name, r => sendBack(r, track, step, note.trim() || 'Please do it again.'))) await pump($, name)
    return
  }
  const input = await $.fs.read(inFile(runDir(await rootDir($), name, run.id), run, track, step)).catch(() => '')
  await finishStep($, name, track, step, s.startedAt ?? 0, answer === 'approve' ? { output: input } : { output: input, end: `Rejected at "${run.steps[step]?.name ?? 'approval'}"` })
}

async function deleteFlow($: EngineInterface, name: string): Promise<void> {
  if (!NAME.test(name) || active((await read($, runs))[name])) return
  const dir = flowDir(await rootDir($), name)
  await $.process.run(['node', '-e', 'require("fs").rmSync(process.argv[1],{recursive:true,force:true})', dir]).catch(() => undefined)
  await loadFlows($)
}

/** The timer: rereads the flows, stops agents past their time, keeps this session's runs marked alive. */
async function tick($: EngineInterface): Promise<void> {
  await loadFlows($)
  const t = await $.clock.now()
  const mine = await read($, me)
  let busy = false
  for (const [name, run] of Object.entries(await read($, runs))) {
    if (!active(run) || run.owner !== mine) continue
    busy = true
    for (const [i, tr] of run.tracks.entries()) {
      const s = tr.steps[tr.at]
      const spec = run.steps[tr.at]
      if (tr.status !== 'running' || s?.status !== 'running' || spec?.type !== 'agent' || s.startedAt === undefined) continue
      const minutes = Math.max(1, Math.min(240, spec.minutes ?? 30))
      if (t - s.startedAt < minutes * 60_000) continue
      if (s.agentId) await stopAgent($, s.agentId)
      await finishStep($, name, i, tr.at, s.startedAt, { error: `Timed out after ${minutes} min` })
    }
    if (t - run.beat > 15_000) await mutate($, name, r => ({ ...r, beat: t }))
  }
  if (busy) await update($, now, () => t)
}

// ——— The pane ———

type Ui = ReturnType<EngineInterface['ui']['resolve']>

const GLYPH: Record<string, string> = { pending: '○', running: '●', waiting: '◷', done: '✓', failed: '✗', queued: '○', ended: '–' }
const clock = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const count = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
const kindOf = (s: FlowStep): string => (s.type === 'agent' ? `agent · ${s.model ?? 'sonnet'} · ${s.effort ?? 'medium'}` : s.type === 'each' ? `for each · ${Math.max(1, Math.min(10, s.parallel ?? 3))} at once` : s.type)

/** A step's time and tokens, as far as it got. */
function meter(s: StepRun | undefined, t: number): string {
  if (!s?.startedAt) return ''
  const time = clock(Math.max(0, (s.endedAt ?? Math.max(t, s.startedAt)) - s.startedAt))
  return s.tokens ? `${time} · ${count(s.tokens)}` : time
}

function pane($: EngineInterface, ui: Ui, list: Flow[], all: Record<string, Run>, v: View, t: number) {
  const { Box, Text, Button } = ui
  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No flows yet</Text>
        <Text dimColor>A flow is a folder in ~/.claude/flows/ with a flow.json. Ask Claude to write one.</Text>
      </Box>
    )
  }
  const flow = list.find(f => f.name === v.flow) ?? list[0]
  if (!flow) return <Text>No flows yet</Text>
  const name = flow.name
  const run = all[name]
  const steps = run?.steps ?? flow.steps
  const main = run?.tracks[0]
  const items = run?.tracks.slice(1) ?? []
  const each = steps.findIndex(s => s.type === 'each')
  const week = run && run.weekStart != null && run.weekEnd != null ? Math.max(0, run.weekEnd - run.weekStart) : null
  const canRun = !flow.error && !active(run)
  const open = (key: string) => void update($, view, x => ({ ...x, open: x.open === key ? null : key, confirmDelete: false }))

  /** One step's row for one track, and under it what is open: its result, its error, an approval's buttons. */
  const row = (i: number, spec: FlowStep, track: number, tr: Track | undefined, label: string) => {
    const s = tr?.steps[i]
    const key = `${track}:${i}`
    const back = run ? agentBefore(run, track, i) >= 0 : false
    return (
      <Box key={`row:${key}`} flexDirection="column">
        <Button key={`step:${key}`} plain onPress={() => open(key)}>
          {`${GLYPH[s?.status ?? 'pending']} ${label}  `}
          <Text dimColor>{[track === 0 ? kindOf(spec) : '', meter(s, t)].filter(Boolean).join(' · ')}</Text>
        </Button>
        {track === 0 && spec.description && v.open === key && <Text dimColor>{`   ${spec.description}`}</Text>}
        {s?.status === 'failed' && <Text color="error">{`   ${s.error ?? 'Failed'}`}</Text>}
        {s?.status === 'waiting' && (
          <Box flexDirection="column">
            <Text>{s.preview || '(nothing to approve)'}</Text>
            <Box flexDirection="row" gap={1}>
              <Button key={`approve:${key}`} variant="primary" label="Approve" onPress={() => void decide($, name, track, i, 'approve')} />
              <Button key={`reject:${key}`} variant="secondary" label="Reject" onPress={() => void decide($, name, track, i, 'reject')} />
            </Box>
            {back && 'Input' in ui && <ui.Input key={`back:${key}`} placeholder="A note for the agent" submitLabel="Send back" onSubmit={note => void decide($, name, track, i, 'back', note)} />}
          </Box>
        )}
        {v.open === key && s?.status === 'done' && <Text dimColor>{s.preview || '(empty)'}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {'Select' in ui && list.length > 1 ? (
          <ui.Select key="flow" label="Flow" value={name} options={list.map(f => ({ value: f.name, label: `${f.name}${active(all[f.name]) ? ` (${all[f.name]?.status})` : ''}` }))} onSelect={value => void update($, view, x => ({ ...x, flow: value, open: null, confirmDelete: false }))} />
        ) : (
          <Text bold>{name}</Text>
        )}
        {flow.description && <Text dimColor>{flow.description}</Text>}
        {flow.error && <Text color="error">{`This flow cannot run: ${flow.error}`}</Text>}
      </Box>
      {run && (
        <Box flexDirection="column">
          <Text>
            <Text bold>{`Run ${run.id} · ${run.status}`}</Text>
            {`  ${clock(Math.max(0, (run.endedAt ?? Math.max(t, run.startedAt)) - run.startedAt))} · ${count(tokensOf(run))} tokens${week !== null ? ` · week ≈ ${week < 0.1 ? '<0.1' : week.toFixed(1)}%` : ''}`}
          </Text>
          {run.ended && <Text dimColor>{run.ended}</Text>}
        </Box>
      )}
      <Box flexDirection="column">
        {canRun && 'Input' in ui && <ui.Input key="run" placeholder="Input for this run (optional)" submitLabel="Run" onSubmit={text => void startRun($, name, text)} />}
        <Box flexDirection="row" gap={1}>
          {canRun && <Button key="run:go" variant="primary" label="▶ Run" onPress={() => void startRun($, name, '')} />}
          {active(run) && <Button key="run:stop" variant="secondary" label="■ Stop" onPress={() => void stopRun($, name)} />}
          {run && !active(run) && run.status !== 'done' && <Button key="run:retry" variant="primary" label="↻ Retry from here" onPress={() => void retryRun($, name)} />}
          {!active(run) && !v.confirmDelete && <Button key="flow:delete" variant="secondary" label="Delete" onPress={() => void update($, view, x => ({ ...x, confirmDelete: true }))} />}
          {v.confirmDelete && <Button key="flow:delete:yes" variant="primary" label={`Delete ${name} and its runs`} onPress={() => void deleteFlow($, name)} />}
          {v.confirmDelete && <Button key="flow:delete:no" variant="secondary" label="Cancel" onPress={() => void update($, view, x => ({ ...x, confirmDelete: false }))} />}
        </Box>
      </Box>
      <Box flexDirection="column">
        {steps.map((spec, i) => {
          if (each < 0 || i <= each || items.length === 0) return row(i, spec, 0, main, `${i + 1}. ${spec.name}`)
          // After the "each": the step once, then one row per item.
          const done = items.filter(tr => tr.steps[i]?.status === 'done').length
          return (
            <Box key={`each:${i}`} flexDirection="column">
              <Text>
                {`  ${i + 1}. ${spec.name}  `}
                <Text dimColor>{`${kindOf(spec)} · ${done}/${items.length}`}</Text>
              </Text>
              {items.map((tr, k) => row(i, spec, k + 1, tr.at >= i || tr.steps[i] ? tr : undefined, `   ${tr.item ?? `item ${k + 1}`}`))}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

async function togglePane($: EngineInterface): Promise<string> {
  const shown = (await $.ui.panes().catch(() => [])).some(p => p.id === PANE && p.isShown)
  if (shown) {
    await $.ui.close({ id: PANE })
    return 'Closed the Flows pane.'
  }
  await loadFlows($)
  await $.ui.open({ id: PANE, title: 'Flows' })
  return 'Opened the Flows pane.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!(await read($, me))) {
      const id = `${await $.session.id().catch(() => 'session')}:${await $.clock.now()}`
      await update($, me, () => id)
    }
    await $.command.register({ name: 'flow', description: 'Flows: open the pane, or run and stop a flow', argumentHint: '[run <name> [input] | stop <name>]' }).catch(() => undefined)
    await loadFlows($).catch(() => undefined)
    $.clock.every(TICK, () => void tick($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'flow' }, async ($, e) => {
    const [verb = '', name = '', ...rest] = e.args.trim().split(/\s+/)
    if (!verb) return { text: await togglePane($) }
    await loadFlows($)
    if (verb === 'run' && name) {
      await $.ui.open({ id: PANE, title: 'Flows' })
      return { text: await startRun($, name, rest.join(' ')) }
    }
    if (verb === 'stop' && name) return { text: await stopRun($, name) }
    if (verb === 'new' || verb === 'edit') return { text: `/flow ${verb} is not built yet: for now, ask Claude to write the flow's folder in ~/.claude/flows/.` }
    return { text: 'Usage: /flow · /flow run <name> [input] · /flow stop <name>' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => pane($, $.ui.resolve(e), await read($, flows), await read($, runs), await read($, view), await read($, now)))

  // A flow step's agent ended its turn: its answer is the step's result.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) {
      const u = e.usage
      const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      await agentDone($, e.agentId, e.answer, e.reason, tokens).catch(() => undefined)
    }
    return out
  })

  // The step types are this plugin's own: the model is never offered them.
  on('agent.offer', ($, e, next) => (e.agent.startsWith('flows:') ? { isOffered: false } : next(e))).catch(($, e, next) => (e.agent.startsWith('flows:') ? { isOffered: false } : next(e)))

  // What a flow's agent may do without anyone to ask: read, use the web, write inside its folders, and
  // the tools its step names. Everything else is refused; nothing is ever put to the person.
  on('tool.check', async ($, e, next) => {
    if (!e.agentId) return next(e)
    for (const [name, run] of Object.entries(await read($, runs))) {
      const at = agentStep(run, e.agentId)
      if (!at) continue
      const spec = run.steps[at[1]]
      const tool = String(e.tool)
      if (READ_TOOLS.includes(tool) || spec?.tools?.includes(tool)) return { decision: 'allow' as const, reason: `Flow ${name}` }
      if (WRITE_TOOLS.includes(tool)) {
        const dir = runDir(await rootDir($), name, run.id)
        const input = (e.input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
        const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
        if (inside(path, run.cwd ?? dir, [dir, ...(run.cwd ? [run.cwd] : [])])) return { decision: 'allow' as const, reason: `Flow ${name}` }
        return { decision: 'deny' as const, reason: `This flow step may write only inside ${dir}${run.cwd ? ` and ${run.cwd}` : ''}.` }
      }
      return { decision: 'deny' as const, reason: `This flow step was not given the tool ${tool}.` }
    }
    return next(e)
  }).catch(($, e, next) => (e.agentId && known.has(e.agentId) ? { decision: 'deny' as const, reason: 'Flows could not check this call.' } : next(e)))
}
