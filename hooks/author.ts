// Writing a flow with the session's Claude: what it is told (how to interview the person, what a flow is
// made of) and the check of what it proposes. No engine in here; register.tsx serves the tool.

import type { Flow } from '../types'
import { NAME, parseFlow } from './flow'

export const ROLES = ['researcher', 'writer', 'builder', 'designer', 'coder', 'reviewer', 'analyst', 'messenger']

/** What the tool answers to "start": the interview, the parts of a flow, and how to propose one. */
export function guide(tool: string, name: string, mode: 'new' | 'edit', ask: string, current: { json: string; files: Record<string, string> } | null): string {
  const lines = [
    mode === 'new' ? `You are writing a new saved flow for the Flows plugin, called "${name}".` : `You are changing the saved flow "${name}" of the Flows plugin.`,
    `What the user asked: ${ask.trim() || (mode === 'new' ? '(nothing yet: ask them what the flow should do)' : '(nothing yet: ask them what to change)')}`,
    '',
    '1. INTERVIEW',
    'Ask the user what you need until you are at least 90% sure of what they want. Work in rounds: in each round ask every question you can ask now, numbered, each with the answer you recommend; wait for their answers; then ask the next round, which their answers opened. Find facts yourself (files, tools, connectors) instead of asking for them. Do not ask what you can decide sensibly: decide, and say at the end what you assumed.',
    'What usually needs settling: what goes in when the flow runs (its input), what must come out and where it is kept, each step and whether an agent or a script does it, where the user must approve, which folder it works in, which tools or connectors an agent needs.',
    mode === 'edit' ? 'For a small, clear change, skip the interview.' : 'If the request is already clear, skip the interview.',
    '',
    '2. WHAT A FLOW IS',
    'A list of steps, run top to bottom. Each step receives as text what the step before handed on (the first one receives the input the user gives when running the flow), and all steps share the run\'s folder for files. Every step also sees the run\'s own input, the values of the flow\'s inputs, the results of every step before it and the flow\'s memory: never make a step copy a value along just so a later one has it.',
    'Every step has: id (lower-case letters, digits and hyphens, unique), type, name (short), description (one line, shown in the pane).',
    '- type "agent": an AI worker. Also: role (one of ' + ROLES.join(', ') + '; it picks the worker\'s costume), model ("haiku" for simple work such as extracting or classifying, "sonnet" by default, "opus" for hard work such as writing code or long reasoning), effort ("low", "medium" or "high"), minutes (its time limit, 30 by default), instruction, and optionally tools.',
    '  The instruction is all the agent knows besides its input: say what the input is, what to do, and the exact form of the result, because a program reads it (JSON when a script or an "each" step comes next). Do not tell it where to write its result or how to end: Flows does.',
    '  When a program reads its result, give it a schema too: a JSON Schema of the result (type, properties, required, items, enum, minItems, maxItems, minLength, minimum, maximum). A result that does not fit is sent back to the agent with what is wrong, up to retries times (2 by default), before the step fails. Optionally maxTokens: the most tokens it may use.',
    '  An agent works in the project (the session\'s folder): it can read files anywhere, search the web, and write inside the project and the run\'s folder. Anything else it needs goes in tools, by name ("Bash", or an MCP tool\'s full name); give only what the step needs.',
    '- type "code": a Node.js script, for work that needs no judgement (parsing, filtering, formatting, counting, calling an API). Also: file (for example "steps/2-filter.js") and seconds (its limit, 60 by default, at most 600). The script reads one JSON object from stdin: { input (what the step before handed on), runInput (the run\'s own input), vars (the flow\'s inputs), outputs (each earlier step\'s result, by step id), memory (the flow\'s memory, as text), item (this item, after an "each"), flow, run, track, runDir, cwd, dry (true in a test run: do nothing that cannot be undone) }, and what it prints to stdout is handed on. Exit code 3 ends the flow there, stdout being the reason; any other non-zero code fails the step, stderr being the error. Use only what Node has built in. Prefer a script to an agent wherever the work is mechanical. A schema checks its output too.',
    '- type "approval": stops until the user answers in the chat: approve, approve with changes, reject, or send back to the agent before it with a note. Put one before anything that sends, publishes, deletes or spends. Optionally show: what the user reads, with {{field}} (or {{a.b}}) taken from the JSON it receives, for example "{{name}}: {{url}}"; without it they read what it receives, as it is.',
    '- type "each": splits what it receives (a JSON list, or one item per line) and runs every step after it once per item, each item on its own as far as it goes. Also: parallel (items at once, 3 by default, at most 10) and max (the most items it takes; more are cut, and the run says so). At most one per flow, and never the last step. The step before it must hand on the list.',
    'Any agent or code step may have remember: true: its result is added to the flow\'s memory, which every later run reads (for example the leads already contacted, so they are not found again).',
    'The flow itself has a description (one or two lines). Optionally: inputs, what it asks for when it runs, as a list of { id, description, type ("string", "number", "boolean" or "list"), required, default } (the run\'s input is then these values as a JSON object); maxTokens, the most tokens a run may use; cwd, another folder on this computer for its agents to work in, in place of the session\'s.',
    'The flow is saved once for every session, in ~/.claude/flows/<name>/; each run\'s files go to the folder of the session that runs it, in Flows/<name>/runs/<n>/, and its agents work in that folder.',
    'Keep the flow as small as does the job.',
    '',
    '3. PROPOSE',
    `Call ${tool} with {"flow":"${name}","action":"propose","description":"...","steps":[...],"files":{"steps/2-filter.js":"<the code>"}} (and "inputs", "maxTokens" or "cwd" if it has them). Give every code step's file in "files"${mode === 'edit' ? ', or leave out a file you are not changing' : ''}. The tool checks the flow and shows it in the pane as a draft; fix what it reports and propose again. Nothing is saved until the user says so.`,
    `To change only some steps of the flow (or of the draft), send "patch" in place of "steps": {"flow":"${name}","action":"propose","patch":[{"id":"write","model":"opus"}],"remove":["old-step"]}. Each entry changes the fields it names in the step of that id, or adds a new step (at the end, or after the step "after" names). The description, inputs, maxTokens and cwd you leave out stay as they are. The answer says what changed.`,
  ]
  if (current) {
    lines.push('', 'THE FLOW AS IT IS NOW', 'flow.json:', current.json)
    for (const [path, text] of Object.entries(current.files)) lines.push('', `${path}:`, text)
    lines.push('', 'Change only what the request needs: with "patch" for a few steps, or the whole flow again.')
  }
  return lines.join('\n')
}

