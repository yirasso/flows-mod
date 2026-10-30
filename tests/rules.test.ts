import { expect, test } from 'claude-code/testing'

import type { FlowInput, JsonSchema } from '../types'
import { changes, whole } from '../hooks/author'
import { claim, fill, finish, halt, inside, itemsOf, jsonOf, labelOf, misfits, newRun, parseFlow, retry, sample, sendBack, settle, varsOf } from '../hooks/flow'

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

test("a step's result is checked against its schema, and a test run makes one up that fits", async () => {
  const schema: JsonSchema = { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, rating: { type: 'number', maximum: 5 } } }, minItems: 1 }
  expect(misfits(jsonOf('```json\n[{"name":"A","rating":4}]\n```'), schema)).toEqual([])
  expect(misfits(jsonOf('[{"rating":9}]'), schema)).toEqual(['the result[0] has no "name"', 'the result[0].rating should be at most 5'])
  expect(misfits(jsonOf('not json'), schema)).toEqual(['the result should be of type array, not missing'])
  expect(misfits(sample(schema, 'leads'), schema)).toEqual([])
  expect(fill('{{name}} · {{site.url}} · {{none}}', { name: 'A', site: { url: 'a.html' } })).toBe('A · a.html · {{none}}')
  expect(labelOf('{"name":"Padaria Sol","rating":4}')).toBe('Padaria Sol')
})

test("a flow's inputs are taken in their types, with their defaults", async () => {
  const inputs: FlowInput[] = [{ id: 'niche', required: true }, { id: 'count', type: 'number', default: 3 }, { id: 'zones', type: 'list' }]
  expect(varsOf(inputs, { niche: 'bakeries', zones: 'Lisboa, Porto' })).toEqual({ vars: { niche: 'bakeries', count: 3, zones: ['Lisboa', 'Porto'] } })
  expect(varsOf(inputs, { niche: 'x', count: 'many' })).toEqual({ error: '"count" should be a number, not "many"' })
  expect(varsOf(inputs, {})).toEqual({ error: '"niche" is needed' })
})

test('a patch changes only the steps it names, and the change is said step by step', async () => {
  const before = flow([{ id: 'a', type: 'agent', name: 'A', instruction: 'x', model: 'sonnet' }, { id: 'b', type: 'approval', name: 'B' }])
  const made = whole({ patch: [{ id: 'a', model: 'opus' }, { id: 'c', type: 'agent', name: 'C', instruction: 'y', after: 'a' }], remove: ['b'] }, before)
  if ('error' in made) throw new Error(made.error)
  const after = parseFlow('demo', JSON.stringify(made))
  expect(after.steps.map(s => s.id)).toEqual(['a', 'c'])
  expect(changes(before, after)).toEqual(['removed step "b" (B)', 'changed "a": model sonnet → opus', 'added step 2 "c" (agent, C)'])
  expect(whole({ patch: [{ id: 'x', after: 'nope' }] }, before)).toEqual({ error: 'There is no step "nope" to add "x" after.' })
})
