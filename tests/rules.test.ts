import { expect, test } from 'claude-code/testing'

import { claim, complete, finish, halt, inside, itemsOf, newRun, parseFlow, retry, sendBack, settle } from '../hooks/flow'

const flow = (steps: unknown[]) => parseFlow('demo', JSON.stringify({ description: 'd', steps }))

test('a flow.json that cannot run says why', async () => {
  expect(parseFlow('demo', 'nope').error).toContain('not valid JSON')
  expect(flow([]).error).toContain('no steps')
  expect(flow([{ type: 'agent', name: 'A' }]).error).toContain('no instruction')
  expect(flow([{ type: 'code', file: '../x.js' }]).error).toContain('inside the flow')
  expect(flow([{ type: 'agent', instruction: 'x' }, { type: 'each' }]).error).toContain('no step after it')
  expect(flow([{ type: 'agent', instruction: 'x' }]).error).toBeUndefined()
})

test('a flow agent writes only inside its folders', async () => {
  const roots = ['C:/U/Flows/demo/runs/1', 'C:/Dev/Site']
  expect(inside('C:\\U\\Flows\\demo\\runs\\1\\out.txt', roots[0] ?? '', roots)).toBe(true)
  expect(inside('notes/a.md', 'C:/Dev/Site', roots)).toBe(true)
  expect(inside('C:/Dev/Site2/a.md', 'C:/Dev/Site', roots)).toBe(false)
  expect(inside('C:/Dev/Site/../Other/a.md', 'C:/Dev/Site', roots)).toBe(false)
  expect(inside('C:/Users/x/.ssh/id', 'C:/Dev/Site', roots)).toBe(false)
})

test('an each step takes a JSON list or lines', async () => {
  expect(itemsOf('["a", {"b":1}]')).toEqual(['a', '{"b":1}'])
  expect(itemsOf('a\n\n b \n')).toEqual(['a', 'b'])
  expect(itemsOf('')).toEqual([])
})

test('a stopped run ignores a late result, and retry starts its step again', async () => {
  const f = flow([{ type: 'agent', name: 'A', instruction: 'x' }, { type: 'approval', name: 'Ok' }])
  const started = claim(newRun(f, 1, '', 100, 'me', null), 0, 0, 100)
  if (!started) throw new Error('not claimed')
  const stopped = settle(halt(started, 'stopped', 'Stopped', 200), 200)
  expect(stopped.status).toBe('stopped')
  // The agent answers after the stop: its token is the old start, but the step is no longer running.
  expect(finish(stopped, 0, 0, 100, { output: 'late' }, 300)).toBeNull()
  const again = settle(retry(stopped, 'me', 400), 400)
  expect(again.status).toBe('running')
  expect(again.tracks[0]?.steps[0]?.status).toBe('pending')
})

test('send back returns to the agent before the approval, with the note', async () => {
  const f = flow([{ type: 'agent', name: 'A', instruction: 'x' }, { type: 'approval', name: 'Ok' }])
  const a = claim(newRun(f, 1, '', 100, 'me', null), 0, 0, 100)
  const b = a && finish(a, 0, 0, 100, { output: 'draft', tokens: 5 }, 150)
  const c = b && claim(b, 0, 1, 200)
  const d = c && sendBack(c, 0, 1, 'shorter')
  expect(d?.tracks[0]?.at).toBe(0)
  expect(d?.tracks[0]?.steps[0]).toEqual({ status: 'pending', note: 'shorter', tokens: 5 })
  expect(d?.tracks[0]?.steps[1]).toBeUndefined()
})

test('the typeahead offers the commands after /flows, and the flows where a name goes', async () => {
  const flows = [{ name: 'resumo-site', description: 'Summarises a page.' }, { name: 'test-facts', description: 'Three facts.' }]
  // The word being typed is the run of characters that ends at the cursor, here the end of the draft.
  const rows = (text: string): string[] => {
    const start = text.search(/\S*$/)
    return complete(text, text.slice(start), start, flows).map(r => r.text)
  }
  expect(rows('/flows')).toEqual(['/flows list', '/flows new ', '/flows edit ', '/flows run ', '/flows retry ', '/flows delete '])
  expect(rows('/flo')).toEqual([])
  expect(rows('/flows r')).toEqual(['run ', 'retry ', 'resumo-site'])
  expect(rows('/flows list')).toEqual([])
  expect(rows('/flows run t')).toEqual(['test-facts'])
  expect(rows('/flows run test-facts')).toEqual([])
  expect(rows('/flows run test-facts v')).toEqual([])
  expect(rows('/flows new t')).toEqual([])
  expect(rows('what does /flows r')).toEqual([])
  expect(complete('/flows', '/flows', 0, flows)[3]).toEqual({ text: '/flows run ', label: '/flows run', description: 'Runs a flow: <name> [input]' })
})
