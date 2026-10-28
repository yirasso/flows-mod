import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/P/Flows'
const flow = (description: string) => JSON.stringify({ description, steps: [{ id: 'research', type: 'agent', name: 'Research', model: 'haiku', instruction: 'Find facts about the input.' }] })
const slash = (path: string): string => path.replace(/\\/g, '/')

// The pane's only buttons pick the flow shown; everything else is asked in the chat.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane has one button per flow, and pressing one shows it (${surface})`, async ($, on) => {
    const files = new Map<string, string>([
      [`${ROOT}/demo/flow.json`, flow('A demo flow')],
      [`${ROOT}/other/flow.json`, flow('Another flow')],
    ])
    on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
    on('fs.read', async (_$: unknown, e: { path: string }) => {
      const text = files.get(slash(e.path))
      if (text === undefined) throw new Error('no such file')
      return { value: text }
    })
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
    on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
    on('command.register', async () => ({ value: undefined }) as never)
    mock.clock(on)

    await $.command.run({ command: 'flows', args: 'list', origin: { kind: 'user' } } as never)
    const pane = await $.ui.mount({ plugin: 'flows', surface, component: 'Pane', requestId: 'flows', props: { bodyColumns: 60 } as never })
    const keys = async (): Promise<string[]> => (await pane.findAll({ type: 'Button' })).map(b => String(b.key))
    expect(await keys()).toEqual(['flow:demo', 'flow:other'])
    expect(await pane.find({ type: 'Input' })).toBeUndefined()
    await pane.press({ key: 'flow:other' })
    if (surface === 'terminal') expect((await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Another flow')
    expect(await keys()).toEqual(['flow:demo', 'flow:other'])
  })
}

test('with no flows, the pane says how to write one, with no buttons', async ($, on) => {
  on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
  on('fs.list', async () => ({ value: [] }) as never)
  const pane = await $.ui.mount({ plugin: 'flows', surface: 'desktop', component: 'Pane', requestId: 'flows', props: { bodyColumns: 60 } as never })
  expect(await pane.findAll({ type: 'Button' })).toEqual([])
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('No flows yet')
})
