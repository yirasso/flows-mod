import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Run } from '../types'

const ROOT = 'C:/P/Flows'
/** The flows are kept in ~/.claude/flows; a run's files go to the session's folder (C:\P). */
const HOME = 'C:/H/.claude/flows'
const slash = (path: string): string => path.replace(/\\/g, '/')

const LEADS = {
  description: 'Finds leads and writes to each',
  inputs: [
    { id: 'niche', type: 'string', required: true },
    { id: 'count', type: 'number', default: 2 },
  ],
  steps: [
    { id: 'find', type: 'agent', name: 'Find', model: 'haiku', instruction: 'Find businesses.', schema: { type: 'array', items: { type: 'string' }, minItems: 1 }, remember: true },
    { id: 'pick', type: 'code', name: 'Pick', file: 'steps/pick.js' },
    { id: 'each', type: 'each', name: 'Each lead', max: 2 },
    { id: 'write', type: 'agent', name: 'Write', model: 'haiku', instruction: 'Write to the lead.' },
    { id: 'ok', type: 'approval', name: 'Check', show: 'Lead: {{name}}' },
  ],
}

type Spawned = { id: string; prompt: string; description: string }

/**
 * The engine (files in memory, agents that start in the background and end when the test says) and the
 * session's Claude (it calls the tools and starts the agents the answers name).
 */
