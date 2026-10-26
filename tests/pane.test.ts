import { expect, mock, test } from 'claude-code/testing'

import type { Run } from '../types'

const ROOT = 'C:/P/Flows'
const flow = (description: string) => JSON.stringify({ description, steps: [{ id: 'research', type: 'agent', name: 'Research', model: 'haiku', instruction: 'Find facts about the input.' }] })
const slash = (path: string): string => path.replace(/\\/g, '/')
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 50_000 && !done(); i++) await Promise.resolve()
}

// The pane does what /flows does: a button per flow, Run with its input, Stop, Retry, older runs, New and Edit.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane's buttons pick, run, stop and take up a flow, and start writing one (${surface})`, async ($, on) => {
    const files = new Map<string, string>([
      [`${ROOT}/demo/flow.json`, flow('A demo flow')],
      [`${ROOT}/other/flow.json`, flow('Another flow')],
    ])
    const prompts: string[] = []
    const filled: string[] = []
    const stopped: string[] = []
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
    on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    on('agent.register', async () => ({ value: undefined }) as never)
    on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('ui.toast', async () => ({ value: undefined }) as never)
    on('command.register', async () => ({ value: undefined }) as never)
    on('prompt.submit', async (_$: unknown, e: { text: string }) => (prompts.push(e.text), { text: e.text }) as never)
    on('prompt.fill', async (_$: unknown, e: { text: string }) => (filled.push(e.text), { isFilled: true, text: e.text, cursor: e.text.length }) as never)
    on('tool.call', { tool: 'TaskStop' }, async (_$: unknown, e: { task_id: string }) => (stopped.push(e.task_id), { result: 'stopped' }) as never)

    await $.command.run({ command: 'flows', args: 'list', origin: { kind: 'user' } } as never)
    const pane = await $.ui.mount({ plugin: 'flows', surface, component: 'Pane', requestId: 'flows', props: { bodyColumns: 60 } as never })
    const run = (): Run => JSON.parse(files.get(`${ROOT}/demo/runs/1/run.json`) ?? '{}') as Run

    // One button per flow; pressing one shows it.
    expect((await pane.find({ key: 'flow:demo' }))?.text).toContain('demo')
    await pane.press({ key: 'flow:other' })
    await pane.press({ key: 'edit' })
    expect(filled).toEqual(['/flows edit other '])
    await pane.press({ key: 'flow:demo' })

    // Run starts it with what was typed in the field, and hands the session's Claude its first prompt.
    await pane.input({ key: 'input', text: 'volcanoes', kind: 'change' })
    await pane.press({ key: 'run' })
    await time.advance(100)
    await until(() => prompts.length > 0)
    expect(files.get(`${ROOT}/demo/runs/1/out/input.txt`)).toBe('volcanoes')
    expect(prompts[0]).toContain('Run my saved flow "demo" (run 1)')
    expect(await pane.find({ key: 'run' })).toBeUndefined()

    // Stop halts the run; Retry then takes it up.
    expect(await pane.find({ key: 'stop' })).toBeDefined()
    await pane.press({ key: 'stop' })
    expect(run().status).toBe('stopped')
    expect(await pane.find({ key: 'stop' })).toBeUndefined()
    await pane.press({ key: 'retry' })
    await time.advance(100)
    await until(() => prompts.length > 1)
    expect(prompts[1]).toContain('Take up my saved flow "demo" (run 1)')
    expect(stopped).toEqual([])

    // New and Edit put the command in the prompt box, for the person to finish.
    await pane.press({ key: 'new' })
    await pane.press({ key: 'edit' })
    expect(filled).toEqual(['/flows edit other ', '/flows new ', '/flows edit demo '])
  })
}

test('with no flows, the pane offers to write one', async ($, on) => {
  const filled: string[] = []
  on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
  on('fs.list', async () => ({ value: [] }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('prompt.fill', async (_$: unknown, e: { text: string }) => (filled.push(e.text), { isFilled: true, text: e.text, cursor: e.text.length }) as never)
  const pane = await $.ui.mount({ plugin: 'flows', surface: 'desktop', component: 'Pane', requestId: 'flows', props: { bodyColumns: 60 } as never })
  await pane.press({ key: 'new' })
  expect(filled).toEqual(['/flows new '])
})
