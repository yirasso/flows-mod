import { expect, mock, test } from 'claude-code/testing'

import type { Run } from '../types'

const ROOT = 'C:/P/Flows'
const FLOW = {
  description: 'A test flow',
  steps: [
    { id: 'research', type: 'agent', name: 'Research', model: 'haiku', effort: 'low', instruction: 'Find facts about the input.' },
    { id: 'format', type: 'code', name: 'Format', file: 'steps/format.js' },
    { id: 'check', type: 'approval', name: 'Check' },
    { id: 'split', type: 'each', name: 'For each fact', parallel: 2 },
    { id: 'write', type: 'agent', name: 'Write', model: 'haiku', instruction: 'Write one sentence.' },
  ],
}

/** The engine hands paths over in the machine's own spelling. */
const slash = (path: string): string => path.replace(/\\/g, '/')

/** Lets the work a call left running go on (all in-process, so turns of the queue) until `done` holds. */
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 50_000 && !done(); i++) await Promise.resolve()
}

test('the session\'s Claude runs a flow through the next tool: agents, code, an approval, a for-each and a retry', async ($, on) => {
  // The test stands in for the engine (files in memory, agents that start and wait to be answered) and for
  // the session's Claude (it calls the tool and starts the agents the answer names).
  const files = new Map<string, string>([[`${ROOT}/demo/flow.json`, JSON.stringify(FLOW)]])
  const spawned: { id: string; prompt: string; type: string; description: string; cwd: string }[] = []
  const ran: { argv: readonly string[]; stdin: string }[] = []
  const prompts: string[] = []
  // The session's folder is the project; its flows are in its Flows folder.
  on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
  const time = mock.clock(on)
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = files.get(slash(e.path))
    if (text === undefined) throw new Error('no such file')
    return { value: text }
  })
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => (files.set(slash(e.path), e.text), { value: undefined }))
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
  on('agent.spawn', async (_$: unknown, e: { prompt: string; description?: string; subagentType?: string; subagent_type?: string; cwd?: string }) => {
    spawned.push({ id: `a${spawned.length}`, prompt: e.prompt, type: e.subagentType ?? e.subagent_type ?? '', description: e.description ?? '', cwd: slash(e.cwd ?? '') })
    return { model: 'haiku', agentId: `a${spawned.length - 1}` }
  })
  on('agent.list', async () => ({ value: spawned.map(a => ({ id: a.id, description: a.description, type: a.type, status: 'running' })) }) as never)
  on('process.run', async (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    ran.push({ argv: e.argv, stdin: e.init?.stdin ?? '' })
    return { value: { exitCode: 0, stdout: '["one","two"]\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'seven_day', percentUsed: 10 }] } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => (prompts.push(e.text), { text: e.text }) as never)
  on('turn.complete', async (_$: unknown, e: { answer: string }) => ({ text: e.answer }) as never)

  const run = (): Run => JSON.parse(files.get(`${ROOT}/demo/runs/1/run.json`) ?? '{}') as Run
  const next = async (more: Record<string, string> = {}): Promise<string> => String((await $.tool.call({ tool: 'mcp__flows__next', flow: 'demo', ...more } as never)).result)
  // The Agent tool, as the session runs it in the foreground: the agent starts (through the plugin's spawn
  // hook), its turn ends on a last message that is not its result, and the call returns the report it handed back.
  const reports: string[] = []
  on('tool.call', { tool: 'Agent' }, async (_$: unknown, e: { subagent_type?: string; description?: string; prompt?: string }) => {
    const started = (await $.agent.spawn({ subagentType: e.subagent_type, description: e.description, prompt: e.prompt } as never)) as { deny?: string }
    if (started.deny !== undefined) return { deny: started.deny } as never
    const agentId = `a${spawned.length - 1}`
    const text = reports.shift() ?? ''
    // An agent writes its result in the file its task names and hands back DONE; one marked "!" forgets the file.
    const file = /Result file[^:]*: (\S+)/.exec(spawned[spawned.length - 1]?.prompt ?? '')?.[1]
    const wrote = file !== undefined && !text.startsWith('FLOW-ERROR:') && !text.startsWith('!')
    if (wrote && file) files.set(slash(file), text)
    const report = wrote ? 'DONE' : text.replace(/^!/, '')
    await $.turn.complete({ agentId, answer: 'Report handed back.', reason: 'answer', durationMs: 1, isAborted: false, turnId: agentId, usage: { model: 'haiku', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)
    return { result: { agentId, handbackReport: { text: report }, content: [{ type: 'text', text: report }], totalTokens: 120, totalDurationMs: 5 } } as never
  })
  /** Starts every agent an answer of the tool names, as the session's Claude would; each hands back the next of `texts`. */
  const start = async (told: string, ...texts: string[]): Promise<void> => {
    reports.push(...texts)
    for (const m of told.matchAll(/subagent_type: "([^"]+)" · description: "([^"]+)" · prompt: "([^"]+)"/g)) await $.tool.call({ tool: 'Agent', subagent_type: m[1], description: m[2], prompt: m[3] } as never)
  }

  // /flows run starts nothing by itself: it hands the session's Claude a prompt.
  await $.command.run({ command: 'flows', args: 'run demo volcanoes', origin: { kind: 'user' } } as never)
  await time.advance(100)
  await until(() => prompts.length === 1)
  expect(prompts[0]).toContain('mcp__flows__next')
  expect(spawned.length).toBe(0)

  // The tool names the first agent; started, it gets the step's real task and the run's folder.
  let told = await next()
  expect(told).toContain('subagent_type: "flows:demo-research"')
  expect(told).toContain('description: "demo #1 [0.0] Research"')
  await start(told, 'three facts')
  expect(spawned[0]?.prompt).toContain('Find facts about the input.')
  expect(spawned[0]?.prompt).toContain('volcanoes')
  // The agent works in the project.
  expect(spawned[0]?.cwd).toBe('C:/P')

  // An agent that is no step waiting to start is refused.
  expect(((await $.agent.spawn({ subagentType: 'flows:demo-research', description: 'demo #1 [0.0] Research', prompt: 'x' } as never)) as { deny?: string }).deny).toContain('not a step waiting')

  // The report the agent handed back (not its last message) is the script's input, and the script's output waits at the approval.
  told = await next()
  expect(ran.length).toBe(1)
  expect(slash(ran[0]?.argv.join(' ') ?? '')).toContain('demo/steps/format.js')
  expect(JSON.parse(ran[0]?.stdin ?? '{}').input).toBe('three facts')
  expect(run().status).toBe('waiting')
  expect(told).toContain('["one","two"]')
  expect(told).toContain('"Send back"')

  // The pane only shows: it says where the answer is wanted and has nothing to press. In a terminal it is
  // text; in the desktop app, one drawing for the header and one per step.
  const term = await $.ui.mount({ plugin: 'flows', surface: 'terminal', component: 'Pane', requestId: 'flows', props: { title: 'Flows', isFocused: false } as never, viewport: { columns: 60, rows: 50 } as never })
  expect((await term.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Waiting for your answer in the chat')
  expect((await term.findAll({ type: 'Button' })).length).toBe(0)
  await term.unmount()
  const desk = await $.ui.mount({ plugin: 'flows', surface: 'desktop', component: 'Pane', requestId: 'flows', props: { title: 'Flows', isFocused: false, bodyColumns: 60 } as never, viewport: { columns: 60, rows: 50 } as never })
  expect((await desk.findAll({ type: 'Svg' })).length).toBe(1 + FLOW.steps.length)
  expect((await desk.findAll({ type: 'Button' })).length).toBe(0)

  // Approved: one agent per item, each with its item as input.
  told = await next({ answer: 'approve' })
  await start(told, '!A sentence about one.', 'FLOW-ERROR: nothing to say about two')
  expect(spawned.length).toBe(3)
  expect(spawned[1]?.prompt).toContain('one')
  expect(spawned[2]?.prompt).toContain('two')
  told = await next()
  expect(run().status).toBe('failed')
  expect(told).toContain('nothing to say about two')
  expect(told).toContain('propose one fix')
  expect(run().tracks[1]?.steps[4]?.tokens).toBe(120)

  // /flows retry takes the failed item up again.
  await $.command.run({ command: 'flows', args: 'retry demo', origin: { kind: 'user' } } as never)
  await time.advance(100)
  await until(() => prompts.length === 2)
  told = await next()
  await start(told, 'A sentence about two.')
  expect(spawned.length).toBe(4)
  expect(spawned[3]?.prompt).toContain('two')
  told = await next()
  expect(run().status).toBe('done')
  expect(told).toContain('It finished')
  expect(told).toContain('A sentence about two.')
  expect(files.get(`${ROOT}/demo/runs/1/out/2-4.txt`)).toBe('A sentence about two.')
})

