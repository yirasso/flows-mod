// Flows: saved multi-step flows (agents, code, approvals, for-each), shown in a pane. This module keeps
// each run's state and decides the next step; the session's own Claude carries it out: it calls the tool
// `next`, starts the agents the answer names and puts the approvals to the person in the chat. That way a
// flow runs under the session's permission mode like any other work (a plugin's own spawn is refused in
// auto mode). A project's flows live in its own Flows folder, <project>/Flows/<name>/; flow.ts holds the rules.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Draft, Flow, FlowStep, Run, StepRun, Track, View } from '../types'
import { check, flowJson, guide, presented, sameShape } from './author'
import type { Proposal } from './author'
import { BASE_TOOLS, NAME, READ_TOOLS, WRITE_TOOLS, agentBefore, agentStep, claim, finish, flowDir, halt, inFile, inside, itemsOf, labelOf, newRun, outFile, parseFlow, pending, promote, resultFile, retry, runDir, sendBack, settle, split, tokensOf } from './flow'
import type { Outcome } from './flow'
import { header as drawHeader, item as drawItem, row as drawRow } from './draw'
import type { Tone } from './draw'

const PANE = 'flows'
const TOOL = 'mcp__flows__next'
/** The tool the session's Claude writes and changes flows with. */
const DRAFT = 'mcp__flows__draft'
/** The tool the session has a foreground agent hand its report back with; a step's agent needs it. */
const HANDBACK = 'SubagentHandback'
const flows = atom({ plugin: 'flows', key: 'flows' } as const, [])
const runs = atom({ plugin: 'flows', key: 'runs' } as const, {})
const view = atom({ plugin: 'flows', key: 'view' } as const, { flow: null })
const now = atom({ plugin: 'flows', key: 'now' } as const, 0)
const past = atom({ plugin: 'flows', key: 'past' } as const, null)
const limit = atom({ plugin: 'flows', key: 'limit' } as const, null)
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