/** What the tool answers to a proposal that passed: show it, say what was assumed, and ask before saving. */
export function presented(tool: string, flow: Flow, files: Record<string, string>, changes: readonly string[] = []): string {
  const code = Object.keys(files)
  return [
    `The draft of "${flow.name}" is in the Flows pane (${flow.steps.length} steps). It is not saved.`,
    ...(changes.length ? ['What changed from the flow as it was:', ...changes.map(c => `- ${c}`), 'Tell the user these changes.'] : []),
    'Now tell the user, briefly: each step in one line; what you assumed without asking; what you left out.',
    ...(code.length ? [`Show the code of ${code.length === 1 ? `the script ${code[0]}` : 'each script'} in a code block, since it will run on their computer.`] : []),
    `Then ask them what to do: with the AskUserQuestion tool if you have it (options "Save", "Change something", "Discard"), otherwise with a plain question, ending your turn until they answer. Never answer for them.`,
    `On Save, call ${tool} with {"flow":"${flow.name}","action":"save"}. To change something, ask what, then propose the whole flow again. On Discard, call it with "action":"discard".`,
  ].join('\n')
}

export type Proposal = { description?: unknown; cwd?: unknown; inputs?: unknown; maxTokens?: unknown; steps?: unknown; files?: unknown; patch?: unknown; remove?: unknown }

/**
 * A proposal that changes only some steps (`patch`, `remove`) made whole from `base`: the flow as it is,
 * or its draft. A proposal with its own steps is whole already.
 */
