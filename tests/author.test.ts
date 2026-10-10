import { expect, mock, test } from 'claude-code/testing'

import { check, sameShape } from '../hooks/author'

const ROOT = 'C:/P/Flows'
const slash = (path: string): string => path.replace(/\\/g, '/')
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 50_000 && !done(); i++) await Promise.resolve()
}

const AGENT = { id: 'greet', type: 'agent', name: 'Greet', description: 'Writes a greeting.', role: 'writer', model: 'haiku', instruction: 'Write a greeting for the name in the input.' }
const CODE = { id: 'shout', type: 'code', name: 'Shout', description: 'Upper-cases it.', file: 'steps/shout.js' }

test('a proposal that cannot be a flow says why', async () => {
  const bad = (p: object, onDisk: string[] = []): string => {
    const r = check('demo', p, onDisk)
    return 'error' in r ? r.error : ''
  }
  expect(bad({ steps: [AGENT] })).toContain('no description')
  expect(bad({ description: 'd', steps: [] })).toContain('no steps')
  expect(bad({ description: 'd', steps: [{ ...AGENT, description: '' }] })).toContain('has no description')
  expect(bad({ description: 'd', steps: [{ ...AGENT, role: 'wizard' }] })).toContain('none of')
  expect(bad({ description: 'd', steps: [AGENT, CODE] })).toContain('not in "files"')
  expect(bad({ description: 'd', steps: [AGENT, CODE], files: { '../x.js': 'x' } })).toContain('not a script path')
  expect(bad({ description: 'd', steps: [AGENT], files: { 'steps/extra.js': 'x' } })).toContain('used by no code step')
  // An edit may leave out a script the flow already has.
  expect(bad({ description: 'd', steps: [AGENT, CODE] }, ['steps/shout.js'])).toBe('')
  expect('flow' in check('demo', { description: 'd', steps: [AGENT, CODE], files: { 'steps/shout.js': 'x' } }, [])).toBe(true)
  expect(check('Bad Name', { description: 'd', steps: [AGENT] }, [])).toEqual({ error: expect.stringContaining('not a flow name') })
})

test('a run goes on with a changed flow only when its steps are the same ones', async () => {
  const a = [{ id: 'a', type: 'agent' as const, name: 'A' }, { id: 'b', type: 'approval' as const, name: 'B' }]
  expect(sameShape(a, [{ ...a[0], name: 'Renamed' }, a[1]] as never)).toBe(true)
  expect(sameShape(a, [a[0]] as never)).toBe(false)
  expect(sameShape(a, [a[1], a[0]] as never)).toBe(false)
})

test('/flows new and /flows edit: the tool explains, checks the proposal, shows the draft and saves it', async ($, on) => {
  // The test stands in for the engine (files in memory) and for the session's Claude (it calls the tool).
  const files = new Map<string, string>()
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
  // Deleting a flow's folder is a process the plugin runs: here it takes the folder's files out of memory.
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    const dir = slash(e.argv[e.argv.length - 1] ?? '')
    for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`)) files.delete(path)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => (prompts.push(e.text), { text: e.text }) as never)

  const run = async (args: string): Promise<string> => String(((await $.command.run({ command: 'flows', args, origin: { kind: 'user' } } as never)) as { text?: string }).text)
  const draft = async (more: object): Promise<string> => String((await $.tool.call({ tool: 'mcp__flows__draft', flow: 'hello', ...more } as never)).result)
  const shown = async (): Promise<string> => {
    const ui = await $.ui.mount({ plugin: 'flows', surface: 'terminal', component: 'Pane', requestId: 'flows', props: { title: 'Flows', isFocused: false } as never, viewport: { columns: 60, rows: 50 } as never })
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    await ui.unmount()
    return text
  }

  // /flows new hands the chat a prompt; the tool then says how to write the flow, with what was asked.
  expect(await run('list')).toContain('no flows yet')
  expect(await run('new Hello World greet someone')).toContain('Usage')
  expect(await run('new hello greet someone by name')).toContain('Writing "hello"')
  await time.advance(100)
  await until(() => prompts.length === 1)
  expect(prompts[0]).toContain('mcp__flows__draft')
  const told = await draft({ action: 'start' })
  expect(told).toContain('greet someone by name')
  expect(told).toContain('INTERVIEW')
  expect(told).toContain('at least 90% sure')

  // A proposal with a fault is sent back; a sound one shows in the pane as a draft, and nothing is saved yet.
  expect(await draft({ action: 'propose', description: 'Greets.', steps: [AGENT, CODE] })).toContain('Not accepted')
  const presented = await draft({ action: 'propose', description: 'Greets someone, loudly.', steps: [AGENT, CODE], files: { 'steps/shout.js': 'process.stdin.pipe(process.stdout)' } })
  expect(presented).toContain('"Save"')
  expect(presented).toContain('steps/shout.js')
  expect(await shown()).toContain('Draft, not saved yet')
  expect(files.has(`${ROOT}/hello/flow.json`)).toBe(false)

  // Saved once the person agreed: the flow's file and its script are written, and the draft is gone.
  expect(await draft({ action: 'save' })).toContain('Saved "hello"')
  expect(JSON.parse(files.get(`${ROOT}/hello/flow.json`) ?? '{}').steps.length).toBe(2)
  expect(files.get(`${ROOT}/hello/steps/shout.js`)).toContain('process.stdin')
  expect(await shown()).not.toContain('Draft, not saved yet')
  expect(await draft({ action: 'save' })).toContain('no draft')
  // /flows list names every flow of the project, with what it does and how its last run went.
  expect(await run('list')).toContain('hello: Greets someone, loudly. (2 steps · not run yet)')
  expect(await run('new list a flow named after a command')).toContain('none of')

  // The name is taken now; /flows edit shows the tool the flow as it is, scripts included.
  expect(await run('new hello again')).toContain('already a flow named')
  expect(await run('edit nope shorter')).toContain('no flow named')
  expect(await run('edit hello make it quieter')).toContain('Changing "hello"')
  const again = await draft({ action: 'start' })
  expect(again).toContain('make it quieter')
  expect(again).toContain('THE FLOW AS IT IS NOW')
  expect(again).toContain('process.stdin.pipe')
  // The script it does not change may be left out; a dropped draft saves nothing.
  expect(await draft({ action: 'propose', description: 'Greets someone, quietly.', steps: [{ ...AGENT, instruction: 'Whisper a greeting.' }, CODE] })).toContain('"Save"')
  expect(await draft({ action: 'discard' })).toContain('nothing was saved')
  expect(files.get(`${ROOT}/hello/flow.json`)).toContain('loudly')

  // A fix the person already said yes to is saved at once: no draft, no second question.
  expect(await draft({ action: 'propose', agreed: true, description: 'Greets someone, softly.', steps: [AGENT, CODE] })).toContain('Saved the change')
  expect(files.get(`${ROOT}/hello/flow.json`)).toContain('softly')
  expect(await shown()).not.toContain('Draft, not saved yet')

  // /flows delete says what goes and deletes nothing until it is typed again with "yes".
  expect(await run('delete nope')).toContain('no flow named')
  expect(await run('delete hello')).toContain('/flows delete hello yes')
  expect(files.has(`${ROOT}/hello/flow.json`)).toBe(true)
  expect(await run('delete hello yes')).toBe('Deleted "hello".')
  expect(files.has(`${ROOT}/hello/flow.json`)).toBe(false)
  expect(files.has(`${ROOT}/hello/steps/shout.js`)).toBe(false)
  expect(await run('list')).toContain('no flows yet')
})