/** The session's folder, the project the flows belong to; empty when the session has none. */
async function projectDir($: EngineInterface): Promise<string> {
  return ((await $.session.cwd().catch(() => '')) ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Where this project's flows are kept: its Flows folder (Tomás, 10 Oct 2026: a flow belongs to the project
 * it works on; to use one elsewhere, copy its folder). Not under .claude, where the session asks the person
 * before every write.
 */
async function rootDir($: EngineInterface): Promise<string> {
  const project = await projectDir($)
  return project ? `${project}/Flows` : ''
}

const NO_FOLDER = 'This session has no folder, and a flow lives in the Flows folder of its project. Open a session in a project to use flows.'

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
  const dirs = (root ? await $.fs.list(root).catch(() => []) : []).filter(d => d.kind === 'dir' && NAME.test(d.name)).map(d => d.name).sort()
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
  await update($, view, v => (v.flow && list.some(f => f.name === v.flow) ? v : { flow: list[0]?.name ?? null }))
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

// ——— A run's steps ———

const typeOf = (flow: string, spec: FlowStep): string => `${flow}-${spec.id}`.slice(0, 64)
/** What the session's Claude passes as an agent's description, so the agent is matched to its step. */
const launchName = (run: Run, track: number, step: number): string => `${run.flow} #${run.id} [${track}.${step}] ${run.steps[step]?.name ?? ''}`
const LAUNCH = /^(.+) #(\d+) \[(\d+)\.(\d+)\]/

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

/** What a step's agent is asked: its instruction, its input, its folders, and the note it was sent back with. */
async function agentPrompt($: EngineInterface, run: Run, track: number, step: number, dir: string, token: number): Promise<string> {
  const spec = run.steps[step]
  const input = await $.fs.read(inFile(dir, run, track, step)).catch(() => '')
  const note = run.tracks[track]?.steps[step]?.note
  const before = note === undefined ? '' : await $.fs.read(outFile(dir, track, step)).catch(() => '')
  return [
    `Task:\n${spec?.instruction ?? ''}`,
    ...(run.tracks[track]?.item !== undefined ? [`This run handles one item of a list (item ${track} of ${run.tracks.length - 1}).`] : []),
    `Folders you may write in: ${dir} (this run's folder)${run.cwd ? ` and ${run.cwd} (the project the flow works on)` : ''}.`,
    `Result file (write your result here, and only your result): ${resultFile(dir, track, step, token)}`,
    `Input:\n${input || '(none)'}`,
    ...(note !== undefined ? [`You did this before and the reviewer sent it back with this note:\n${note}\n\nYour previous result:\n${before}`] : []),
  ].join('\n\n')
}

/** Writes a step's result into its run. False when the step is no longer the one that was started at `token`. */
async function finishStep($: EngineInterface, name: string, track: number, step: number, token: number, o: Outcome): Promise<boolean> {
  const run = (await read($, runs))[name]
  if (!run) return false
  if (o.output !== undefined) await $.fs.write(outFile(runDir(await rootDir($), name, run.id), track, step), o.output)
  const t = await $.clock.now()
  return (await mutate($, name, r => finish(r, track, step, token, o, t))) !== null
}

/** Does a claimed step that needs no agent: a script, a split, or an approval's preview. */
async function work($: EngineInterface, name: string, run: Run, track: number, step: number, token: number): Promise<void> {
  const spec = run.steps[step]
  if (!spec) return
  const root = await rootDir($)
  const dir = runDir(root, name, run.id)
  const input = await $.fs.read(inFile(dir, run, track, step)).catch(() => '')
  if (spec.type === 'approval') {
    await mutate($, name, r => noteStep(r, track, step, token, { preview: input.slice(0, 2000) }))
    return
  }
  if (spec.type === 'each') {
    const items = itemsOf(input)
    if (items.length === 0) return void (await finishStep($, name, track, step, token, { output: input, end: 'There were no items' }))
    for (const [k, item] of items.entries()) await $.fs.write(`${dir}/out/${k + 1}-item.txt`, item)
    await mutate($, name, r => split(r, step, token, items.map(labelOf), token))
    return
  }
  const seconds = Math.max(1, Math.min(600, spec.seconds ?? 60))
  const stdin = JSON.stringify({ input, flow: name, run: run.id, track, runDir: dir, cwd: run.cwd ?? dir })
  const r = await $.process.run(['node', `${flowDir(root, name)}/${spec.file ?? ''}`], { cwd: dir, stdin, timeoutMs: seconds * 1000 })
  // Exit 0 hands the output on; exit 3 ends the flow there, its output the reason.
  if (r.exitCode === 0) await finishStep($, name, track, step, token, { output: r.stdout.trimEnd() })
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
      if (!claimed || type === 'agent') continue
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
    const token = run.tracks[at[0]]?.steps[at[1]]?.startedAt ?? 0
    const failed = /^\s*FLOW-ERROR:/i.test(answer)
    // The result is the file the agent was told to write; one that wrote none is taken at its word.
    const written = reason === 'answer' && !failed ? await $.fs.read(resultFile(runDir(await rootDir($), name, run.id), at[0], at[1], token)).catch(() => '') : ''
    const o: Outcome = reason !== 'answer' ? { error: `The agent stopped (${reason})${answer.trim() ? `: ${answer.trim().slice(0, 1200)}` : ''}`, tokens } : failed ? { error: answer.replace(/^\s*FLOW-ERROR:\s*/i, '').slice(0, 1500), tokens } : written.trim() ? { output: written.trimEnd(), tokens } : /^\s*DONE\.?\s*$/i.test(answer) ? { error: 'The agent said it was done but wrote no result file.', tokens } : { output: answer, tokens }
    if (await finishStep($, name, at[0], at[1], token, o)) await advance($, name)
    return
  }
}