export function whole(p: Proposal, base: Flow | null): Proposal | { error: string } {
  if (p.steps !== undefined || (p.patch === undefined && p.remove === undefined)) return p
  if (!base) return { error: 'There is no flow yet to patch: propose it whole, with "steps".' }
  if (p.patch !== undefined && !Array.isArray(p.patch)) return { error: '"patch" must be a list of steps, each with its "id".' }
  if (p.remove !== undefined && (!Array.isArray(p.remove) || p.remove.some(x => typeof x !== 'string'))) return { error: '"remove" must be a list of step ids.' }
  let steps: Record<string, unknown>[] = base.steps.map(s => ({ ...s }))
  for (const id of (p.remove ?? []) as string[]) {
    if (!steps.some(s => s.id === id)) return { error: `There is no step "${id}" to remove.` }
    steps = steps.filter(s => s.id !== id)
  }
  for (const raw of (p.patch ?? []) as unknown[]) {
    const change = raw as Record<string, unknown> | null
    if (!change || typeof change !== 'object' || typeof change.id !== 'string') return { error: 'Each entry of "patch" needs the "id" of the step it changes or adds.' }
    const { after, ...fields } = change
    const at = steps.findIndex(s => s.id === fields.id)
    if (at >= 0) steps[at] = { ...steps[at], ...fields }
    else {
      const where = typeof after === 'string' ? steps.findIndex(s => s.id === after) : -1
      if (typeof after === 'string' && where < 0) return { error: `There is no step "${after}" to add "${String(fields.id)}" after.` }
      steps.splice(where >= 0 ? where + 1 : steps.length, 0, fields)
    }
  }
  return { description: p.description ?? base.description, cwd: p.cwd ?? base.cwd, inputs: p.inputs ?? base.inputs, maxTokens: p.maxTokens ?? base.maxTokens, files: p.files, steps }
}

/** What changed from `before` to `after`, one line each: steps added, removed, moved or changed, and the flow's own fields. */
export function changes(before: Flow | null, after: Flow): string[] {
  if (!before) return []
  const out: string[] = []
  const brief = (v: unknown): string => {
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    return text === undefined ? '(none)' : text.length > 60 ? `${text.slice(0, 59)}…` : text
  }
  for (const key of ['description', 'cwd', 'inputs', 'maxTokens'] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out.push(`the flow's ${key}: ${brief(before[key])} → ${brief(after[key])}`)
  }
  for (const s of before.steps) if (!after.steps.some(x => x.id === s.id)) out.push(`removed step "${s.id}" (${s.name})`)
  after.steps.forEach((s, i) => {
    const was = before.steps.find(x => x.id === s.id)
    if (!was) return void out.push(`added step ${i + 1} "${s.id}" (${s.type}, ${s.name})`)
    if (before.steps.indexOf(was) !== i) out.push(`moved "${s.id}" from step ${before.steps.indexOf(was) + 1} to ${i + 1}`)
    const keys = new Set([...Object.keys(was), ...Object.keys(s)])
    const fields = [...keys].filter(k => JSON.stringify((was as Record<string, unknown>)[k]) !== JSON.stringify((s as Record<string, unknown>)[k]))
    if (fields.length) out.push(`changed "${s.id}": ${fields.map(k => (k === 'instruction' ? 'instruction' : `${k} ${brief((was as Record<string, unknown>)[k])} → ${brief((s as Record<string, unknown>)[k])}`)).join('; ')}`)
  })
  return out
}

/**
 * A proposal checked: the flow and its script files, or what is wrong with it, in words for the one who wrote it.
 * `onDisk` are the script files the flow already has (an edit may leave those out).
 */
