import { expect, mock, test } from 'claude-code/testing'

import type { Run } from '../types'

const ROOT = 'C:/U/.claude/flows'
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

test('a flow runs its agent, code, approval and for-each steps, and retries a failed item', async ($, on) => {
  // The test stands in for the engine: files in memory, agents that start and wait to be answered
  // (a plugin's spawn reaches the bottom spelled as the Agent tool's call).
  const files = new Map<string, string>([[`${ROOT}/demo/flow.json`, JSON.stringify(FLOW)]])
  const spawned: { id: string; prompt: string; type: string; description: string }[] = []
  const ran: { argv: readonly string[]; stdin: string }[] = []
  mock.env(on, { USERPROFILE: 'C:\\U' })
  mock.clock(on)
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
  on('agent.spawn', async (_$: unknown, e: { prompt: string; description?: string; subagent_type?: string }) => {
    spawned.push({ id: `a${spawned.length}`, prompt: e.prompt, type: e.subagent_type ?? '', description: e.description ?? '' })
    return { model: 'haiku' }
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
  on('turn.complete', async (_$: unknown, e: { answer: string }) => ({ text: e.answer }) as never)

  const run = (): Run => JSON.parse(files.get(`${ROOT}/demo/runs/1/run.json`) ?? '{}') as Run
  const answer = (agentId: string, text: string): Promise<unknown> =>
    $.turn.complete({ agentId, answer: text, reason: 'answer', durationMs: 1, isAborted: false, turnId: agentId, usage: { model: 'haiku', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

  await $.command.run({ command: 'flow', args: 'run demo volcanoes', origin: { kind: 'user' } } as never)
  await until(() => run().tracks?.[0]?.steps[0]?.agentId === 'a0')
  expect(spawned.length).toBe(1)
  expect(spawned[0]?.type).toBe('flows:demo-research')
  expect(spawned[0]?.prompt).toContain('volcanoes')

  // The agent's answer is the script's input, and the script's output waits at the approval.
  await answer('a0', 'three facts')
  await until(() => run().status === 'waiting')
  expect(ran.length).toBe(1)
  expect(slash(ran[0]?.argv.join(' ') ?? '')).toContain('demo/steps/format.js')
  expect(JSON.parse(ran[0]?.stdin ?? '{}').input).toBe('three facts')
  expect(run().status).toBe('waiting')

  const ui = await $.ui.mount({ plugin: 'flows', surface: 'desktop', component: 'Pane', requestId: 'flows', props: { title: 'Flows', isFocused: false } as never, viewport: { columns: 60, rows: 50 } as never })
  await until(() => run().tracks[0]?.steps[2]?.preview !== undefined)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('["one","two"]')
  await ui.press({ key: 'approve:0:2' })
  await until(() => run().tracks[2]?.steps[4]?.agentId === 'a2')

  // Approved: one agent per item, each with its item as input.
  expect(spawned.length).toBe(3)
  expect(spawned[1]?.prompt).toContain('one')
  expect(spawned[2]?.prompt).toContain('two')
  await answer('a1', 'A sentence about one.')
  await answer('a2', 'FLOW-ERROR: nothing to say about two')
  await until(() => run().status === 'failed')
  expect(run().status).toBe('failed')
  expect(run().tracks[2]?.steps[4]?.error).toBe('nothing to say about two')
  expect(run().tracks[1]?.steps[4]?.tokens).toBe(120)

  // Retry runs the failed item alone.
  await ui.press({ key: 'run:retry' })
  await until(() => run().tracks[2]?.steps[4]?.agentId === 'a3')
  expect(spawned.length).toBe(4)
  expect(spawned[3]?.prompt).toContain('two')
  await answer('a3', 'A sentence about two.')
  await until(() => run().status === 'done' && run().weekEnd !== undefined)
  expect(run().status).toBe('done')
  expect(files.get(`${ROOT}/demo/runs/1/out/2-4.txt`)).toBe('A sentence about two.')
})