/** The person's answer to an approval: on with it, end there, or back to the agent before with a note. */
async function decide($: EngineInterface, name: string, track: number, step: number, answer: 'approve' | 'reject' | 'back', note: string): Promise<void> {
  const run = (await read($, runs))[name]
  const s = run?.tracks[track]?.steps[step]
  if (!run || s?.status !== 'waiting') return
  if (answer === 'back' && agentBefore(run, track, step) >= 0) {
    await mutate($, name, r => sendBack(r, track, step, note.trim() || 'Please do it again.'))
    return
  }
  const input = await $.fs.read(inFile(runDir(await rootDir($), name, run.id), run, track, step)).catch(() => '')
  await finishStep($, name, track, step, s.startedAt ?? 0, answer === 'reject' ? { output: input, end: `Rejected at "${run.steps[step]?.name ?? 'approval'}"` } : { output: input })
}

// ——— What the session's Claude is told ———

const again = (name: string): string => `call ${TOOL} again with {"flow":"${name}"}`

/** The next thing to do for a run, in words for the session's Claude. */
async function directive($: EngineInterface, name: string): Promise<string> {
  const run = (await read($, runs))[name]
  if (!run) return `There is no run of a flow named "${name}". Tell the user to start one with /flows run ${name}.`
  const head = `Flow "${name}", run ${run.id}.`
  const asks = waiting(run)
  const launches = toLaunch(run)
  if (launches.length > 0) {
    const lines = launches.map(([t, s], i) => `${i + 1}. subagent_type: "flows:${typeOf(name, run.steps[s] as FlowStep)}" · description: "${launchName(run, t, s)}" · prompt: "${launchName(run, t, s)}"`)
    return [
      head,
      `Start ${launches.length === 1 ? 'this agent' : `these ${launches.length} agents`} now with the Agent tool${launches.length === 1 ? '' : ', all in one message'}, each with run_in_background set to false and exactly these values (Flows replaces the prompt with the step's real task, so do not write one):`,
      ...lines,
      `When ${launches.length === 1 ? 'it has' : 'they have all'} returned, ${again(name)}. Do not act on what the agents answer, and do not do their work yourself.`,
    ].join('\n')
  }
  if (working(run) > 0) return `${head} ${working(run)} of its agents are still working. Do not start them again: wait until they return, then ${again(name)}.`
  const ask = asks[0]
  if (ask) {
    const [t, s] = ask
    const spec = run.steps[s]
    const back = agentBefore(run, t, s) >= 0
    const item = run.tracks[t]?.item
    return [
      `${head} It waits for the user's approval at step ${s + 1}, "${spec?.name ?? ''}"${item !== undefined ? ` (item: ${item})` : ''}.`,
      `First show the user what they are approving, word for word, in a message:`,
      `<to-approve>\n${run.tracks[t]?.steps[s]?.preview || '(nothing)'}\n</to-approve>`,
      `Then ask them what to do: with the AskUserQuestion tool if you have it (options "Approve", "Reject"${back ? ', "Send back" (to the agent, with a note)' : ''}), otherwise with a plain question, ending your turn until they answer.`,
      `Then call ${TOOL} with {"flow":"${name}","answer":"approve"}, "reject"${back ? `, or "back" with "note" set to what the user wants changed` : ''}. Never answer for the user.`,
    ].join('\n')
  }
  if (run.status === 'done') {
    const last = run.tracks.flatMap(t => (t.status === 'done' && t.at === run.steps.length - 1 ? [t.steps[t.at]?.preview ?? ''] : [])).filter(Boolean)
    return [
      `${head} It finished${run.ended ? `: ${run.ended}` : ''}. Its files are in ${runDir(await rootDir($), name, run.id)}.`,
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
      `If the fix adds, removes or reorders steps, this run cannot go on with it: tell the user to start a new one with /flows run ${name}.`,
    ].join('\n')
  }
  return `${head} It was ${run.status}. Do nothing more for it; tell the user that /flows retry ${name} takes it up again.`
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

async function startRun($: EngineInterface, name: string, input: string): Promise<string> {
  const flow = (await read($, flows)).find(f => f.name === name)
  if (!flow) return `There is no flow named "${name}".`
  if (flow.error) return `"${name}" cannot run: ${flow.error}.`
  if (active((await read($, runs))[name])) return `"${name}" is already running. Stop the chat to stop it; /flows retry ${name} takes it up again.`
  const root = await rootDir($)
  const id = (await latestId($, root, name)) + 1
  const t = await $.clock.now()
  await registerTypes($, flow)
  await $.fs.write(`${runDir(root, name, id)}/out/input.txt`, input)
  void prune($, root, name, id).catch(() => undefined)
  const run = newRun({ ...flow, cwd: flow.cwd ?? (await projectDir($)) }, id, input, t, await read($, me), await weekUsed($))
  await update($, runs, all => ({ ...all, [name]: run }))
  await update($, view, () => ({ flow: name }))
  await saveRun($, name)
  await advance($, name)
  kick($, kickoff(name, id, false))
  return `Started "${name}" (run ${id}).`
}

async function stopAgent($: EngineInterface, agentId: string): Promise<void> {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId }).catch(() => undefined)
}