export function check(name: string, p: Proposal, onDisk: readonly string[]): { flow: Flow; files: Record<string, string> } | { error: string } {
  if (!NAME.test(name)) return { error: `"${name}" is not a flow name: lower-case letters, digits and hyphens, starting with a letter or digit.` }
  if (typeof p.description !== 'string' || !p.description.trim()) return { error: 'The flow has no description: say in a line or two what it does.' }
  if (p.maxTokens !== undefined && (typeof p.maxTokens !== 'number' || p.maxTokens <= 0)) return { error: '"maxTokens" must be a number of tokens.' }
  const flow = parseFlow(name, JSON.stringify({ description: p.description.trim(), ...(typeof p.cwd === 'string' && p.cwd.trim() ? { cwd: p.cwd.trim() } : {}), inputs: p.inputs, maxTokens: p.maxTokens, steps: p.steps }))
  if (flow.error) return { error: `${flow.error.replace('flow.json', 'The flow')}.` }
  for (const d of flow.inputs ?? []) {
    if (d.type !== undefined && !['string', 'number', 'boolean', 'list'].includes(d.type)) return { error: `The input "${d.id}" has the type "${String(d.type)}", which is none of string, number, boolean, list.` }
  }
  const files: Record<string, string> = {}
  if (p.files !== undefined && (typeof p.files !== 'object' || p.files === null || Array.isArray(p.files))) return { error: '"files" must be an object: each script\'s path and its code.' }
  for (const [path, text] of Object.entries((p.files ?? {}) as Record<string, unknown>)) {
    if (typeof text !== 'string' || !text.trim()) return { error: `The file ${path} has no code.` }
    if (!/^[\w.-]+(\/[\w.-]+)*\.(js|mjs|cjs)$/.test(path) || path.split('/').includes('..') || path.startsWith('runs/')) return { error: `"${path}" is not a script path inside the flow's folder: use something like steps/2-filter.js.` }
    files[path] = text
  }
  for (const [i, s] of flow.steps.entries()) {
    const at = `Step ${i + 1} ("${s.name}")`
    if (!s.description?.trim()) return { error: `${at} has no description: one line saying what it does, for the pane.` }
    if (s.type === 'agent' && s.role !== undefined && !ROLES.includes(s.role)) return { error: `${at} has the role "${s.role}", which is none of: ${ROLES.join(', ')}.` }
    if (s.type === 'agent' && s.tools !== undefined && (!Array.isArray(s.tools) || s.tools.some(t => typeof t !== 'string'))) return { error: `${at}: "tools" must be a list of tool names.` }
    if (s.type === 'code' && s.file && !(s.file in files) && !onDisk.includes(s.file)) return { error: `${at} runs ${s.file}, which is not in "files".` }
    if (s.type === 'each' && i === 0) return { error: `${at} is an "each" with no step before it to hand it the list.` }
    if (s.schema !== undefined && (typeof s.schema !== 'object' || s.schema === null || Array.isArray(s.schema))) return { error: `${at}: "schema" must be a JSON Schema object, such as {"type":"array","items":{"type":"string"}}.` }
    for (const key of ['retries', 'maxTokens', 'max'] as const) if (s[key] !== undefined && (typeof s[key] !== 'number' || (s[key] as number) < 0)) return { error: `${at}: "${key}" must be a number.` }
    if (s.show !== undefined && typeof s.show !== 'string') return { error: `${at}: "show" must be a text with {{field}} in it.` }
  }
  const unused = Object.keys(files).find(path => !flow.steps.some(s => s.type === 'code' && s.file === path))
  if (unused) return { error: `The file ${unused} is used by no code step.` }
  return { flow, files }
}

/** A flow as its flow.json is written. */
export const flowJson = (flow: Flow): string =>
  `${JSON.stringify({ description: flow.description, ...(flow.cwd ? { cwd: flow.cwd } : {}), ...(flow.inputs ? { inputs: flow.inputs } : {}), ...(flow.maxTokens ? { maxTokens: flow.maxTokens } : {}), steps: flow.steps }, null, 2)}\n`

/** Whether a run that started on `before` can go on with `after`: the same steps, in the same order, of the same types. */
export const sameShape = (before: Flow['steps'], after: Flow['steps']): boolean => before.length === after.length && before.every((s, i) => s.id === after[i]?.id && s.type === after[i]?.type)
