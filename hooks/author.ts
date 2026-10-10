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
    'A list of steps, run top to bottom. Each step receives as text what the step before handed on (the first one receives the input the user gives when running the flow), and all steps share the run\'s folder for files.',
    'Every step has: id (lower-case letters, digits and hyphens, unique), type, name (short), description (one line, shown in the pane).',
    '- type "agent": an AI worker. Also: role (one of ' + ROLES.join(', ') + '; it picks the worker\'s costume), model ("haiku" for simple work such as extracting or classifying, "sonnet" by default, "opus" for hard work such as writing code or long reasoning), effort ("low", "medium" or "high"), minutes (its time limit, 30 by default), instruction, and optionally tools.',
    '  The instruction is all the agent knows besides its input: say what the input is, what to do, and the exact form of the result, because a program reads it (JSON when a script or an "each" step comes next). Do not tell it where to write its result or how to end: Flows does.',
    '  An agent can read files anywhere, search the web, and write inside the run\'s folder and the flow\'s cwd. Anything else it needs goes in tools, by name ("Bash", or an MCP tool\'s full name); give only what the step needs.',
    '- type "code": a Node.js script, for work that needs no judgement (parsing, filtering, formatting, counting, calling an API). Also: file (for example "steps/2-filter.js") and seconds (its limit, 60 by default, at most 600). The script reads one JSON object from stdin, { input, flow, run, track, runDir, cwd }, and what it prints to stdout is handed on. Exit code 3 ends the flow there, stdout being the reason; any other non-zero code fails the step, stderr being the error. Use only what Node has built in. Prefer a script to an agent wherever the work is mechanical.',
    '- type "approval": stops until the user answers in the chat: approve, reject, or send back to the agent before it with a note. Put one before anything that sends, publishes, deletes or spends.',
    '- type "each": splits what it receives (a JSON list, or one item per line) and runs every step after it once per item. Also: parallel (items at once, 3 by default, at most 10). At most one per flow, and never the last step. The step before it must hand on the list.',
    'The flow itself has a description (one or two lines) and, optionally, cwd: a folder on this computer the agents may also write in (a project, say).',
    'Keep the flow as small as does the job.',
    '',
    '3. PROPOSE',
    `Call ${tool} with {"flow":"${name}","action":"propose","description":"...","steps":[...],"files":{"steps/2-filter.js":"<the code>"}} (and "cwd" if it has one). Give every code step's file in "files"${mode === 'edit' ? ', or leave out a file you are not changing' : ''}. The tool checks the flow and shows it in the pane as a draft; fix what it reports and propose again. Nothing is saved until the user says so.`,
  ]
  if (current) {
    lines.push('', 'THE FLOW AS IT IS NOW', 'flow.json:', current.json)
    for (const [path, text] of Object.entries(current.files)) lines.push('', `${path}:`, text)
    lines.push('', 'Change only what the request needs, and propose the whole flow again.')
  }
  return lines.join('\n')
}

/** What the tool answers to a proposal that passed: show it, say what was assumed, and ask before saving. */
export function presented(tool: string, flow: Flow, files: Record<string, string>): string {
  const code = Object.keys(files)
  return [
    `The draft of "${flow.name}" is in the Flows pane (${flow.steps.length} steps). It is not saved.`,
    'Now tell the user, briefly: each step in one line; what you assumed without asking; what you left out.',
    ...(code.length ? [`Show the code of ${code.length === 1 ? `the script ${code[0]}` : 'each script'} in a code block, since it will run on their computer.`] : []),
    `Then ask them what to do: with the AskUserQuestion tool if you have it (options "Save", "Change something", "Discard"), otherwise with a plain question, ending your turn until they answer. Never answer for them.`,
    `On Save, call ${tool} with {"flow":"${flow.name}","action":"save"}. To change something, ask what, then propose the whole flow again. On Discard, call it with "action":"discard".`,
  ].join('\n')
}

export type Proposal = { description?: unknown; cwd?: unknown; steps?: unknown; files?: unknown }

/**
 * A proposal checked: the flow and its script files, or what is wrong with it, in words for the one who wrote it.
 * `onDisk` are the script files the flow already has (an edit may leave those out).
 */
export function check(name: string, p: Proposal, onDisk: readonly string[]): { flow: Flow; files: Record<string, string> } | { error: string } {
  if (!NAME.test(name)) return { error: `"${name}" is not a flow name: lower-case letters, digits and hyphens, starting with a letter or digit.` }
  if (typeof p.description !== 'string' || !p.description.trim()) return { error: 'The flow has no description: say in a line or two what it does.' }
  const flow = parseFlow(name, JSON.stringify({ description: p.description.trim(), ...(typeof p.cwd === 'string' && p.cwd.trim() ? { cwd: p.cwd.trim() } : {}), steps: p.steps }))
  if (flow.error) return { error: `${flow.error.replace('flow.json', 'The flow')}.` }
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
  }
  const unused = Object.keys(files).find(path => !flow.steps.some(s => s.type === 'code' && s.file === path))
  if (unused) return { error: `The file ${unused} is used by no code step.` }
  return { flow, files }
}

/** A flow as its flow.json is written. */
export const flowJson = (flow: Flow): string => `${JSON.stringify({ description: flow.description, ...(flow.cwd ? { cwd: flow.cwd } : {}), steps: flow.steps }, null, 2)}\n`

/** Whether a run that started on `before` can go on with `after`: the same steps, in the same order, of the same types. */
export const sameShape = (before: Flow['steps'], after: Flow['steps']): boolean => before.length === after.length && before.every((s, i) => s.id === after[i]?.id && s.type === after[i]?.type)
