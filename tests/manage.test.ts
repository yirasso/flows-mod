import { expect, mock, test } from 'claude-code/testing'

import type { Run } from '../types'

const ROOT = 'C:/P/Flows'
/** The flows are kept in ~/.claude/flows; a run's files go to the session's folder (C:\P). */
const HOME = 'C:/H/.claude/flows'
const FLOW = JSON.stringify({ description: 'Plans visits in Spain', steps: [{ id: 'plan', type: 'agent', name: 'Plan', model: 'haiku', instruction: 'Plan a visit to the input.' }] })
const slash = (path: string): string => path.replace(/\\/g, '/')

// The person asks in their own words; the session's Claude calls the manage tool, never a command.
test('the manage tool opens the pane, lists, runs, stops, takes up and deletes a flow', async ($, on) => {
  const files = new Map<string, string>([[`${HOME}/visitas-espanha/flow.json`, FLOW]])
  const prompts: string[] = []
  const panes: string[] = []
  on('session.cwd', async () => ({ value: 'C:\\P' }) as never)
  on('env.get', async (_$: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:\\H' : undefined }) as never)
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
  // The delete's rm: the folder it names goes from the files in memory.
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    const dir = slash(e.argv[e.argv.length - 1] ?? '')
    for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`)) files.delete(path)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.register', async () => ({ value: undefined }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }) as never)
  on('ui.open', async (_$: unknown, e: { id: string }) => (panes.push(`open ${e.id}`), { value: { isPlaced: true } }) as never)
  on('ui.close', async (_$: unknown, e: { id: string }) => (panes.push(`close ${e.id}`), { value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => (prompts.push(e.text), { text: e.text }) as never)

  const manage = async (args: Record<string, unknown>): Promise<string> => String((await $.tool.call({ tool: 'mcp__flows__manage', ...args } as never)).result)
  const run = (): Run => JSON.parse(files.get(`${ROOT}/visitas-espanha/runs/1/run.json`) ?? '{}') as Run

  // "abre o painel dos flows" / "fecha-o"
  expect(await manage({ action: 'open' })).toContain('Opened the Flows pane')
  expect(await manage({ action: 'close' })).toContain('Closed the Flows pane')
  expect(panes).toEqual(['open flows', 'close flows'])

  // "que flows tenho?"
  expect(await manage({ action: 'list' })).toContain('visitas-espanha: Plans visits in Spain')

  // "inicia o flow visitas espanha com Madrid": the user's words for the name bring the list to pick from.
  const unknown = await manage({ action: 'run', flow: 'visitas espanha', input: 'Madrid' })
  expect(unknown).toContain('There is no flow named "visitas espanha"')
  expect(unknown).toContain('- visitas-espanha: Plans visits in Spain')
  const started = await manage({ action: 'run', flow: 'visitas-espanha', input: 'Madrid' })
  expect(started).toContain('Started "visitas-espanha"')
  expect(started).toContain('subagent_type: "flows:')
  expect(files.get(`${ROOT}/visitas-espanha/runs/1/out/input.txt`)).toBe('Madrid')
  // Claude is already in its turn: no second prompt is handed to the chat.
  await time.advance(100)
  expect(prompts).toEqual([])

  // "pára-o" / "retoma-o"
  expect(await manage({ action: 'stop', flow: 'visitas-espanha' })).toContain('Stopped "visitas-espanha"')
  expect(run().status).toBe('stopped')
  expect(await manage({ action: 'retry', flow: 'visitas-espanha' })).toContain('Took up "visitas-espanha"')
  expect(await manage({ action: 'stop', flow: 'visitas-espanha' })).toContain('Stopped')

  // "apaga o flow": first what would go, then only with the person's yes.
  expect(await manage({ action: 'delete', flow: 'visitas-espanha' })).toContain('This would delete the flow "visitas-espanha" for good')
  expect(files.has(`${HOME}/visitas-espanha/flow.json`)).toBe(true)
  expect(await manage({ action: 'delete', flow: 'visitas-espanha', confirmed: true })).toContain('Deleted "visitas-espanha"')
  expect(files.has(`${HOME}/visitas-espanha/flow.json`)).toBe(false)
})
