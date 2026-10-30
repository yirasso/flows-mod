// Flows: saved multi-step flows (agents, code, approvals, for-each), shown in a pane. This module keeps
// each run's state and decides the next step; the session's own Claude carries it out: it calls the tool
// `next`, starts the agents the answer names and puts the approvals to the person in the chat. That way a
// flow runs under the session's permission mode like any other work (a plugin's own spawn is refused in
// auto mode). The flows live once for every session, in ~/.claude/flows/<name>/; each run's files go to the
// folder of the session that runs it, <folder>/Flows/<name>/runs/<n>/. flow.ts holds the rules.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Draft, Flow, FlowStep, Run, StepRun, Track, View } from '../types'
import { changes, check, flowJson, guide, presented, sameShape, whole } from './author'
import type { Proposal } from './author'
import type { PickerItem, PickerProps } from './picker'
import { BASE_TOOLS, NAME, READ_TOOLS, WRITE_TOOLS, again as askAgain, agentBefore, agentStep, claim, fill, finish, flowDir, fromItems, halt, inFile, inside, itemsOf, jsonOf, labelOf, misfits, newRun, outFile, parseFlow, pending, promote, resultFile, retry, runDir, sample, sendBack, settle, split, tokensOf, varsOf } from './flow'
import type { Outcome } from './flow'
import { header as drawHeader, item as drawItem, row as drawRow } from './draw'
import type { Tone } from './draw'

const PANE = 'flows'
const TOOL = 'mcp__flows__next'
/** The tool the session's Claude writes and changes flows with. */
const DRAFT = 'mcp__flows__draft'
/** The tool the session's Claude does what /flows does with, from the person's own words. */
const MANAGE = 'mcp__flows__manage'
/** The tool the session has a foreground agent hand its report back with; a step's agent needs it. */
const HANDBACK = 'SubagentHandback'
const flows = atom({ plugin: 'flows', key: 'flows' } as const, [])
const runs = atom({ plugin: 'flows', key: 'runs' } as const, {})
const view = atom({ plugin: 'flows', key: 'view' } as const, { flow: null })
const now = atom({ plugin: 'flows', key: 'now' } as const, 0)
const past = atom({ plugin: 'flows', key: 'past' } as const, null)
const me = atom({ plugin: 'flows', key: 'me' } as const, '')
const draft = atom({ plugin: 'flows', key: 'draft' } as const, null)

/** How often the timer looks at the flows folder, the time limits and the heartbeat. */
/** The first words of /flows that are not a flow's name; a flow cannot be called by one. */
const VERBS = ['list', 'new', 'edit', 'run', 'retry', 'delete']
const USAGE = 'Usage: /flows · /flows list · /flows <name> [run] · /flows new <name> <what it should do> · /flows edit <name> <what to change> · /flows run <name> [input] · /flows retry <name> · /flows delete <name>'

const TICK = 5000
/** A run whose session has not said it is alive for this long was interrupted. */
const STALE = 60_000
const active = (run: Run | undefined): boolean => run?.status === 'running' || run?.status === 'waiting'

/** The agent ids of flow steps started since this module loaded, for the guard's own failure. */
const known = new Set<string>()
/** Agents that started and whose id is not written into its run yet; a finished agent waits for them. */
let inflight: Promise<unknown> = Promise.resolve()
/** Flow agents whose turn ended and whose Agent call has not returned yet: their last message, and how it ended. */
const ended = new Map<string, { answer: string; reason: string; tokens: number }>()
/** Flow agents the session's Claude started in the background: their turn's end is their result. */
const detached = new Set<string>()
/** The session's own turn that is running now, and the turn each flow's run was last worked on in: a turn the person stops takes its flows with it. */
let mainTurn: string | undefined
const turnOf = new Map<string, string>()

// ——— The flows folder ———

/** The session's folder, where its runs' files go and its agents work; empty when the session has none. */
async function projectDir($: EngineInterface): Promise<string> {
  return ((await $.session.cwd().catch(() => '')) ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Where the flows are kept, the same for every session: ~/.claude/flows (Tomás, 30 Oct 2026; before that
 * each project kept its own in its Flows folder). Only the plugin writes there, so no agent meets the
 * question the session asks before a write under .claude.
 */
async function homeDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) || (home ? `${home}/.claude` : '')
  return config ? `${config.replace(/\\/g, '/').replace(/\/+$/, '')}/flows` : ''
}

/** Where this session's runs go: its folder's Flows folder, <folder>/Flows/<name>/runs/<n>; empty with no folder. */
async function outDir($: EngineInterface): Promise<string> {
  const project = await projectDir($)
  return project ? `${project}/Flows` : ''
}

const NO_FOLDER = "This session has no folder, and a run's files go to the folder of the session that runs it. Open a session in a folder to run a flow."
const NO_HOME = 'Flows could not find the Claude folder (~/.claude), where the flows are kept.'
/** The flow's memory: what its steps marked `remember` handed on, run after run. Kept with the flow. */
const memoryFile = (home: string, name: string): string => `${flowDir(home, name)}/memory.md`

/** The newest run id in a flow's folder; 0 with none. */
async function latestId($: EngineInterface, root: string, name: string): Promise<number> {
  const dirs = await $.fs.list(`${flowDir(root, name)}/runs`).catch(() => [])
  return Math.max(0, ...dirs.filter(d => d.kind === 'dir' && /^\d+$/.test(d.name)).map(d => Number(d.name)))
}

