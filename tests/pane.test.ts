import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/P/Flows'
/** The flows are kept in ~/.claude/flows; a run's files go to the session's folder (C:\P). */
const HOME = 'C:/H/.claude/flows'
const flow = (description: string) => JSON.stringify({ description, steps: [{ id: 'research', type: 'agent', name: 'Research', model: 'haiku', instruction: 'Find facts about the input.' }] })
const slash = (path: string): string => path.replace(/\\/g, '/')

// The pane's only control picks the flow shown; everything else is asked in the chat.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane picks the flow shown from one picker (${surface})`, async ($, on) => {
    const files = new Map<string, string>([
      [`${HOME}/demo/flow.json`, flow('A demo flow')],
      [`${HOME}/other/flow.json`, flow('Another flow')],
    ])
    on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
    on('env.get', async (_$: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:\\H' : undefined }) as never)
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
    // One picker drawn by its own module, no buttons: the flow shown as a card, the others under it once opened.
    const current = async (): Promise<unknown> => ((await pane.find({ key: 'picker' }))?.props.props as { current: unknown }).current
    expect(await pane.findAll({ type: 'Button' })).toEqual([])
    expect(await current()).toBe('demo')
    expect(await pane.find({ key: 'shown:demo', in: 'picker' })).toBeDefined()
    expect(await pane.find({ key: 'item:other', in: 'picker' })).toBeUndefined()
    await pane.pointer({ type: 'down', x: 3, y: 0, button: 'left' })
    expect(await pane.find({ key: 'item:other', in: 'picker' })).toBeDefined()
    // The first card under the shown one starts at row 2.
    await pane.pointer({ type: 'down', x: 3, y: 2, button: 'left' })
    expect(await current()).toBe('other')
    expect(await pane.find({ key: 'shown:other', in: 'picker' })).toBeDefined()
    expect(await pane.find({ key: 'item:demo', in: 'picker' })).toBeUndefined()
    // The keyboard does the same: Enter opens, Enter picks.
    await pane.key({ key: 'return', in: 'picker' })
    await pane.key({ key: 'return', in: 'picker' })
    expect(await current()).toBe('demo')
  })
}

test('with no flows, the pane says how to write one, with no controls', async ($, on) => {
  on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
  on('env.get', async (_$: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:\\H' : undefined }) as never)
  on('fs.list', async () => ({ value: [] }) as never)
  const pane = await $.ui.mount({ plugin: 'flows', surface: 'desktop', component: 'Pane', requestId: 'flows', props: { bodyColumns: 60 } as never })
  expect(await pane.findAll({ type: 'Button' })).toEqual([])
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('No flows yet')
})