function harness($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], files: Map<string, string>) {
  const spawned: Spawned[] = []
  const ran: { stdin: string }[] = []
  on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
  on('env.get', async (_$: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:\\H' : undefined }) as never)
  const time = mock.clock(on)
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = files.get(slash(e.path))
    if (text === undefined) throw new Error('no such file')
    return { value: text }
  })
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => (files.set(slash(e.path), e.text), { value: undefined }))
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: [...files.keys()].some(p => p === slash(e.path) || p.startsWith(`${slash(e.path)}/`)) }) as never)
  on('fs.list', async (_$: unknown, e: { path?: string }) => {
    const dir = slash(e.path ?? '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(`${dir}/`)) continue
      const [head = '', ...rest] = path.slice(`${dir}/`.length).split('/')
      names.set(head, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('agent.register', async () => ({ value: undefined }) as never)
  on('agent.spawn', async (_$: unknown, e: { prompt: string; description?: string }) => {
    spawned.push({ id: `a${spawned.length}`, prompt: e.prompt, description: e.description ?? '' })
    return { model: 'haiku', agentId: `a${spawned.length - 1}` }
  })
  on('agent.list', async () => ({ value: [] }) as never)
  // A code step's script prints the leads it is handed, as objects; the delete's rm takes the folder from the files.
  on('process.run', async (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    if (e.argv[1] === '-e') {
      const dir = slash(e.argv[e.argv.length - 1] ?? '')
      for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`)) files.delete(path)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    ran.push({ stdin: e.init?.stdin ?? '' })
    return { value: { exitCode: 0, stdout: JSON.stringify(['A', 'B', 'C'].map(name => ({ name }))), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }) as never)
  on('turn.complete', async (_$: unknown, e: { answer: string }) => ({ text: e.answer }) as never)
  on('tool.call', { tool: 'TaskStop' }, async () => ({ result: 'stopped' }) as never)
  // Started in the background: the call returns at once, and the agent's turn ends later.
  on('tool.call', { tool: 'Agent' }, async (_$: unknown, e: { subagent_type?: string; description?: string; prompt?: string }) => {
    const started = (await $.agent.spawn({ subagentType: e.subagent_type, description: e.description, prompt: e.prompt } as never)) as { deny?: string }
    return (started.deny !== undefined ? { deny: started.deny } : { result: { agentId: `a${spawned.length - 1}` } }) as never
  })

  const manage = async (args: Record<string, unknown>): Promise<string> => String((await $.tool.call({ tool: 'mcp__flows__manage', ...args } as never)).result)
  const next = async (flow: string, more: Record<string, unknown> = {}): Promise<string> => String((await $.tool.call({ tool: 'mcp__flows__next', flow, ...more } as never)).result)
  /** Starts every agent an answer names; each writes the next of `texts` as its result and ends. */
  const start = async (told: string, ...texts: string[]): Promise<Spawned[]> => {
    const now: Spawned[] = []
    for (const m of told.matchAll(/subagent_type: "([^"]+)" · description: "([^"]+)" · prompt: "([^"]+)"/g)) {
      await $.tool.call({ tool: 'Agent', subagent_type: m[1], description: m[2], prompt: m[3] } as never)
      const agent = spawned[spawned.length - 1]
      if (agent) now.push(agent)
    }
    for (const agent of now) {
      // One that cannot do it writes no file and says why.
      const text = texts.shift() ?? ''
      const file = /Result file[^:]*: (\S+)/.exec(agent.prompt)?.[1]
      const failed = text.startsWith('FLOW-ERROR:')
      if (file && !failed) files.set(slash(file), text)
      await $.turn.complete({ agentId: agent.id, answer: failed ? text : 'DONE', reason: 'answer', durationMs: 1, isAborted: false, turnId: agent.id, usage: { model: 'haiku', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)
    }
    return now
  }
  const run = (flow: string, id = 1): Run => JSON.parse(files.get(`${ROOT}/${flow}/runs/${id}/run.json`) ?? '{}') as Run
  return { spawned, ran, time, manage, next, start, run }
}

test("a run's steps see its inputs and the results before them, results are checked, and the memory is kept", async ($, on) => {
  const files = new Map<string, string>([[`${HOME}/leads/flow.json`, JSON.stringify(LEADS)]])
  const h = harness($, on, files)

  // The inputs are typed: one is needed, the other has a default.
  expect(await h.manage({ action: 'run', flow: 'leads' })).toContain('"niche" is needed')
  let told = await h.manage({ action: 'run', flow: 'leads', inputs: { niche: 'bakeries' } })
  expect(JSON.parse(files.get(`${ROOT}/leads/runs/1/out/input.txt`) ?? '{}')).toEqual({ niche: 'bakeries', count: 2 })
  expect(told).toContain('description: "leads #1 · step 1: Find"')

  // A result of the wrong shape goes back to its agent, with what is wrong.
  let agents = await h.start(told, 'here are some businesses')
  expect(agents[0]?.prompt).toContain('must be JSON of this shape')
  told = await h.next('leads')
  agents = await h.start(told, '["A"]')
  expect(agents[0]?.prompt).toContain('does not have the shape it must have')
  expect(h.run('leads').tracks[0]?.steps[0]?.tries).toBe(1)

  // Its result went into the flow's memory, and the script sees the run, every result before it and the memory.
  expect(files.get(`${HOME}/leads/memory.md`)).toContain('["A"]')
  const stdin = JSON.parse(h.ran[0]?.stdin ?? '{}') as { runInput: string; vars: { count: number }; outputs: Record<string, string>; memory: string }
  expect(stdin.runInput).toContain('bakeries')
  expect(stdin.vars.count).toBe(2)
  expect(stdin.outputs.find).toBe('["A"]')
  expect(stdin.memory).toContain('["A"]')

  // Three leads for an "each" that takes two: two are kept, and the run says so.
  told = await h.next('leads')
  expect(h.run('leads').warnings?.[0]).toContain('handed 3 items and takes at most 2')
  // An item that is a JSON object is called by its name.
  expect(told).toContain('description: "leads #1 · A (1/2) · step 4: Write"')
  agents = await h.start(told, '{"name":"A","site":"a.html"}', '{"name":"B","site":"b.html"}')
  expect(agents[0]?.prompt).toContain("The flow's inputs for this run")
  expect(agents[0]?.prompt).toContain('C:/P/Flows/leads/runs/1/out/0-0.txt')
  expect(agents[0]?.prompt).toContain("The flow's memory")

  // The approval shows what the flow says, where it is, and offers to approve every item at once.
  told = await h.next('leads')
  expect(told).toContain('Lead: A')
  expect(told).toContain('for item 1 of 2')
  expect(told).toContain('"Approve all 2"')
  told = await h.next('leads', { approval: '1.4', answer: 'approve_all' })
  expect(h.run('leads').status).toBe('done')
  expect(told).toContain('takes at most 2')
})

test('a test run starts no agent; a run can start at a step, be approved as changed, make way for a new one, and redo one item', async ($, on) => {
  const files = new Map<string, string>([[`${HOME}/leads/flow.json`, JSON.stringify(LEADS)]])
  const h = harness($, on, files)

  // A test run: made-up results, approvals that pass, nothing remembered.
  const dry = await h.manage({ action: 'run', flow: 'leads', inputs: { niche: 'x' }, dry: true })
  expect(dry).toContain('a test run')
  expect(h.run('leads').status).toBe('done')
  expect(h.run('leads').dry).toBe(true)
  expect(h.spawned.length).toBe(0)
  expect(JSON.parse(h.ran[0]?.stdin ?? '{}').dry).toBe(true)
  expect(files.has(`${HOME}/leads/memory.md`)).toBe(false)

  // Started at the agent after the "each": the input is the list, one track per item from that step.
  expect(await h.manage({ action: 'run', flow: 'leads', inputs: { niche: 'x' }, from: 'write' })).toContain('needs the list of items')
  let told = await h.manage({ action: 'run', flow: 'leads', inputs: { niche: 'x' }, input: 'one\ntwo', from: 4 })
  expect(told).toContain('at step 4')
  expect(h.run('leads', 2).tracks.map(t => t.item)).toEqual([undefined, 'one', 'two'])
  await h.start(told, 'for one', 'FLOW-ERROR: no luck')
  told = await h.next('leads')

  // Approved as the user changed it: what goes on is their text.
  expect(told).toContain('"edit"')
  await h.next('leads', { approval: '1.4', answer: 'edit', note: 'for one, changed' })
  expect(files.get(`${ROOT}/leads/runs/2/out/1-4.txt`)).toBe('for one, changed')
  expect(h.run('leads', 2).status).toBe('failed')

  // One item alone, taken up again.
  expect(await h.manage({ action: 'retry', flow: 'leads', item: 1 })).toContain('has no failed item')
  told = await h.manage({ action: 'retry', flow: 'leads', item: 2 })
  await h.start(told, 'for two')
  await h.next('leads')
  await h.next('leads', { approval: '2.4', answer: 'approve' })
  expect(h.run('leads', 2).status).toBe('done')

  // A run still going makes way for a new one only when asked to.
  await h.manage({ action: 'run', flow: 'leads', inputs: { niche: 'three' } })
  expect(await h.manage({ action: 'run', flow: 'leads', inputs: { niche: 'four' } })).toContain('"replace": true')
  await h.manage({ action: 'run', flow: 'leads', inputs: { niche: 'four' }, replace: true })
  expect(h.run('leads', 3).status).toBe('stopped')
  expect(h.run('leads', 4).status).toBe('running')
})

test('flows are kept for every session: brought over from a folder, copied and renamed', async ($, on) => {
  const files = new Map<string, string>([
    [`${ROOT}/old/flow.json`, JSON.stringify({ description: 'From before', steps: [{ id: 's', type: 'code', name: 'S', file: 'steps/s.js' }] })],
    [`${ROOT}/old/steps/s.js`, 'console.log(1)'],
  ])
  const h = harness($, on, files)
  expect(await h.manage({ action: 'list' })).toContain('not brought over: old')
  expect(await h.manage({ action: 'import', flow: 'old' })).toContain('every session has it now')
  expect(files.get(`${HOME}/old/steps/s.js`)).toBe('console.log(1)')
  expect(await h.manage({ action: 'copy', flow: 'old', to: 'older' })).toContain('Copied')
  expect(files.has(`${HOME}/older/flow.json`)).toBe(true)
  expect(await h.manage({ action: 'rename', flow: 'older', to: 'newer' })).toContain('Renamed')
  expect(files.has(`${HOME}/older/flow.json`)).toBe(false)
  expect(files.get(`${HOME}/newer/steps/s.js`)).toBe('console.log(1)')
  expect(await h.manage({ action: 'list' })).not.toContain('not brought over')
})