/** Reads the flows and each one's newest run from disk into the pane's state. */
async function loadFlows($: EngineInterface): Promise<void> {
  const home = await homeDir($)
  const out = await outDir($)
  const mine = await read($, me)
  const t = await $.clock.now()
  const dirs = (home ? await $.fs.list(home).catch(() => []) : []).filter(d => d.kind === 'dir' && NAME.test(d.name)).map(d => d.name).sort()
  const list: Flow[] = []
  const fromDisk: Record<string, Run> = {}
  for (const name of dirs) {
    const text = await $.fs.read(`${flowDir(home, name)}/flow.json`).catch(() => null)
    if (text === null) continue
    list.push(parseFlow(name, text))
    const id = out ? await latestId($, out, name) : 0
    if (!id) continue
    try {
      const run = JSON.parse(await $.fs.read(`${runDir(out, name, id)}/run.json`)) as Run
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
  await update($, view, v => (v.flow && list.some(f => f.name === v.flow) ? v : { flow: list[0]?.name ?? null }))
}

/** Writes a run's current state to its run.json. */
async function saveRun($: EngineInterface, name: string): Promise<void> {
  const run = (await read($, runs))[name]
  if (run) await $.fs.write(`${runDir(await outDir($), name, run.id)}/run.json`, JSON.stringify(run, null, 1)).catch(() => undefined)
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

// ——— A run's steps ———

const typeOf = (flow: string, spec: FlowStep): string => `${flow}-${spec.id}`.slice(0, 64)
/** What the session's Claude passes as an agent's description, so the agent is matched to its step: the item and the step, in words. */
const launchName = (run: Run, track: number, step: number): string => {
  const item = run.tracks[track]?.item
  // No double quotes in it: the session's Claude copies it into a quoted value.
  return `${run.flow} #${run.id} · ${item !== undefined ? `${labelOf(item).slice(0, 40).replace(/"/g, "'")} (${track}/${run.tracks.length - 1}) · ` : ''}step ${step + 1}: ${(run.steps[step]?.name ?? '').replace(/"/g, "'")}`
}

/** The agent steps that are claimed and have no agent yet, as `[track, step]`. */
const toLaunch = (run: Run): [number, number][] => run.tracks.flatMap((t, i): [number, number][] => (t.status === 'running' && run.steps[t.at]?.type === 'agent' && t.steps[t.at]?.status === 'running' && !t.steps[t.at]?.agentId ? [[i, t.at]] : []))
/** How many of a run's agents are at work. */
const working = (run: Run): number => run.tracks.filter(t => t.status === 'running' && t.steps[t.at]?.status === 'running' && t.steps[t.at]?.agentId).length
/** The approvals waiting for the person, as `[track, step]`. */
const waiting = (run: Run): [number, number][] => run.tracks.flatMap((t, i): [number, number][] => (t.status === 'running' && t.steps[t.at]?.status === 'waiting' ? [[i, t.at]] : []))

/** Fields written onto a running or waiting step, if it is still the one started at `token`. */
function noteStep(run: Run, track: number, step: number, token: number, fields: Partial<StepRun>): Run | null {
  const t = run.tracks[track]
  const s = t?.steps[step]
  if (!t || !s || s.startedAt !== token) return null
  return { ...run, tracks: run.tracks.map((x, i) => (i === track ? { ...t, steps: { ...t.steps, [step]: { ...s, ...fields } } } : x)) }
}

/** Declares the agent type of every agent step of a flow: its model, effort, tools and standing orders. */
async function registerTypes($: EngineInterface, flow: Flow): Promise<void> {
  for (const spec of flow.steps) {
    if (spec.type !== 'agent') continue
    await $.agent.register({
      name: typeOf(flow.name, spec),
      description: `Step "${spec.name}" of the saved flow "${flow.name}". Only for the Flows plugin: start it when the ${TOOL} tool says so, never on your own.`,
      prompt: [
        `You are one step ("${spec.name}") of an automated flow called "${flow.name}". Nobody is watching: do not ask questions, decide and do the work.`,
        `Your result is read by a program and handed to the next step as its input. Your task names a result file: write the result there with the Write tool, and nothing but the result: no preamble, no summary of what you did, no notes about risks or what you skipped, no offers, whatever other instructions say about how to end a reply.`,
        `Then, when you are asked to hand a report back with ${HANDBACK}, hand back the single word DONE.`,
        `You may read files anywhere and write files only inside the folders your task names. Other tools work only if this step was given them.`,
        `If you cannot do the task, write no result file and hand back "FLOW-ERROR:" followed by why.`,
      ].join('\n'),
      tools: [...BASE_TOOLS, HANDBACK, ...(spec.tools ?? [])],
      model: spec.model ?? 'sonnet',
      effort: spec.effort ?? 'medium',
      omitClaudeMd: true,
    })
  }
}

/** The files of what the steps before `step` handed on in a track (the main track's, before an item's own), by step. */
function earlier(dir: string, run: Run, track: number, step: number): { id: string; name: string; file: string }[] {
  const t = run.tracks[track]
  const main = run.tracks[0]
  const out: { id: string; name: string; file: string }[] = []
  for (let i = 0; i < step; i++) {
    const spec = run.steps[i]
    const at = t?.steps[i]?.status === 'done' ? track : track > 0 && main?.steps[i]?.status === 'done' ? 0 : -1
    if (spec && at >= 0 && spec.type !== 'each') out.push({ id: spec.id, name: spec.name, file: outFile(dir, at, i) })
  }
  return out
}

/** The flow's memory as text, its last 50,000 characters; empty when it has none. */
async function memoryOf($: EngineInterface, name: string): Promise<string> {
  const home = await homeDir($)
  return home ? (await $.fs.read(memoryFile(home, name)).catch(() => '')).slice(-50_000) : ''
}

/** What a step's agent is asked: its instruction, its input, what the run knows, its folders, and the note it was sent back with. */
async function agentPrompt($: EngineInterface, run: Run, track: number, step: number, dir: string, token: number): Promise<string> {
  const spec = run.steps[step]
  const from = inFile(dir, run, track, step)
  const input = await $.fs.read(from).catch(() => '')
  const note = run.tracks[track]?.steps[step]?.note
  const before = note === undefined ? '' : await $.fs.read(outFile(dir, track, step)).catch(() => '')
  const item = run.tracks[track]?.item
  const results = earlier(dir, run, track, step).filter(r => r.file !== from)
  const memory = await memoryOf($, run.flow)
  return [
    `Task:\n${spec?.instruction ?? ''}`,
    ...(item !== undefined ? [`This run handles one item of a list (item ${track} of ${run.tracks.length - 1}: ${labelOf(item)}).`] : []),
    `Folders you may write in: ${dir} (this run's folder)${run.cwd ? ` and ${run.cwd} (the project the flow works on)` : ''}.`,
    `Result file (write your result here, and only your result): ${resultFile(dir, track, step, token)}`,
    ...(spec?.schema ? [`Your result must be JSON of this shape (JSON Schema), and nothing else:\n${JSON.stringify(spec.schema)}`] : []),
    `Input:\n${input || '(none)'}`,
    ...(from !== `${dir}/out/input.txt` && run.input ? [`The run's own input, as the user gave it (${dir}/out/input.txt):\n${run.input.slice(0, 4000)}`] : []),
    ...(run.vars ? [`The flow's inputs for this run: ${JSON.stringify(run.vars)}`] : []),
    ...(results.length ? [`What the steps before handed on, if you need it (read the files):\n${results.map(r => `- ${r.id} (${r.name}): ${r.file}`).join('\n')}`] : []),
    ...(memory ? [`The flow's memory, from its earlier runs (read it before you start): ${memoryFile(await homeDir($), run.flow)}`] : []),
    ...(note !== undefined ? [`You did this before and it was sent back with this note:\n${note}\n\nYour previous result:\n${before}`] : []),
  ].join('\n\n')
}

/** What does not fit a step's schema in its result; empty when it fits or the step has none. */
function wrongIn(spec: FlowStep | undefined, output: string): string[] {
  if (!spec?.schema) return []
  const value = jsonOf(output)
  return value === undefined ? ['the result is not JSON'] : misfits(value, spec.schema)
}

/**
 * Writes a step's result into its run, and into the flow's memory when the step says to remember it.
 * False when the step is no longer the one that was started at `token`.
 */
async function finishStep($: EngineInterface, name: string, track: number, step: number, token: number, o: Outcome): Promise<boolean> {
  const run = (await read($, runs))[name]
  if (!run) return false
  if (o.output !== undefined) await $.fs.write(outFile(runDir(await outDir($), name, run.id), track, step), o.output)
  const t = await $.clock.now()
  const done = (await mutate($, name, r => finish(r, track, step, token, o, t))) !== null
  const spec = run.steps[step]
  const home = await homeDir($)
  if (done && spec?.remember && o.output !== undefined && o.error === undefined && !run.dry && home) {
    const item = run.tracks[track]?.item
    const was = await $.fs.read(memoryFile(home, name)).catch(() => '')
    await $.fs.write(memoryFile(home, name), `${was}${was ? '\n' : ''}## Run ${run.id}${item !== undefined ? ` · ${labelOf(item)}` : ''} · ${spec.name} · ${new Date(t).toISOString().slice(0, 10)}\n${o.output.trim()}\n`).catch(() => undefined)
  }
  return done
}

/** Something the person should know about a run, kept on it and shown in the pane and the chat. */
async function warn($: EngineInterface, name: string, text: string): Promise<void> {
  await mutate($, name, r => ({ ...r, warnings: [...(r.warnings ?? []), text] }))
}

/** A run past its flow's ceiling of tokens stops there, its agents with it. */
async function overCeiling($: EngineInterface, name: string): Promise<void> {
  const run = (await read($, runs))[name]
  if (!run?.maxTokens || !active(run) || tokensOf(run) <= run.maxTokens) return
  await warn($, name, `It used ${tokensOf(run)} tokens, over the flow's ceiling of ${run.maxTokens}, and was stopped.`)
  await stopRun($, name)
}

/** How much the flow's last finished run took, from the session's folder; empty when it has none. */
async function estimate($: EngineInterface, name: string): Promise<string> {
  const out = await outDir($)
  if (!out) return ''
  for (let id = await latestId($, out, name); id > 0; id--) {
    const run = await $.fs.read(`${runDir(out, name, id)}/run.json`).then(t => JSON.parse(t) as Run).catch(() => null)
    if (run?.status !== 'done' || run.dry || run.endedAt === undefined) continue
    return `Its last finished run (run ${run.id}) took ${count(tokensOf(run))} tokens and ${clock(run.endedAt - run.startedAt)}${run.weekStart != null && run.weekEnd != null ? `, about ${Math.max(0, run.weekEnd - run.weekStart).toFixed(1)}% of the weekly limit` : ''}.`
  }
  return ''
}

/** What an approval shows: its `show` filled in from the JSON it receives, else that JSON laid out, else the text. */
function approvalText(spec: FlowStep, input: string): string {
  const value = jsonOf(input)
  const text = spec.show ? fill(spec.show, value) : value !== undefined && typeof value === 'object' ? JSON.stringify(value, null, 2) : input
  if (text.length <= 8000) return text
  // Cut at a line, never in the middle of one, and say how much is left out.
  const at = text.lastIndexOf('\n', 8000)
  const kept = text.slice(0, at > 4000 ? at : 8000)
  return `${kept}\n… (${text.length - kept.length} more characters in the file)`
}

/** Does a claimed step that needs no agent: a script, a split, or an approval's preview (in a test run, its pass). */
async function work($: EngineInterface, name: string, run: Run, track: number, step: number, token: number): Promise<void> {
  const spec = run.steps[step]
  if (!spec) return
  const dir = runDir(await outDir($), name, run.id)
  const input = await $.fs.read(inFile(dir, run, track, step)).catch(() => '')
  if (spec.type === 'approval') {
    if (run.dry) return void (await finishStep($, name, track, step, token, { output: input }))
    await mutate($, name, r => noteStep(r, track, step, token, { preview: approvalText(spec, input) }))
    return
  }
  if (spec.type === 'each') {
    let items = itemsOf(input)
    if (items.length === 0) return void (await finishStep($, name, track, step, token, { output: input, end: 'There were no items' }))
    if (spec.max !== undefined && spec.max > 0 && items.length > spec.max) {
      await warn($, name, `"${spec.name}" was handed ${items.length} items and takes at most ${spec.max}: it kept the first ${spec.max}.`)
      items = items.slice(0, spec.max)
    }
    for (const [k, item] of items.entries()) await $.fs.write(`${dir}/out/${k + 1}-item.txt`, item)
    await mutate($, name, r => split(r, step, token, items.map(labelOf), token))
    return
  }
  const seconds = Math.max(1, Math.min(600, spec.seconds ?? 60))
  const outputs: Record<string, string> = {}
  for (const r of earlier(dir, run, track, step)) outputs[r.id] = await $.fs.read(r.file).catch(() => '')
  const item = run.tracks[track]?.item !== undefined ? await $.fs.read(`${dir}/out/${track}-item.txt`).catch(() => '') : undefined
  const stdin = JSON.stringify({ input, runInput: run.input, vars: run.vars ?? {}, outputs, memory: await memoryOf($, name), ...(item !== undefined ? { item } : {}), flow: name, run: run.id, track, runDir: dir, cwd: run.cwd ?? dir, dry: Boolean(run.dry) })
  const r = await $.process.run(['node', `${flowDir(await homeDir($), name)}/${spec.file ?? ''}`], { cwd: dir, stdin, timeoutMs: seconds * 1000 })
  const wrong = r.exitCode === 0 ? wrongIn(spec, r.stdout) : []
  // Exit 0 hands the output on; exit 3 ends the flow there, its output the reason.
  if (wrong.length) await finishStep($, name, track, step, token, { error: `Its output does not fit the step's schema: ${wrong.join('; ')}` })
  else if (r.exitCode === 0) await finishStep($, name, track, step, token, { output: r.stdout.trimEnd() })
  else if (r.exitCode === 3) await finishStep($, name, track, step, token, { output: r.stdout.trimEnd(), end: r.stdout.trim().slice(0, 200) || 'Ended by the code step' })
  else await finishStep($, name, track, step, token, { error: (r.stderr.trim() || r.stdout.trim() || `The script exited with code ${r.exitCode}`).slice(-1500) })
}

/**
 * Takes the run as far as it goes without anyone: claims every step that is ready, runs the scripts and
 * the splits, and stops at agents to start, approvals to answer, or the end.
 */
async function advance($: EngineInterface, name: string): Promise<void> {
  for (let guard = 0; guard < 500; guard++) {
    const run = (await read($, runs))[name]
    if (!run) return
    let moved = false
    for (const [track, step] of pending(run)) {
      const t = await $.clock.now()
      const claimed = await mutate($, name, r => claim(r, track, step, t))
      const type = claimed?.steps[step]?.type
      if (!claimed) continue
      if (type === 'agent') {
        // A test run starts no agent: the step hands on a made-up result of its shape.
        if (!claimed.dry) continue
        const spec = claimed.steps[step]
        const made = sample(spec?.schema, spec?.name ?? 'result')
        await finishStep($, name, track, step, t, { output: typeof made === 'string' ? made : JSON.stringify(made, null, 2) })
        moved = true
        continue
      }
      await work($, name, claimed, track, step, t).catch((err: unknown) => finishStep($, name, track, step, t, { error: String(err) }))
      if (type !== 'approval') moved = true
    }
    if (!moved) break
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

/** A subagent's turn ended: if it is a flow step, its answer is the step's result. */
async function agentDone($: EngineInterface, agentId: string, answer: string, reason: string, tokens: number): Promise<void> {
  await inflight
  ended.delete(agentId)
  for (const [name, run] of Object.entries(await read($, runs))) {
    const at = agentStep(run, agentId)
    if (!at) continue
    const [track, step] = at
    const s = run.tracks[track]?.steps[step]
    const spec = run.steps[step]
    const token = s?.startedAt ?? 0
    const failed = /^\s*FLOW-ERROR:/i.test(answer)
    const dir = runDir(await outDir($), name, run.id)
    // The result is the file the agent was told to write; one that wrote none is taken at its word.
    const written = reason === 'answer' && !failed ? await $.fs.read(resultFile(dir, track, step, token)).catch(() => '') : ''
    let o: Outcome = reason !== 'answer' ? { error: `The agent stopped (${reason})${answer.trim() ? `: ${answer.trim().slice(0, 1200)}` : ''}`, tokens } : failed ? { error: answer.replace(/^\s*FLOW-ERROR:\s*/i, '').slice(0, 1500), tokens } : written.trim() ? { output: written.trimEnd(), tokens } : /^\s*DONE\.?\s*$/i.test(answer) ? { error: 'The agent said it was done but wrote no result file.', tokens } : { output: answer, tokens }
    const used = (s?.tokens ?? 0) + tokens
    if (o.output !== undefined && spec?.maxTokens && used > spec.maxTokens) o = { error: `It used ${used} tokens, over the step's ceiling of ${spec.maxTokens}.`, tokens }
    const wrong = o.output !== undefined ? wrongIn(spec, o.output) : []
    if (o.output !== undefined && wrong.length) {
      // A result of the wrong shape goes back to the agent with what is wrong in it, a few times, before the step fails.
      if ((s?.tries ?? 0) < (spec?.retries ?? 2)) {
        await $.fs.write(outFile(dir, track, step), o.output)
        const note = `Your result does not have the shape it must have:\n${wrong.map(w => `- ${w}`).join('\n')}\nWrite it again, as JSON of this shape and nothing else: ${JSON.stringify(spec?.schema)}`
        if (await mutate($, name, r => askAgain(r, track, step, token, note, tokens))) await advance($, name)
        return
      }
      o = { error: `Its result did not fit the step's schema after ${(s?.tries ?? 0) + 1} tries: ${wrong.join('; ')}`, tokens }
    }
    if (await finishStep($, name, track, step, token, o)) {
      await overCeiling($, name)
      await advance($, name)
    }
    return
  }
}

type Answer = 'approve' | 'reject' | 'back' | 'edit'

/** The person's answer to an approval: on with it (as it is, or as they changed it), end there, or back to the agent before with a note. */
async function decide($: EngineInterface, name: string, track: number, step: number, answer: Answer, note: string): Promise<void> {
  const run = (await read($, runs))[name]
  const s = run?.tracks[track]?.steps[step]
  if (!run || s?.status !== 'waiting') return
  if (answer === 'back' && agentBefore(run, track, step) >= 0) {
    await mutate($, name, r => sendBack(r, track, step, note.trim() || 'Please do it again.'))
    return
  }
  const input = await $.fs.read(inFile(runDir(await outDir($), name, run.id), run, track, step)).catch(() => '')
  const output = answer === 'edit' && note.trim() ? note : input
  await finishStep($, name, track, step, s.startedAt ?? 0, answer === 'reject' ? { output: input, end: `Rejected at "${run.steps[step]?.name ?? 'approval'}"` } : { output })
}

// ——— What the session's Claude is told ———

const again = (name: string): string => `call ${TOOL} again with {"flow":"${name}"}`

/** The next thing to do for a run, in words for the session's Claude. */
async function directive($: EngineInterface, name: string): Promise<string> {
  const run = (await read($, runs))[name]
  if (!run) return `"${name}" has no run yet. If the user wants it started, call ${MANAGE} with {"action":"run","flow":"${name}"}.`
  const head = `Flow "${name}", run ${run.id}.`
  const asks = waiting(run)
  const launches = toLaunch(run)
  if (launches.length > 0) {
    const lines = launches.map(([t, s], i) => `${i + 1}. subagent_type: "flows:${typeOf(name, run.steps[s] as FlowStep)}" · description: "${launchName(run, t, s)}" · prompt: "${launchName(run, t, s)}"`)
    return [
      head,
      `Start ${launches.length === 1 ? 'this agent' : `these ${launches.length} agents`} now with the Agent tool${launches.length === 1 ? '' : ', all in one message'}, each with run_in_background set to true and exactly these values (Flows replaces the prompt with the step's real task, so do not write one):`,
      ...lines,
      `Right after starting ${launches.length === 1 ? 'it' : 'them'}, ${again(name)}: do not wait for the agents, the user may have approvals to answer meanwhile. Do not act on what the agents answer, and do not do their work yourself.`,
    ].join('\n')
  }
  const ask = asks[0]
  if (ask) {
    const [t, s] = ask
    const spec = run.steps[s]
    const back = agentBefore(run, t, s) >= 0
    const item = run.tracks[t]?.item
    const items = run.tracks.length - 1
    const dir = runDir(await outDir($), name, run.id)
    // The approvals of the same step, one per item: they can all be answered at once.
    const alike = asks.filter(([, i]) => i === s).length
    return [
      `${head} It waits for the user's approval at step ${s + 1}, "${spec?.name ?? ''}"${item !== undefined ? `, for item ${t} of ${items} (${labelOf(item)})` : ''}${asks.length > 1 ? `; approval 1 of the ${asks.length} waiting` : ''}.`,
      `First show the user what they are approving, word for word, in a message, with where it is:`,
      `<to-approve>\n${run.tracks[t]?.steps[s]?.preview || '(nothing)'}\n</to-approve>`,
      `The whole of it: ${inFile(dir, run, t, s)}. The run's files: ${dir}. If it names files or pages the user would want to see, give them as links they can open.`,
      `Then ask them what to do: with the AskUserQuestion tool if you have it (options "Approve", "Approve with changes", "Reject"${back ? ', "Send back" (to the agent, with a note)' : ''}${alike > 1 ? `, "Approve all ${alike}" (every item waiting at this step)` : ''}), otherwise with a plain question, ending your turn until they answer.`,
      `${working(run) > 0 ? `${working(run)} agents of this flow are still working in the background; that must not delay this question. ` : ''}${asks.length > 1 ? `${asks.length - 1} more approvals wait behind this one: you will be handed each in turn. ` : ''}Then call ${TOOL} with {"flow":"${name}","approval":"${t}.${s}","answer":"approve"}; "edit" with "note" set to the whole text to hand on in its place, as the user changed it; "reject"${back ? `; "back" with "note" set to what the user wants changed` : ''}${alike > 1 ? `; or "approve_all"` : ''}. Never answer for the user.`,
    ].join('\n')
  }
  if (working(run) > 0) return `${head} ${working(run)} of its agents are working in the background and nothing waits for the user. Do not start them again and do not poll: say in one short line that the flow is running, then end your turn. You are woken when an agent finishes; then ${again(name)}.`
  const warned = run.warnings?.length ? [`Tell the user too: ${run.warnings.join(' ')}`] : []
  if (run.status === 'done') {
    const last = run.tracks.flatMap(t => (t.status === 'done' && t.at === run.steps.length - 1 ? [t.steps[t.at]?.preview ?? ''] : [])).filter(Boolean)
    return [
      `${head} It finished${run.ended ? `: ${run.ended}` : ''}${run.dry ? ' (a test run: no agent ran and the approvals passed by themselves; what it handed on is made up)' : ''}. Its files are in ${runDir(await outDir($), name, run.id)}.`,
      ...warned,
      `Tell the user it is done in a line or two, with the result${last.length > 1 ? 's' : ''} of its last step:`,
      ...last.slice(0, 8).map(text => `- ${text.slice(0, Math.max(600, Math.floor(4000 / last.length)))}`),
    ].join('\n')
  }
  if (run.status === 'failed') {
    const failed = run.tracks.flatMap((t, i) => (t.status === 'failed' ? [`step ${t.at + 1} "${run.steps[t.at]?.name ?? ''}"${t.item !== undefined ? ` (item ${i}: ${t.item})` : ''}: ${t.steps[t.at]?.error ?? 'failed'}`] : []))
    return [
      `${head} It failed:`,
      ...failed.map(line => `- ${line}`),
      `Tell the user what failed, in plain words, and propose one fix to the flow: say exactly what you would change, and show the changed lines if it is a script. Ask them once whether to make it. Change nothing until they agree.`,
      `If they agree, call ${DRAFT} with {"flow":"${name}","action":"start"} to see the flow as it is, then with "action":"propose", the whole flow with the fix, and "agreed":true: that saves it at once, since they already said yes. Do not ask them again. Then call ${TOOL} with {"flow":"${name}","retry":true}, which takes this run up again at the failed step.`,
      `If the fix adds, removes or reorders steps, this run cannot go on with it: offer to start a new one (${MANAGE} with {"action":"run","flow":"${name}"}).`,
      ...(failed.length > 1 ? [`Several items failed: one can be taken up alone, with ${MANAGE} {"action":"retry","flow":"${name}","item":<its number>}.`] : []),
      ...warned,
    ].join('\n')
  }
  return [`${head} It was ${run.status}. Do nothing more for it; tell the user it can be taken up again where it stopped, if they ask.`, ...warned].join('\n')
}

/** The first prompt of a run (or of its retry): the session's Claude takes it from there with the tool. */
const kickoff = (name: string, id: number, resumed: boolean): string => `${resumed ? 'Take up' : 'Run'} my saved flow "${name}" (run ${id}): call the ${TOOL} tool with {"flow":"${name}"} and do what it answers, step by step, until it says the flow is over.`

/** Hands the session's Claude a prompt, a moment later: a command's own hook may not submit one (it holds the turn). */
function kick($: EngineInterface, text: string): void {
  $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => undefined))
}

/** How many runs of a flow are kept. */
const KEEP = 10

/** Deletes a flow's runs older than the last `KEEP`. */
async function prune($: EngineInterface, root: string, name: string, newest: number): Promise<void> {
  const dirs = await $.fs.list(`${flowDir(root, name)}/runs`).catch(() => [])
  for (const d of dirs) {
    if (d.kind !== 'dir' || !/^\d+$/.test(d.name) || Number(d.name) > newest - KEEP) continue
    await $.process.run(['node', '-e', 'require("fs").rmSync(process.argv[1],{recursive:true,force:true})', runDir(root, name, Number(d.name))]).catch(() => undefined)
  }
}

/**
 * How a run starts: the values of the flow's inputs (or a JSON text of them), the step to start at (its id
 * or number), a test run, and whether a run of the flow still going is stopped to make way.
 */
export type StartOptions = { inputs?: Record<string, unknown>; from?: string | number; dry?: boolean; replace?: boolean }

/**
 * Starts a new run of a flow. From a command the chat is handed the first prompt (`kickIt`); from the
 * session's Claude, already in its turn, it is not: the tool's answer goes on from there.
 */
async function startRun($: EngineInterface, name: string, input: string, kickIt = true, o: StartOptions = {}): Promise<string> {
  const flow = (await read($, flows)).find(f => f.name === name)
  if (!flow) return `There is no flow named "${name}".`
  if (flow.error) return `"${name}" cannot run: ${flow.error}.`
  const out = await outDir($)
  if (!out) return NO_FOLDER
  const was = (await read($, runs))[name]
  if (active(was) && !o.replace) return `"${name}" is already running (run ${was?.id ?? 0}).`
  if (active(was) && was?.owner !== (await read($, me))) return `"${name}" is running in another session; stop it there first.`
  let from = 0
  if (o.from !== undefined && o.from !== '') {
    from = typeof o.from === 'number' ? o.from - 1 : /^\d+$/.test(o.from) ? Number(o.from) - 1 : flow.steps.findIndex(s => s.id === o.from)
    if (!flow.steps[from]) return `"${name}" has no step ${JSON.stringify(o.from)}. Its steps: ${flow.steps.map((s, i) => `${i + 1}. ${s.id}`).join(', ')}.`
  }
  // Started after the "each", the input is the list of items, each one's track starting at that step.
  const each = flow.steps.findIndex(s => s.type === 'each')
  const items = each >= 0 && from > each ? itemsOf(input) : null
  if (items?.length === 0) return `"${name}" started at step ${from + 1} needs the list of items as its input, a JSON list or one item per line.`
  // The flow's inputs, each of its type: from the values given, a JSON text of them, or the text as the first one.
  let vars: Record<string, unknown> | undefined
  if (flow.inputs?.length) {
    const json = items ? undefined : jsonOf(input)
    const first = flow.inputs[0]?.id ?? ''
    const given = o.inputs ?? (json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : input && !items ? { [first]: input } : {})
    const got = varsOf(flow.inputs, given)
    if ('error' in got) return `"${name}" cannot start: ${got.error}. Its inputs: ${flow.inputs.map(d => `${d.id} (${d.type ?? 'string'}${d.required ? ', needed' : ''}${d.description ? `: ${d.description}` : ''})`).join('; ')}.`
    vars = got.vars
    if (!items) input = JSON.stringify(vars, null, 2)
  }
  // Only now, with everything in order, does the run still going make way.
  if (active(was)) await stopRun($, name)
  const id = (await latestId($, out, name)) + 1
  const t = await $.clock.now()
  const dir = runDir(out, name, id)
  await registerTypes($, flow)
  await $.fs.write(`${dir}/out/input.txt`, input)
  void prune($, out, name, id).catch(() => undefined)
  let run = newRun({ ...flow, cwd: flow.cwd ?? (await projectDir($)) }, id, input, t, await read($, me), await weekUsed($), { from: items ? each : from, ...(vars ? { vars } : {}), ...(o.dry ? { dry: true } : {}) })
  if (items) {
    for (const [k, item] of items.entries()) await $.fs.write(`${dir}/out/${k + 1}-item.txt`, item)
    run = settle(promote(fromItems(run, from, items.map(labelOf))), t)
  }
  const started = run
  await update($, runs, all => ({ ...all, [name]: started }))
  await update($, view, () => ({ flow: name }))
  await saveRun($, name)
  await advance($, name)
  if (kickIt) kick($, kickoff(name, id, false))
  return `Started "${name}" (run ${id}${o.dry ? ', a test run' : ''}${from > 0 ? `, at step ${from + 1}` : ''}).`
}

async function stopAgent($: EngineInterface, agentId: string): Promise<void> {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
}

/**
 * Takes a run that stopped up again, at its failed steps. If the flow changed since and still has the same
 * steps, the run goes on with the flow as it is now. Answers why not, or null when it did.
 */
async function takeUp($: EngineInterface, name: string, item?: number | string): Promise<string | null> {
  const flow = (await read($, flows)).find(f => f.name === name)
  const was = (await read($, runs))[name]
  if (!flow || !was) return `"${name}" has no run to take up. /flows run ${name} starts one.`
  if (was.status === 'done') return `"${name}" finished its last run. /flows run ${name} starts a new one.`
  // One item alone: by its number, or its label.
  const only = item === undefined || item === '' ? undefined : typeof item === 'number' || /^\d+$/.test(item) ? Number(item) : was.tracks.findIndex(tr => tr.item !== undefined && tr.item.toLowerCase().includes(item.toLowerCase()))
  if (only !== undefined && (only < 1 || was.tracks[only]?.status !== 'failed')) {
    const failed = was.tracks.flatMap((tr, i) => (i > 0 && tr.status === 'failed' ? [`${i} (${tr.item ?? ''})`] : []))
    return `Run ${was.id} of "${name}" has no failed item ${JSON.stringify(item)}.${failed.length ? ` Its failed items: ${failed.join(', ')}.` : ''}`
  }
  const steps = !flow.error && sameShape(was.steps, flow.steps) ? flow.steps : was.steps
  const t = await $.clock.now()
  const mine = await read($, me)
  await registerTypes($, { ...flow, steps })
  await mutate($, name, r => {
    const now: Run = { ...r, steps, owner: mine, beat: t }
    return now.tracks.some(tr => tr.status === 'failed') ? retry(now, mine, t, only) : now
  })
  await update($, view, () => ({ flow: name }))
  await advance($, name)
  return null
}

async function retryRun($: EngineInterface, name: string, item?: string): Promise<string> {
  const why = await takeUp($, name, item)
  if (why) return why
  const run = (await read($, runs))[name]
  kick($, kickoff(name, run?.id ?? 0, true))
  return `Taking up "${name}" (run ${run?.id ?? 0}).`
}

/** Stops this session's run of a flow where it is: its agents are stopped, and /flows retry takes it up again. */
async function stopRun($: EngineInterface, name: string): Promise<void> {
  const run = (await read($, runs))[name]
  if (!run || !active(run)) return
  for (const tr of run.tracks) {
    const s = tr.steps[tr.at]
    if (s?.status === 'running' && s.agentId) await stopAgent($, s.agentId)
  }
  const t = await $.clock.now()
  await mutate($, name, r => (active(r) ? halt(r, 'stopped', 'Stopped', t) : null))
  await closeRun($, name)
}

/** Shows a run of a flow in the pane: the newest as it goes, an earlier one read from its folder. Answers why not, or null. */
async function showRun($: EngineInterface, name: string, id: number, asked = String(id)): Promise<string | null> {
  if ((await read($, runs))[name]?.id === id) {
    await update($, view, () => ({ flow: name }))
    return null
  }
  const root = await outDir($)
  const text = root && Number.isInteger(id) && id > 0 ? await $.fs.read(`${runDir(root, name, id)}/run.json`).catch(() => null) : null
  if (text === null) {
    const ids = (await $.fs.list(`${flowDir(root, name)}/runs`).catch(() => [])).filter(d => d.kind === 'dir' && /^\d+$/.test(d.name)).map(d => Number(d.name)).sort((x, y) => x - y)
    return ids.length ? `"${name}" has no run ${asked}. Its runs: ${ids.join(', ')}.` : `"${name}" has not run yet.`
  }
  await update($, past, () => JSON.parse(text) as Run)
  await update($, view, () => ({ flow: name, run: id }))
  return null
}

// ——— Writing and changing a flow, with the session's Claude ———

/** The scripts of a flow's code steps that are on disk, by their path in the flow's folder. */
async function scripts($: EngineInterface, dir: string, json: string | null): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (json === null) return out
  for (const s of parseFlow('x', json).steps) {
    if (s.type !== 'code' || !s.file) continue
    const text = await $.fs.read(`${dir}/${s.file}`).catch(() => null)
    if (text !== null) out[s.file] = text
  }
  return out
}

/** Writes a flow and its scripts to its folder, and shows it in the pane in place of any draft. */
async function save($: EngineInterface, dir: string, flow: Flow, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) await $.fs.write(`${dir}/${path}`, text)
  await $.fs.write(`${dir}/flow.json`, flowJson(flow))
  await update($, draft, () => null)
  await loadFlows($)
  await update($, view, () => ({ flow: flow.name }))
}

/** The draft tool: how to write the flow, the check of a proposal, and the save the person agreed to. */
async function authoring($: EngineInterface, input: Proposal & { flow?: unknown; action?: unknown; agreed?: unknown }): Promise<string> {
  const name = typeof input.flow === 'string' ? input.flow.trim() : ''
  const home = await homeDir($)
  if (!home) return `${NO_HOME} Tell the user so.`
  if (!NAME.test(name) || VERBS.includes(name)) return `"${name}" is not a flow name: lower-case letters, digits and hyphens, and none of ${VERBS.join(', ')}. Ask the user for one.`
  const dir = flowDir(home, name)
  const json = await $.fs.read(`${dir}/flow.json`).catch(() => null)
  const mode: Draft['mode'] = json === null ? 'new' : 'edit'
  const have = await read($, draft)
  const ask = have?.name === name ? have.ask : ''
  if (input.action === 'start') {
    await update($, draft, () => ({ name, mode, ask, flow: null, files: {} }))
    return guide(DRAFT, name, mode, ask, json === null ? null : { json, files: await scripts($, dir, json) })
  }
  if (input.action === 'propose') {
    const saved = json === null ? null : parseFlow(name, json)
    // A patch changes the latest draft of this flow, else the flow as it is saved.
    const made = whole(input, have?.name === name && have.flow ? have.flow : saved)
    if ('error' in made) return `Not accepted: ${made.error}`
    const checked = check(name, made, Object.keys(await scripts($, dir, json)))
    if ('error' in checked) return `Not accepted: ${checked.error} Fix it and propose again.`
    const changed = changes(saved, checked.flow)
    if (input.agreed === true) {
      // The person said yes to this very change (a fix after a failed run): no draft, no second question.
      await save($, dir, checked.flow, checked.files)
      return [`Saved the change to "${name}".`, ...changed.map(c => `- ${c}`), 'Tell the user in one line what changed.'].join('\n')
    }
    await update($, draft, () => ({ name, mode, ask, flow: checked.flow, files: checked.files }))
    await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
    return presented(DRAFT, checked.flow, checked.files, changed)
  }
  if (input.action === 'save') {
    if (have?.name !== name || !have.flow) return `There is no draft of "${name}" to save: propose it first.`
    await save($, dir, have.flow, have.files)
    return `Saved "${name}" in ${dir}. Tell the user so in one line, and that /flows run ${name} [input] runs it.`
  }
  if (input.action === 'discard') {
    if (have?.name === name) await update($, draft, () => null)
    return `The draft of "${name}" is gone; nothing was saved. Tell the user so in one line.`
  }
  return `Call ${DRAFT} with "action": "start" (how to write the flow), "propose" (the flow, checked and shown as a draft), "save" (once the user agreed) or "discard".`
}

/** The timer: rereads the flows, fails agents past their time, keeps this session's runs marked alive. */
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
      if (tr.status !== 'running' || s?.status !== 'running' || spec?.type !== 'agent' || s.startedAt === undefined || !s.agentId) continue
      const minutes = Math.max(1, Math.min(240, spec.minutes ?? 30))
      if (t - s.startedAt < minutes * 60_000) continue
      await stopAgent($, s.agentId)
      await finishStep($, name, i, tr.at, s.startedAt, { error: `Timed out after ${minutes} min` })
    }
    if (t - run.beat > 15_000) await mutate($, name, r => ({ ...r, beat: t }))
  }
  if (busy) await update($, now, () => t)
}