/**
 * Takes a run that stopped up again, at its failed steps. If the flow changed since and still has the same
 * steps, the run goes on with the flow as it is now. Answers why not, or null when it did.
 */
async function takeUp($: EngineInterface, name: string): Promise<string | null> {
  const flow = (await read($, flows)).find(f => f.name === name)
  const was = (await read($, runs))[name]
  if (!flow || !was) return `"${name}" has no run to take up. /flows run ${name} starts one.`
  if (was.status === 'done') return `"${name}" finished its last run. /flows run ${name} starts a new one.`
  const steps = !flow.error && sameShape(was.steps, flow.steps) ? flow.steps : was.steps
  const t = await $.clock.now()
  const mine = await read($, me)
  await registerTypes($, { ...flow, steps })
  await mutate($, name, r => {
    const now: Run = { ...r, steps, owner: mine, beat: t }
    return now.tracks.some(tr => tr.status === 'failed') ? retry(now, mine, t) : now
  })
  await update($, view, () => ({ flow: name }))
  await advance($, name)
  return null
}

async function retryRun($: EngineInterface, name: string): Promise<string> {
  const why = await takeUp($, name)
  if (why) return why
  const run = (await read($, runs))[name]
  kick($, kickoff(name, run?.id ?? 0, true))
  return `Taking up "${name}" (run ${run?.id ?? 0}).`
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
  if (!(await rootDir($))) return `${NO_FOLDER} Tell the user so.`
  if (!NAME.test(name) || VERBS.includes(name)) return `"${name}" is not a flow name: lower-case letters, digits and hyphens, and none of ${VERBS.join(', ')}. Ask the user for one.`
  const dir = flowDir(await rootDir($), name)
  const json = await $.fs.read(`${dir}/flow.json`).catch(() => null)
  const mode: Draft['mode'] = json === null ? 'new' : 'edit'
  const have = await read($, draft)
  const ask = have?.name === name ? have.ask : ''
  if (input.action === 'start') {
    await update($, draft, () => ({ name, mode, ask, flow: null, files: {} }))
    return guide(DRAFT, name, mode, ask, json === null ? null : { json, files: await scripts($, dir, json) })
  }
  if (input.action === 'propose') {
    const checked = check(name, input, Object.keys(await scripts($, dir, json)))
    if ('error' in checked) return `Not accepted: ${checked.error} Fix it and propose the whole flow again.`
    if (input.agreed === true) {
      // The person said yes to this very change (a fix after a failed run): no draft, no second question.
      await save($, dir, checked.flow, checked.files)
      return `Saved the change to "${name}". Tell the user in one line what changed.`
    }
    await update($, draft, () => ({ name, mode, ask, flow: checked.flow, files: checked.files }))
    await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
    return presented(DRAFT, checked.flow, checked.files)
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

// ——— The pane: what is happening, to look at; everything is done from the chat ———

type Ui = ReturnType<EngineInterface['ui']['resolve']>

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

function pane(ui: Ui, list: Flow[], all: Record<string, Run>, v: View, t: number, isDesktop: boolean, cols: number, weekLimit: number | null, old: Run | null, drafted: Draft | null) {
  const { Box, Text } = ui
  // A flow being written shows in place of the chosen one, until it is saved or dropped.
  const isDraft = Boolean(drafted?.flow)
  if (list.length === 0 && !isDraft) {
    return (
      <Box flexDirection="column">
        <Text bold>No flows yet</Text>
        <Text dimColor>This project has no flows yet. /flows new &lt;name&gt; &lt;what it should do&gt; writes one, in its Flows folder.</Text>
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
  const others = list.filter(f => f.name !== name)
  const foot = (
    <Box flexDirection="column">
      {others.length > 0 && <Text dimColor>{`Other flows: ${others.map(f => `${f.name}${active(all[f.name]) ? ` (${all[f.name]?.status})` : ''}`).join(', ')} · /flows <name>`}</Text>}
      {!isDraft && <Text dimColor>{`/flows run ${name} [input] · /flows retry ${name} · /flows ${name} <run> · /flows edit ${name} <what to change>`}</Text>}
    </Box>
  )

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
      limit: weekLimit,
      note: isDraft ? DRAFTED : flow.error ? `This flow cannot run: ${flow.error}` : (run?.ended ?? (run ? '' : `Not run yet. /flows run ${name} starts it.`)),
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
        <Svg key="head" source={head.source} alt={`${name}${run ? `: run ${run.id}, ${run.status}` : ''}`} width={w} height={head.height} />
        {pictures.map(p => (
          <Svg key={p.key} source={p.source} alt={p.alt} width={w} height={p.height} />
        ))}
        {foot}
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
        </Box>
      ) : (
        <Text color={isDraft ? 'warning' : 'inactive'}>{isDraft ? DRAFTED : `Not run yet. /flows run ${name} starts it.`}</Text>
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
      {foot}
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
    await $.command.register({ name: 'flows', description: 'Flows: open the pane, or write, change, run and take up a flow', argumentHint: '[list | new <name> <what> | edit <name> <what> | run <name> [input] | retry <name> | delete <name> | <name> [run]]' }).catch(() => undefined)
    await $.tool
      .register({
        name: 'next',
        description: [
          'Runs a saved flow of the Flows plugin, one step at a time. Call it when the user runs a flow (/flows run, /flows retry), and again after each thing it tells you to do, until it says the flow is over.',
          'It answers with exactly one thing to do: start the agents it names (with the Agent tool, in the foreground, with the subagent_type and description it gives; Flows fills in each agent\'s real task), or put an approval to the user, or report the end.',
          'Follow its answer to the letter. Never do a step\'s work yourself, never answer an approval for the user, never read or change the run\'s files, and keep your own messages to one short line per step.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            flow: { type: 'string', description: "The flow's name." },
            answer: { type: 'string', enum: ['approve', 'reject', 'back'], description: "The user's answer to the approval the flow waits on. Only what the user said." },
            note: { type: 'string', description: 'With answer "back": what the user wants changed.' },
            retry: { type: 'boolean', description: 'True to take up a run that failed or was stopped, at its failed step.' },
          },
          required: ['flow'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    const week = await weekUsed($)
    await update($, limit, () => week)
    await $.tool
      .register({
        name: 'draft',
        description: 'Writes or changes a saved flow of the Flows plugin, with the user. Call it with {"flow": name, "action": "start"} when the user wants a new flow (/flows new) or a change to one (/flows edit, or a fix after a failed run): it answers how to interview them and what a flow is made of. Then "propose" sends the whole flow to be checked and shown in the pane as a draft, and "save" writes it once the user agreed; "discard" drops the draft. Never save without the user saying so.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: { type: 'string', description: "The flow's name: lower-case letters, digits and hyphens." },
            action: { type: 'string', enum: ['start', 'propose', 'save', 'discard'] },
            description: { type: 'string', description: 'With "propose": what the flow does, in a line or two.' },
            cwd: { type: 'string', description: 'With "propose", optional: a folder on this computer the agents may also write in.' },
            steps: { type: 'array', items: { type: 'object' }, description: 'With "propose": the steps, in order, as the answer to "start" describes them.' },
            files: { type: 'object', additionalProperties: { type: 'string' }, description: 'With "propose": the code of each code step, by its path in the flow\'s folder.' },
            agreed: { type: 'boolean', description: 'With "propose", true only when the user has already said yes to exactly this change (a fix they approved after a failed run): the flow is then saved at once, with no draft and no second question.' },
          },
          required: ['flow', 'action'],
        },
        isDeferred: false,
      })
      .catch(() => undefined)
    await loadFlows($).catch(() => undefined)
    $.clock.every(TICK, () => void tick($).catch(() => undefined))
    return next(e)
  })

  // The weekly limit moves: the pane's bar follows it.
  on('session.measure', async ($, e, next) => {
    const week = e.changed.includes('rateLimits') ? e.rateLimits.find(l => l.kind === 'seven_day')?.percentUsed : undefined
    if (week !== undefined) await update($, limit, () => week)
    return next(e)
  })

  on('command.run', { command: 'flows' }, async ($, e) => {
    const [verb = '', name = '', ...rest] = e.args.trim().split(/\s+/)
    if (!verb) return { text: await togglePane($) }
    if (!(await rootDir($))) return { text: NO_FOLDER }
    await loadFlows($)
    if (verb === 'list') {
      const list = await read($, flows)
      const all = await read($, runs)
      if (list.length === 0) return { text: `This project has no flows yet. /flows new <name> <what it should do> writes one, in ${await rootDir($)}.` }
      // One line a flow: what it does, how long it is, and how its last run went.
      const lines = list.map(f => {
        const run = all[f.name]
        const last = f.error ? `cannot run: ${f.error}` : run ? `run ${run.id} ${run.status}` : 'not run yet'
        return `${f.name}: ${f.description || '(no description)'} (${f.steps.length} step${f.steps.length === 1 ? '' : 's'} · ${last})`
      })
      return { text: [`${list.length} flow${list.length === 1 ? '' : 's'} in ${await rootDir($)}:`, ...lines].join('\n') }
    }
    if (verb === 'delete') {
      const flow = (await read($, flows)).find(f => f.name === name)
      if (!flow) return { text: name ? `There is no flow named "${name}".` : 'Usage: /flows delete <name>' }
      if (active((await read($, runs))[name])) return { text: `"${name}" is running. Stop the chat first, then delete it.` }
      const dir = flowDir(await rootDir($), name)
      const kept = (await $.fs.list(`${dir}/runs`).catch(() => [])).filter(d => d.kind === 'dir').length
      // Nothing brings a deleted flow back, so the command is typed twice: once to see what goes, once with "yes".
      if (rest[0] !== 'yes') return { text: `This deletes the flow "${name}" for good: its ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}, its scripts and its ${kept} run${kept === 1 ? '' : 's'}, in ${dir}. To go ahead: /flows delete ${name} yes` }
      const gone = await $.process.run(['node', '-e', 'require("fs").rmSync(process.argv[1],{recursive:true,force:true})', dir]).catch(() => null)
      await loadFlows($)
      const left = (await read($, flows)).some(f => f.name === name)
      return { text: left || gone?.exitCode !== 0 ? `"${name}" could not be deleted. Its folder is ${dir}.` : `Deleted "${name}".` }
    }
    if ((verb === 'run' || verb === 'retry') && name) {
      await $.ui.open({ id: PANE, title: 'Flows' }).catch(() => undefined)
      return { text: verb === 'run' ? await startRun($, name, rest.join(' ')) : await retryRun($, name) }
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
      const id = Number(name)
      const root = await rootDir($)
      const text = Number.isInteger(id) && id > 0 ? await $.fs.read(`${runDir(root, verb, id)}/run.json`).catch(() => null) : null
      if (text === null) {
        const ids = (await $.fs.list(`${flowDir(root, verb)}/runs`).catch(() => [])).filter(d => d.kind === 'dir' && /^\d+$/.test(d.name)).map(d => Number(d.name)).sort((x, y) => x - y)
        return { text: ids.length ? `"${verb}" has no run ${name}. Its runs: ${ids.join(', ')}.` : `"${verb}" has not run yet.` }
      }
      const run = JSON.parse(text) as Run
      await update($, past, () => run)
      await update($, view, () => ({ flow: verb, run: id }))
      return { text: `Showing run ${id} of "${verb}". /flows ${verb} goes back to the newest.` }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => pane($.ui.resolve(e), await read($, flows), await read($, runs), await read($, view), await read($, now), e.surface === 'desktop', e.props.bodyColumns ?? 0, await read($, limit), await read($, past), await read($, draft)))
  // A button above the prompt opens and closes the pane, like /flows. It is drawn above whatever band the
  // plugins beneath draw (another mod's bar stays under it, whole), and yields to a survey.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e).catch(() => null)
    if (e.props.hasSurvey) return below
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


  // The session's Claude asks what to do next, and brings the person's answer to an approval.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as { flow?: unknown; answer?: unknown; note?: unknown; retry?: unknown }
    const name = typeof input.flow === 'string' ? input.flow : ''
    if (mainTurn) turnOf.set(name, mainTurn)
    if (input.retry === true) {
      await loadFlows($)
      const why = await takeUp($, name)
      if (why) return { result: why }
    }
    const run = (await read($, runs))[name]
    const ask = run ? waiting(run)[0] : undefined
    if (run && ask && (input.answer === 'approve' || input.answer === 'reject' || input.answer === 'back')) await decide($, name, ask[0], ask[1], input.answer, typeof input.note === 'string' ? input.note : '')
    await inflight
    await advance($, name)
    return { result: await directive($, name) }
  }).catch(() => ({ result: `Flows could not work out the next step. Tell the user, and do nothing more for this flow.` }))

  // The session's Claude writes or changes a flow with the person.
  on('tool.call', { tool: DRAFT }, async ($, e) => ({ result: await authoring($, e as Proposal & { flow?: unknown; action?: unknown; agreed?: unknown }) })).catch(() => ({ result: 'Flows could not handle the draft. Tell the user, and do nothing more with it.' }))

  // The session's Claude starts a step's agent: the step's real task and folder go in here, so what one
  // step hands the next never passes through the chat. An agent that is no step waiting to start is refused.
  on('agent.spawn', async ($, e, next) => {
    if (!e.subagentType?.startsWith('flows:')) return next(e)
    const m = LAUNCH.exec(e.description ?? '')
    const name = m?.[1] ?? ''
    const [track, step] = [Number(m?.[3]), Number(m?.[4])]
    const run = (await read($, runs))[name]
    const s = run?.tracks[track]?.steps[step]
    if (!m || !run || run.id !== Number(m[2]) || !toLaunch(run).some(([t, i]) => t === track && i === step) || s?.startedAt === undefined) return { deny: `Flows: this is not a step waiting to start. Call ${TOOL} and use the subagent_type and description it gives.` }
    const token = s.startedAt
    const dir = runDir(await rootDir($), name, run.id)
    const prompt = await agentPrompt($, run, track, step, dir, token)
    const spawn = (async () => {
      const started = await next({ ...e, prompt, cwd: run.cwd ?? dir, background: false })
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
    if (e.agentId && known.has(e.agentId)) {
      const u = e.usage
      const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      if (detached.has(e.agentId) || e.reason !== 'answer') await agentDone($, e.agentId, e.answer, e.reason, tokens).catch(() => undefined)
      else ended.set(e.agentId, { answer: e.answer, reason: e.reason, tokens })
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
        const dir = runDir(await rootDir($), name, run.id)
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