// ——— The pane: what is happening, and buttons for what /flows does (approvals stay in the chat) ———

type Ui = ReturnType<EngineInterface['ui']['resolve']>

/** What the pane's buttons and its input field do. Each reads the state it needs when pressed, never at draw time. */
type Acts = {
  show: (name: string) => Promise<void>
}

function actsOf($: EngineInterface): Acts {
  return {
    show: async name => {
      await update($, view, () => ({ flow: name }))
    },
  }
}

/** How long ago, in a few characters. */
const ago = (ms: number): string => (ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`)

const TONE: Record<string, string> = { running: '#D97757', waiting: '#D9962B', done: '#2E9E6B', failed: '#D8443C' }

/** The pane's only control: a picker of the flow shown, the ones running or waiting first, then the latest run. */
function controls(ui: Ui, acts: Acts, list: Flow[], all: Record<string, Run>, name: string | undefined, isDraft: boolean, t: number) {
  const { Box, Button } = ui
  // A first flow still a draft has nothing to pick.
  if (list.length === 0) return null
  const rank = (f: Flow): number => (active(all[f.name]) ? Infinity : (all[f.name]?.startedAt ?? -Infinity))
  const items: PickerItem[] = [...list]
    .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name))
    .map(f => {
      const r = all[f.name]
      const when = !r ? 'not run yet' : active(r) ? r.status : `${r.status} · ${ago(Math.max(0, t - (r.endedAt ?? r.startedAt)))}`
      return { name: f.name, description: f.description, glyph: GLYPH[r?.status ?? 'pending'] ?? '–', color: TONE[r?.status ?? ''] ?? '#8A8A86', when }
    })
  const current = name && !isDraft ? name : null
  // Drawn on the surface itself (picker.tsx); a pick comes back as a ui.message.
  if ('Client' in ui) return <ui.Client key="picker" module="./picker.tsx" props={{ current, items } satisfies PickerProps} width="100%" />
  if ('Select' in ui) {
    const options = items.map(i => ({ value: i.name, label: `${i.glyph} ${i.name} · ${i.when}` }))
    return <ui.Select key="flow" label="Flow" options={options} {...(current ? { value: current } : {})} onSelect={value => void acts.show(value)} />
  }
  // The mobile app draws neither: a button per flow.
  return (
    <Box key="flows" flexDirection="row" flexWrap="wrap" gap={1}>
      {list.map(f => (
        <Button key={`flow:${f.name}`} label={`${GLYPH[all[f.name]?.status ?? 'pending'] ?? GLYPH.ended} ${f.name}`} variant={f.name === name && !isDraft ? 'primary' : undefined} onPress={() => acts.show(f.name)} />
      ))}
    </Box>
  )
}

const GLYPH: Record<string, string> = { pending: '○', running: '●', waiting: '◷', done: '✓', failed: '✗', queued: '○', ended: '–' }
const clock = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const count = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
const kindOf = (s: FlowStep): string => (s.type === 'agent' ? `agent · ${s.model ?? 'sonnet'} · ${s.effort ?? 'medium'}` : s.type === 'each' ? `for each · ${Math.max(1, Math.min(10, s.parallel ?? 3))} at once` : s.type)
const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A step's time and tokens, as far as it got. */
function meter(s: StepRun | undefined, t: number): string {
  if (s?.startedAt === undefined) return ''
  const time = clock(Math.max(0, (s.endedAt ?? Math.max(t, s.startedAt)) - s.startedAt))
  return s.tokens ? `${time} · ${count(s.tokens)}` : time
}

function pane(ui: Ui, acts: Acts, list: Flow[], all: Record<string, Run>, v: View, t: number, isDesktop: boolean, cols: number, old: Run | null, drafted: Draft | null, out: string) {
  const { Box, Text } = ui
  // A flow being written shows in place of the chosen one, until it is saved or dropped.
  const isDraft = Boolean(drafted?.flow)
  if (list.length === 0 && !isDraft) {
    return (
      <Box flexDirection="column">
        <Text bold>No flows yet</Text>
        <Text dimColor>Describe one in the chat and Claude writes it with you. It is kept in ~/.claude/flows, for every session; each run's files go to the session's folder.</Text>
      </Box>
    )
  }
  const flow = drafted?.flow ?? list.find(f => f.name === v.flow) ?? list[0]
  if (!flow) return <Text>No flows yet</Text>
  const name = flow.name
  const DRAFTED = 'Draft, not saved yet: answer in the chat.'
  // An earlier run, when /flows <name> <run> asked for one; else the newest. A draft has none.
  const isPast = !isDraft && v.run !== undefined && old?.flow === name && old.id === v.run
  const run = isDraft ? undefined : isPast && old ? old : all[name]
  const steps = run?.steps ?? flow.steps
  const main = run?.tracks[0]
  const items = run?.tracks.slice(1) ?? []
  const each = steps.findIndex(s => s.type === 'each')
  const week = run && run.weekStart != null && run.weekEnd != null ? Math.max(0, run.weekEnd - run.weekStart) : null
  const top = controls(ui, acts, list, all, name, isDraft, t)
  // Under the run: what the person should know about it, and where its files are.
  const notes = run ? (
    <Box key="notes" flexDirection="column">
      {run.dry && <Text color="warning">Test run: no agent ran, the approvals passed by themselves, and what the agents handed on is made up.</Text>}
      {(run.warnings ?? []).map((w, i) => (
        <Text key={`warn:${i}`} color="warning">{`! ${w}`}</Text>
      ))}
      {out && <Text dimColor wrap="truncate-middle">{`Files: ${runDir(out, name, run.id)}`}</Text>}
    </Box>
  ) : null

  // The desktop app draws: a header, then one picture per step and per item.
  if (isDesktop && 'Svg' in ui) {
    const { Svg } = ui
    // A column of the pane is about 9 px wide in the desktop app (measured on three widths of it).
    const w = Math.max(260, Math.min(1400, (cols || 44) * 9 - 8))
    const toneOf = (spec: FlowStep, s: StepRun | undefined): Tone => (!s || s.status === 'pending' ? 'pending' : s.status === 'running' ? (spec.type === 'agent' && !s.agentId ? 'starting' : 'running') : s.status)
    const lineOf = (spec: FlowStep, s: StepRun | undefined): string => (s?.status === 'failed' ? (s.error ?? 'Failed') : s?.status === 'waiting' ? 'Waiting for your answer in the chat' : s?.status === 'done' && spec.type === 'approval' ? 'Approved' : s?.status === 'done' && s.preview ? s.preview : (spec.description ?? ''))
    const metaOf = (spec: FlowStep): string => (spec.type === 'agent' ? `${spec.model ?? 'sonnet'} · ${spec.effort ?? 'medium'}` : spec.type === 'code' ? `code · ${spec.file ?? ''}` : spec.type === 'each' ? `for each · ${Math.max(1, Math.min(10, spec.parallel ?? 3))} at once` : 'approval')
    const head = drawHeader(w, {
      name,
      description: flow.description,
      run: isDraft ? 'Draft' : run ? `Run ${run.id}${isPast ? ' (earlier)' : ''} · ${run.status}` : '',
      tone: isDraft ? 'waiting' : !run ? 'pending' : run.status === 'running' ? 'running' : run.status === 'waiting' ? 'waiting' : run.status === 'done' ? 'done' : run.status === 'failed' ? 'failed' : 'ended',
      week: !run ? '—' : week === null ? '…' : week < 0.1 ? '< 0.1%' : `≈ ${week.toFixed(1)}%`,
      tokens: run ? count(tokensOf(run)) : '—',
      time: run ? clock(Math.max(0, (run.endedAt ?? Math.max(t, run.startedAt)) - run.startedAt)) : '—',
      note: isDraft ? DRAFTED : flow.error ? `This flow cannot run: ${flow.error}` : (run?.ended ?? (run ? '' : 'Not run yet.')),
      isError: Boolean(flow.error),
    })
    const pictures: { key: string; source: string; height: number; alt: string }[] = []
    steps.forEach((spec, i) => {
      const role = spec.role ? { role: spec.role } : {}
      const tag = spec.type === 'agent' ? (spec.role ?? 'agent') : ''
      if (each < 0 || i <= each || items.length === 0) {
        const s = main?.steps[i]
        pictures.push({ key: `step:${i}`, alt: `${i + 1}. ${spec.name}: ${s?.status ?? 'pending'}`, ...drawRow(w, { kind: spec.type, ...role, tone: toneOf(spec, s), title: `${i + 1}. ${spec.name}`, tag, meta: metaOf(spec), stats: meter(s, t), line: lineOf(spec, s) }) })
        return
      }
      // After the "each": the step once, then one small row per item.
      const each_ = items.map(tr => tr.steps[i])
      const done = each_.filter(s => s?.status === 'done').length
      const tone: Tone = each_.some(s => s?.status === 'running') ? 'running' : each_.some(s => s?.status === 'waiting') ? 'waiting' : done === items.length ? 'done' : each_.some(s => s?.status === 'failed') ? 'failed' : 'pending'
      pictures.push({ key: `step:${i}`, alt: `${i + 1}. ${spec.name}: ${done} of ${items.length} done`, ...drawRow(w, { kind: spec.type, ...role, tone, title: `${i + 1}. ${spec.name}`, tag, meta: metaOf(spec), stats: `${done}/${items.length}`, line: spec.description ?? '' }) })
      items.forEach((tr, k) => {
        const s = tr.steps[i]
        const said = s?.status === 'failed' || s?.status === 'waiting' || (s?.status === 'done' && Boolean(s.preview))
        pictures.push({ key: `item:${i}:${k}`, alt: `${tr.item ?? `Item ${k + 1}`}: ${s?.status ?? 'pending'}`, ...drawItem(w, { ...role, tone: toneOf(spec, s), label: tr.item ?? `Item ${k + 1}`, stats: meter(s, t), line: said ? lineOf(spec, s) : '' }) })
      })
    })
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{top}</Box>
        <Svg key="head" source={head.source} alt={`${name}${run ? `: run ${run.id}, ${run.status}` : ''}`} width={w} height={head.height} />
        {notes && <Box marginBottom={1}>{notes}</Box>}
        {pictures.map(p => (
          <Svg key={p.key} source={p.source} alt={p.alt} width={w} height={p.height} />
        ))}
      </Box>
    )
  }

  /** One step's row for one track, and under it its error, what it waits on, or the start of its result. */
  const row = (i: number, spec: FlowStep, track: number, tr: Track | undefined, label: string) => {
    const s = tr?.steps[i]
    const launching = s?.status === 'running' && spec.type === 'agent' && !s.agentId
    return (
      <Box key={`row:${track}:${i}`} flexDirection="column">
        <Text>
          {`${GLYPH[s?.status ?? 'pending']} ${label}  `}
          <Text dimColor>{[track === 0 ? kindOf(spec) : '', launching ? 'starting' : meter(s, t)].filter(Boolean).join(' · ')}</Text>
        </Text>
        {s?.status === 'failed' && <Text color="error">{`   ${s.error ?? 'Failed'}`}</Text>}
        {s?.status === 'waiting' && <Text color="warning">{'   Waiting for your answer in the chat'}</Text>}
        {s?.status === 'done' && s.preview && spec.type !== 'approval' && <Text dimColor>{`   ${oneLine(s.preview, 110)}`}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      {top}
      <Box flexDirection="column">
        <Text bold>{name}</Text>
        {flow.description && <Text dimColor>{flow.description}</Text>}
        {flow.error && <Text color="error">{`This flow cannot run: ${flow.error}`}</Text>}
      </Box>
      {run ? (
        <Box flexDirection="column">
          <Text>
            <Text bold>{`Run ${run.id} · ${run.status}`}</Text>
            {`  ${clock(Math.max(0, (run.endedAt ?? Math.max(t, run.startedAt)) - run.startedAt))} · ${count(tokensOf(run))} tokens${week !== null ? ` · week ≈ ${week < 0.1 ? '<0.1' : week.toFixed(1)}%` : ''}`}
          </Text>
          {run.ended && <Text dimColor>{run.ended}</Text>}
          {notes}
        </Box>
      ) : (
        <Text color={isDraft ? 'warning' : 'inactive'}>{isDraft ? DRAFTED : 'Not run yet.'}</Text>
      )}
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

/** The flows, one line each: what it does, how long it is, what it asks for, and how its last run here went. */
async function flowLines($: EngineInterface): Promise<string[]> {
  const all = await read($, runs)
  return (await read($, flows)).map(f => {
    const run = all[f.name]
    const cost = run?.status === 'done' && run.endedAt !== undefined && !run.dry ? `, ${count(tokensOf(run))} tokens, ${clock(run.endedAt - run.startedAt)}` : ''
    const last = f.error ? `cannot run: ${f.error}` : run ? `run ${run.id} ${run.status}${cost}` : 'not run here yet'
    const asks = f.inputs?.length ? ` · inputs: ${f.inputs.map(d => `${d.id}${d.required ? '*' : ''}`).join(', ')}` : ''
    return `${f.name}: ${f.description || '(no description)'} (${f.steps.length} step${f.steps.length === 1 ? '' : 's'}${asks} · ${last})`
  })
}

/** Flows in this session's folder from before the flows moved to ~/.claude/flows, not brought over yet. */
async function leftBehind($: EngineInterface): Promise<string[]> {
  const out = await outDir($)
  if (!out) return []
  const have = new Set((await read($, flows)).map(f => f.name))
  const dirs = (await $.fs.list(out).catch(() => [])).filter(d => d.kind === 'dir' && NAME.test(d.name) && !have.has(d.name))
  const found: string[] = []
  for (const d of dirs) if (await $.fs.exists(`${out}/${d.name}/flow.json`).catch(() => false)) found.push(d.name)
  return found
}

/** Copies a flow's flow.json and the scripts of its code steps from one folder to another. Answers why not, or null. */
async function copyFlow($: EngineInterface, from: string, to: string): Promise<string | null> {
  const json = await $.fs.read(`${from}/flow.json`).catch(() => null)
  if (json === null) return `There is no flow.json in ${from}.`
  if (await $.fs.exists(`${to}/flow.json`).catch(() => false)) return `There is a flow in ${to} already.`
  for (const [path, text] of Object.entries(await scripts($, from, json))) await $.fs.write(`${to}/${path}`, text)
  await $.fs.write(`${to}/flow.json`, json)
  return null
}

/** What deleting a flow takes with it, in words, and its folder; or why it cannot be deleted now. */
async function whatGoes($: EngineInterface, name: string): Promise<{ why: string } | { what: string; dir: string }> {
  const flow = (await read($, flows)).find(f => f.name === name)
  if (!flow) return { why: `There is no flow named "${name}".` }
  if (active((await read($, runs))[name])) return { why: `"${name}" is running. Stop it first, then delete it.` }
  const dir = flowDir(await homeDir($), name)
  return { what: `the flow "${name}" for good, for every session: its ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}, its scripts and its memory, in ${dir}. Its runs' files stay in the folders where they ran`, dir }
}

/** Deletes a flow's folder; nothing brings it back. */
async function removeFlow($: EngineInterface, name: string, dir: string): Promise<string> {
  const gone = await $.process.run(['node', '-e', 'require("fs").rmSync(process.argv[1],{recursive:true,force:true})', dir]).catch(() => null)
  await loadFlows($)
  const left = (await read($, flows)).some(f => f.name === name)
  return left || gone?.exitCode !== 0 ? `"${name}" could not be deleted. Its folder is ${dir}.` : `Deleted "${name}".`
}

const MANAGE_ACTIONS = ['open', 'close', 'list', 'show', 'run', 'retry', 'stop', 'delete', 'copy', 'rename', 'import'] as const

type ManageInput = { action?: unknown; flow?: unknown; input?: unknown; inputs?: unknown; from?: unknown; dry?: unknown; replace?: unknown; item?: unknown; run?: unknown; to?: unknown; path?: unknown; confirmed?: unknown }

/**
 * What /flows does, for the session's Claude when the person asks in their own words ("open the flows",
 * "start the Spain visits flow"). Answers what happened and what to tell the person, or what to do next.
 */
async function manage($: EngineInterface, input: ManageInput): Promise<string> {
  const action = typeof input.action === 'string' ? input.action : ''
  const name = typeof input.flow === 'string' ? input.flow.trim() : ''
  const to = typeof input.to === 'string' ? input.to.trim() : ''
  if (action === 'close') {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return 'Closed the Flows pane. Tell the user in a few words.'
  }
  if (action === 'open') {
    await loadFlows($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
    return 'Opened the Flows pane. Tell the user in a few words.'
  }
  const home = await homeDir($)
  if (!home) return `${NO_HOME} Tell the user so.`
  await loadFlows($)
  const lines = await flowLines($)
  const behind = await leftBehind($)
  const listed = [
    ...(lines.length ? [`The flows (kept in ${home}, for every session):`, ...lines.map(l => `- ${l}`)] : ['There are no flows yet.']),
    ...(behind.length ? [`This session's folder has flows from before the flows moved to ${home}, not brought over: ${behind.join(', ')}. Offer to bring them over (${MANAGE} {"action":"import","flow":"<name>"}).`] : []),
  ]
  if (action === 'list') return [...listed, lines.length ? 'Tell the user, as a short list.' : `Tell the user, and offer to write one with them (${DRAFT}).`].join('\n')
  if (!(MANAGE_ACTIONS as readonly string[]).includes(action)) return `Call ${MANAGE} with "action" one of ${MANAGE_ACTIONS.join(', ')}. To write or change a flow, use ${DRAFT}.`
  if (action === 'import') {
    // From a folder the user named, or from this session's Flows folder, where flows were kept before.
    const from = typeof input.path === 'string' && input.path.trim() ? input.path.trim().replace(/\\/g, '/').replace(/\/+$/, '') : name ? `${await outDir($)}/${name}` : ''
    const named = to || name || from.split('/').pop() || ''
    if (!from) return `Name the flow to bring over, or the folder it is in. Ask the user.`
    if (!NAME.test(named) || VERBS.includes(named)) return `"${named}" is not a flow name: lower-case letters, digits and hyphens. Call again with "to" set to one the user agrees to.`
    const why = await copyFlow($, from, flowDir(home, named))
    await loadFlows($)
    return why ? `${why} Tell the user.` : `Brought "${named}" over to ${flowDir(home, named)}: every session has it now. Its old copy in ${from} is left as it was, and so are its runs there. Tell the user.`
  }
  // Every other action names a flow: one the person named in their own words is found in the list.
  if (!(await read($, flows)).some(f => f.name === name)) {
    return [name ? `There is no flow named "${name}".` : 'Name the flow.', ...listed, lines.length ? 'If one of these is clearly what the user meant, call again with its name; otherwise ask them which.' : `Tell the user, and offer to write one with them (${DRAFT}).`].join('\n')
  }
  if (action === 'show') {
    await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
    const id = typeof input.run === 'number' ? input.run : undefined
    if (id === undefined) await update($, view, () => ({ flow: name }))
    const why = id === undefined ? null : await showRun($, name, id)
    return why ? `${why} Tell the user.` : `Showing ${id === undefined ? `"${name}"` : `run ${id} of "${name}"`} in the Flows pane. Tell the user in a few words.`
  }
  if (action === 'run' || action === 'retry') {
    if (!(await outDir($))) return `${NO_FOLDER} Tell the user so.`
    await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
    const was = (await read($, runs))[name]
    let said = ''
    if (action === 'run') {
      const inputs = input.inputs && typeof input.inputs === 'object' && !Array.isArray(input.inputs) ? (input.inputs as Record<string, unknown>) : undefined
      const from = typeof input.from === 'string' || typeof input.from === 'number' ? input.from : undefined
      said = await startRun($, name, typeof input.input === 'string' ? input.input.trim() : '', false, { ...(inputs ? { inputs } : {}), ...(from !== undefined ? { from } : {}), dry: input.dry === true, replace: input.replace === true })
      const now = (await read($, runs))[name]
      if (!now || now.id === was?.id) {
        const busy = active(was) && now?.id === was?.id ? ` To start a new run in its place, ask the user first, then call again with "replace": true; to go on with it, use "retry" if it stopped, or ${TOOL}.` : ''
        return `${said}${busy} Tell the user.`
      }
    } else {
      const why = await takeUp($, name, typeof input.item === 'number' || typeof input.item === 'string' ? input.item : undefined)
      if (why) return `${why} Tell the user.`
    }
    // The run is this turn's now: the person stopping the chat stops it.
    if (mainTurn) turnOf.set(name, mainTurn)
    const cost = action === 'run' ? await estimate($, name) : ''
    return [`${action === 'run' ? said : `Took up "${name}".`}${cost ? ` ${cost}` : ''} Carry it out now, step by step, until it is over:`, await directive($, name)].join('\n')
  }
  if (action === 'copy' || action === 'rename') {
    if (!NAME.test(to) || VERBS.includes(to)) return `Call again with "to" set to the new name: lower-case letters, digits and hyphens, and none of ${VERBS.join(', ')}. Ask the user if they gave none.`
    if (action === 'rename' && active((await read($, runs))[name])) return `"${name}" is running. Stop it first, then rename it. Tell the user.`
    const why = await copyFlow($, flowDir(home, name), flowDir(home, to))
    if (why) return `${why} Tell the user.`
    if (action === 'copy') {
      await loadFlows($)
      return `Copied "${name}" to "${to}" (its steps and scripts, not its memory or runs). Tell the user; ${DRAFT} changes the copy.`
    }
    const memory = await $.fs.read(memoryFile(home, name)).catch(() => null)
    if (memory !== null) await $.fs.write(memoryFile(home, to), memory)
    const gone = await removeFlow($, name, flowDir(home, name))
    return `Renamed "${name}" to "${to}"${gone.startsWith('Deleted') ? '' : `, but the old one is still there (${gone})`}. Its earlier runs' files stay under the old name, in Flows/${name}/runs of the folders where they ran. Tell the user.`
  }
  if (action === 'stop') {
    const run = (await read($, runs))[name]
    if (!active(run)) return `"${name}" is not running. Tell the user.`
    if (run?.owner !== (await read($, me))) return `"${name}" is running in another session; stop it there. Tell the user.`
    await stopRun($, name)
    return `Stopped "${name}". Tell the user; it can be taken up again where it stopped.`
  }
  // Delete: nothing brings a flow back, so the person says yes to exactly what goes.
  const goes = await whatGoes($, name)
  if ('why' in goes) return `${goes.why} Tell the user.`
  if (input.confirmed !== true) return `This would delete ${goes.what}. Tell the user exactly that and ask whether to go ahead. Only if they say yes, call ${MANAGE} again with {"action":"delete","flow":"${name}","confirmed":true}.`
  return `${await removeFlow($, name, goes.dir)} Tell the user.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!(await read($, me))) {
      const id = `${await $.session.id().catch(() => 'session')}:${await $.clock.now()}`
      await update($, me, () => id)
    }
    await $.command.register({ name: 'flows', description: 'Flows: open the pane, or write, change, run and take up a flow', argumentHint: '[list | new <name> <what> | edit <name> <what> | run <name> [input] | retry <name> | delete <name> | <name> [run]]' }).catch(() => undefined)
    await $.tool
      .register({
        name: 'next',
        description: [
          `Carries out a run of a saved flow of the Flows plugin, one step at a time, once it has started (by ${MANAGE}, /flows run or /flows retry, or a button of the Flows pane). Call it again after each thing it tells you to do, until it says the flow is over. To start, stop, list, show or delete a flow, or open the Flows pane, use ${MANAGE}.`,
          'It answers with exactly one thing to do: start the agents it names (with the Agent tool, in the background, with the subagent_type and description it gives; Flows fills in each agent\'s real task), or put an approval to the user, or report the end.',
          'Follow its answer to the letter. Never do a step\'s work yourself, never answer an approval for the user, never read or change the run\'s files, and keep your own messages to one short line per step.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            flow: { type: 'string', description: "The flow's name." },
            answer: { type: 'string', enum: ['approve', 'edit', 'reject', 'back', 'approve_all'], description: "The user's answer to the approval the flow waits on. Only what the user said. \"edit\" approves it as the user changed it; \"approve_all\" approves every item waiting at the same step." },
            note: { type: 'string', description: 'With answer "back": what the user wants changed. With "edit": the whole text to hand on, as the user changed it.' },
            approval: { type: 'string', description: 'With an answer: the approval it answers, as "track.step", exactly as the flow named it.' },
            retry: { type: 'boolean', description: 'True to take up a run that failed or was stopped, at its failed step.' },
          },
          required: ['flow'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    await $.tool
      .register({
        name: 'draft',
        description: 'Writes or changes a saved flow of the Flows plugin, with the user. Call it with {"flow": name, "action": "start"} when the user wants a new flow or a change to one, in their own words or with /flows new or /flows edit, or a fix after a failed run (' + MANAGE + ' with "list" shows the names already taken): it answers how to interview them and what a flow is made of. Then "propose" sends the whole flow, or a "patch" of the steps that change, to be checked and shown in the pane as a draft, and "save" writes it once the user agreed; "discard" drops the draft. Never save without the user saying so.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: { type: 'string', description: "The flow's name: lower-case letters, digits and hyphens." },
            action: { type: 'string', enum: ['start', 'propose', 'save', 'discard'] },
            description: { type: 'string', description: 'With "propose": what the flow does, in a line or two.' },
            cwd: { type: 'string', description: 'With "propose", optional: a folder on this computer the agents may also write in.' },
            inputs: { type: 'array', items: { type: 'object' }, description: 'With "propose", optional: what the flow asks for when it runs, each { id, description, type, required, default }.' },
            maxTokens: { type: 'number', description: 'With "propose", optional: the most tokens a run may use.' },
            steps: { type: 'array', items: { type: 'object' }, description: 'With "propose": the steps, in order, as the answer to "start" describes them.' },
            patch: { type: 'array', items: { type: 'object' }, description: 'With "propose", in place of "steps": the steps that change or are added, each with its "id" and only the fields that change ("after": the id of the step a new one goes after).' },
            remove: { type: 'array', items: { type: 'string' }, description: 'With "propose" and "patch": the ids of the steps to take out.' },
            files: { type: 'object', additionalProperties: { type: 'string' }, description: 'With "propose": the code of each code step, by its path in the flow\'s folder.' },
            agreed: { type: 'boolean', description: 'With "propose", true only when the user has already said yes to exactly this change (a fix they approved after a failed run): the flow is then saved at once, with no draft and no second question.' },
          },
          required: ['flow', 'action'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    await $.tool
      .register({
        name: 'manage',
        description: [
          'Does what the /flows command does, for the saved flows (repeatable automations) of the Flows plugin, when the user asks in their own words, in any language: "open the flows", "which flows do I have", "start the Spain visits flow with Madrid", "try it without spending tokens", "stop it", "take it up again", "only redo the second client", "copy webdev to webdev2", "delete the test flow".',
          'Actions: "open" and "close" the Flows pane; "list" the flows; "show" one in the pane (with "run" for an earlier run); "run" one, with "input" or "inputs" when the user gave them, "from" to start at a step, "dry" for a test run that starts no agent, "replace" to stop a run still going and start anew (ask the user first); "retry" takes up a run that failed or was stopped, where it stopped (with "item", only that item); "stop" a run; "copy" and "rename" a flow ("to" the new name); "import" brings over a flow from a folder ("path") or from the session\'s Flows folder; "delete" a flow.',
          'Name the flow as the user did when you do not know its exact name: the answer lists the flows to pick from. After "run" or "retry", do what the answer says, step by step, with mcp__flows__next.',
          'To write a new flow or change one, use mcp__flows__draft. Never set "confirmed" unless the user said yes to that very deletion.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...MANAGE_ACTIONS] },
            flow: { type: 'string', description: "The flow's name, or the user's words for it." },
            input: { type: 'string', description: 'With "run": what the flow\'s first step receives, from what the user said.' },
            inputs: { type: 'object', description: 'With "run", for a flow that lists its inputs: their values, by id.' },
            from: { type: 'string', description: 'With "run": the id or number of the step to start at; the input stands for what the step before would have handed on.' },
            dry: { type: 'boolean', description: 'With "run": a test run, which starts no agent (each hands on a made-up result) and passes the approvals by itself.' },
            replace: { type: 'boolean', description: 'With "run": stop the run of this flow still going and start a new one. Only once the user said so.' },
            item: { type: 'string', description: 'With "retry": the number (or name) of the one item to take up.' },
            to: { type: 'string', description: 'With "copy", "rename" or "import": the new name.' },
            path: { type: 'string', description: 'With "import": the folder the flow is in.' },
            run: { type: 'number', description: 'With "show": the number of an earlier run.' },
            confirmed: { type: 'boolean', description: 'With "delete": true only once the user said yes to what the first call said would go.' },
          },
          required: ['action'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    await loadFlows($).catch(() => undefined)
    $.clock.every(TICK, () => void tick($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'flows' }, async ($, e) => {
    const [verb = '', name = '', ...rest] = e.args.trim().split(/\s+/)
    if (!verb) return { text: await togglePane($) }
    const home = await homeDir($)
    if (!home) return { text: NO_HOME }
    await loadFlows($)
    if (verb === 'list') {
      const lines = await flowLines($)
      const behind = await leftBehind($)
      const old = behind.length ? [`Not brought over from this folder's Flows yet: ${behind.join(', ')} (ask Claude to import them).`] : []
      if (lines.length === 0) return { text: [`There are no flows yet. /flows new <name> <what it should do> writes one, in ${home}.`, ...old].join('\n') }
      return { text: [`${lines.length} flow${lines.length === 1 ? '' : 's'} in ${home}:`, ...lines, ...old].join('\n') }
    }
    if (verb === 'delete') {
      if (!name) return { text: 'Usage: /flows delete <name>' }
      const goes = await whatGoes($, name)
      if ('why' in goes) return { text: goes.why }
      // Nothing brings a deleted flow back, so the command is typed twice: once to see what goes, once with "yes".
      if (rest[0] !== 'yes') return { text: `This deletes ${goes.what}. To go ahead: /flows delete ${name} yes` }
      return { text: await removeFlow($, name, goes.dir) }
    }
    if ((verb === 'run' || verb === 'retry') && name) {
      if (!(await outDir($))) return { text: NO_FOLDER }
      await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
      if (verb === 'retry') return { text: await retryRun($, name, rest[0]) }
      // --test makes a test run, --new stops the run still going; key=value pairs are the flow's inputs.
      const words = rest.filter(w => w !== '--test' && w !== '--new')
      const pairs = words.filter(w => /^[a-zA-Z][\w-]*=/.test(w))
      const inputs = pairs.length && pairs.length === words.length ? Object.fromEntries(pairs.map(w => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)])) : undefined
      return { text: await startRun($, name, inputs ? '' : words.join(' '), true, { ...(inputs ? { inputs } : {}), dry: rest.includes('--test'), replace: rest.includes('--new') }) }
    }
    // Any other first word is a flow to show, with one of its earlier runs when a number follows.
    if (!VERBS.includes(verb)) {
      if (!(await read($, flows)).some(f => f.name === verb)) return { text: `There is no flow named "${verb}". ${USAGE}` }
      await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
      if (!name) {
        await update($, view, () => ({ flow: verb }))
        return { text: `Showing "${verb}".` }
      }
      // An earlier run, read from its folder.
      const why = await showRun($, verb, Number(name), name)
      return { text: why ?? `Showing run ${name} of "${verb}". /flows ${verb} goes back to the newest.` }
    }
    if (verb === 'new' || verb === 'edit') {
      if (!NAME.test(name) || VERBS.includes(name)) return { text: `Usage: /flows ${verb} <name> <${verb === 'new' ? 'what it should do' : 'what to change'}>. The name takes lower-case letters, digits and hyphens, and is none of: ${VERBS.join(', ')}.` }
      const exists = (await read($, flows)).some(f => f.name === name)
      if (verb === 'new' && exists) return { text: `There is already a flow named "${name}". /flows edit ${name} <what to change> changes it.` }
      if (verb === 'edit' && !exists) return { text: `There is no flow named "${name}". /flows new ${name} <what it should do> writes one.` }
      const asked: Draft = { name, mode: verb, ask: rest.join(' '), flow: null, files: {} }
      await update($, draft, () => asked)
      await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
      kick($, `${verb === 'new' ? 'Help me write a new saved flow' : 'Help me change my saved flow'} called "${name}": call the ${DRAFT} tool with {"flow":"${name}","action":"start"} and do what it answers.`)
      return { text: verb === 'new' ? `Writing "${name}" with you in the chat.` : `Changing "${name}" with you in the chat.` }
    }
    return { text: USAGE }
  })

  // A button above the prompt opens and closes the pane, like /flows. It is drawn above whatever band the
  // plugins beneath draw (another mod's bar stays under it, whole), and yields to a survey.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e).catch(() => null)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box justifyContent="flex-end">
          <Button key="flows-toggle" label="Flows" onPress={() => void togglePane($)} />
        </Box>
        {below}
      </Box>
    )
  })

  // A flow picked in the pane's picker (picker.tsx).
  on('ui.message', async ($, e, next) => {
    const data = e.data as { show?: unknown } | null
    if (e.element !== 'picker' || typeof data?.show !== 'string') return next(e)
    await actsOf($).show(data.show)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => pane($.ui.resolve(e), actsOf($), await read($, flows), await read($, runs), await read($, view), await read($, now), e.surface === 'desktop', e.props.bodyColumns ?? 0, await read($, past), await read($, draft), await outDir($)))

  // The session's Claude asks what to do next, and brings the person's answer to an approval.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as { flow?: unknown; answer?: unknown; note?: unknown; retry?: unknown; approval?: unknown }
    const name = typeof input.flow === 'string' ? input.flow : ''
    if (mainTurn) turnOf.set(name, mainTurn)
    if (input.retry === true) {
      await loadFlows($)
      const why = await takeUp($, name)
      if (why) return { result: why }
    }
    const run = (await read($, runs))[name]
    // The approval the person answered is named ("track.step"): a newer one may have come in ahead of it since.
    const named = /^(\d+)\.(\d+)$/.exec(typeof input.approval === 'string' ? input.approval : '')
    const ask = run ? (waiting(run).find(([t, i]) => named && t === Number(named[1]) && i === Number(named[2])) ?? (named ? undefined : waiting(run)[0])) : undefined
    const note = typeof input.note === 'string' ? input.note : ''
    if (run && ask && input.answer === 'approve_all') {
      // Every item waiting at the same step, approved at once.
      for (const [t, i] of waiting(run).filter(([, i]) => i === ask[1])) await decide($, name, t, i, 'approve', '')
    } else if (run && ask && (input.answer === 'approve' || input.answer === 'reject' || input.answer === 'back' || input.answer === 'edit')) await decide($, name, ask[0], ask[1], input.answer, note)
    await inflight
    await advance($, name)
    return { result: await directive($, name) }
  }).catch(() => ({ result: `Flows could not work out the next step. Tell the user, and do nothing more for this flow.` }))

  // The session's Claude does what /flows does, from the person's own words.
  on('tool.call', { tool: MANAGE }, async ($, e) => ({ result: await manage($, e as ManageInput) })).catch(() => ({ result: 'Flows could not do that. Tell the user, and do nothing more with it.' }))

  // The session's Claude writes or changes a flow with the person.
  on('tool.call', { tool: DRAFT }, async ($, e) => ({ result: await authoring($, e as Proposal & { flow?: unknown; action?: unknown; agreed?: unknown }) })).catch(() => ({ result: 'Flows could not handle the draft. Tell the user, and do nothing more with it.' }))

  // The session's Claude starts a step's agent: the step's real task and folder go in here, so what one
  // step hands the next never passes through the chat. An agent that is no step waiting to start is refused.
  on('agent.spawn', async ($, e, next) => {
    if (!e.subagentType?.startsWith('flows:')) return next(e)
    // The step is the one waiting to start whose description this is, word for word.
    const found = Object.entries(await read($, runs)).flatMap(([n, r]) => toLaunch(r).flatMap(([t, i]) => (launchName(r, t, i) === e.description ? [{ name: n, run: r, track: t, step: i }] : [])))[0]
    const s = found?.run.tracks[found.track]?.steps[found.step]
    if (!found || s?.startedAt === undefined) return { deny: `Flows: this is not a step waiting to start. Call ${TOOL} and use the subagent_type and description it gives.` }
    const { name, run, track, step } = found
    const token = s.startedAt
    const dir = runDir(await outDir($), name, run.id)
    const prompt = await agentPrompt($, run, track, step, dir, token)
    const spawn = (async () => {
      const started = await next({ ...e, prompt, cwd: run.cwd ?? dir, background: true })
      // The id comes with the answer; where it does not, the agent is found in the session's list by its description.
      const agentId = started.deny !== undefined ? undefined : (started.agentId ?? (await $.agent.list().catch(() => [])).filter(a => a.description === e.description && !known.has(a.id)).pop()?.id)
      if (agentId) {
        known.add(agentId)
        await mutate($, name, r => noteStep(r, track, step, token, { agentId }))
      } else await finishStep($, name, track, step, token, { error: `The agent did not start: ${started.deny ?? 'it has no id'}` })
      return started
    })()
    inflight = Promise.allSettled([inflight, spawn])
    return spawn
  }).catch(($, e, next) => next(e))

  // Which of the session's own turns is running: the one a flow is being run in, when the person stops it, stops the flow.
  on('turn.start', ($, e, next) => {
    mainTurn = e.turnId
    return next(e)
  })

  // A flow step's agent ended its turn. Started in the foreground (the rule), its result is what its Agent
  // call returns, a moment later: the session has it hand its report back through a tool, and its last
  // message may be about anything. Started in the background, its last message is the result.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (!e.agentId) {
      if (e.turnId === mainTurn) mainTurn = undefined
      // The person stopped the chat: the flows it was running stop there, to be taken up with /flows retry.
      const t = await $.clock.now()
      for (const [name, turn] of [...turnOf]) {
        if (turn !== e.turnId) continue
        turnOf.delete(name)
        if (e.isAborted && active((await read($, runs))[name])) {
          await mutate($, name, r => halt(r, 'stopped', 'Stopped', t))
          await closeRun($, name)
        }
      }
    }
    // An agent this module started, or one written into a run before the plugin was reloaded (its sets are gone
    // then, and it runs in the background, as every step's agent does now).
    const id = e.agentId
    const isStep = id !== undefined && (known.has(id) || Object.values(await read($, runs)).some(r => agentStep(r, id) !== null))
    if (id && isStep) {
      const u = e.usage
      const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      if (detached.has(id) || !known.has(id) || e.reason !== 'answer') await agentDone($, id, e.answer, e.reason, tokens).catch(() => undefined)
      else ended.set(id, { answer: e.answer, reason: e.reason, tokens })
    }
    return out
  })

  // The Agent call of a flow step returned to the session's Claude: the report handed back is the step's result.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (!String(e.subagent_type ?? '').startsWith('flows:')) return ran
    const result = (ran.result ?? {}) as { agentId?: string; handbackReport?: { text?: string }; content?: { text?: string }[]; totalTokens?: number; totalDurationMs?: number }
    const agentId = result.agentId
    if (!agentId || !known.has(agentId)) return ran
    const last = ended.get(agentId)
    // No report, no content and no turn ended yet: it was started in the background after all.
    if (!last && !result.handbackReport && result.totalDurationMs === undefined) {
      detached.add(agentId)
      return ran
    }
    const text = result.handbackReport?.text || last?.answer || (result.content ?? []).map(c => c.text ?? '').join('\n')
    await agentDone($, agentId, text, ran.isError ? 'error' : (last?.reason ?? 'answer'), result.totalTokens ?? last?.tokens ?? 0).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  // What a flow's agent may do without anyone to ask: read, use the web, write inside its folders, and
  // the tools its step names. Everything else is refused.
  on('tool.check', async ($, e, next) => {
    // This plugin's own stop of a step's agent: nobody's prompt asked for it, so auto mode would refuse it.
    if (!e.agentId) return next.origin.plugin === 'flows' && String(e.tool) === 'TaskStop' ? { decision: 'allow' as const, reason: 'Stopping a flow step' } : next(e)
    for (const [name, run] of Object.entries(await read($, runs))) {
      const at = agentStep(run, e.agentId)
      if (!at) continue
      const spec = run.steps[at[1]]
      const tool = String(e.tool)
      // The hand-back is the session's own to judge: in auto mode only its classifier may allow it.
      if (tool === HANDBACK) return next(e)
      if (READ_TOOLS.includes(tool) || spec?.tools?.includes(tool)) return { decision: 'allow' as const, reason: `Flow ${name}` }
      if (WRITE_TOOLS.includes(tool)) {
        const dir = runDir(await outDir($), name, run.id)
        const input = (e.input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
        const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
        if (inside(path, run.cwd ?? dir, [dir, ...(run.cwd ? [run.cwd] : [])])) return { decision: 'allow' as const, reason: `Flow ${name}` }
        return { decision: 'deny' as const, reason: `This flow step may write only inside ${dir}${run.cwd ? ` and ${run.cwd}` : ''}.` }
      }
      return { decision: 'deny' as const, reason: `This flow step was not given the tool ${tool}.` }
    }
    return next(e)
  }).catch(($, e, next) => {
    if (next.error.kind === 're-entry') return String(e.tool) === 'TaskStop' ? { decision: 'allow' as const, reason: 'Stopping a flow step' } : next(e)
    return e.agentId && known.has(e.agentId) ? { decision: 'deny' as const, reason: 'Flows could not check this call.' } : next(e)
  })
}
