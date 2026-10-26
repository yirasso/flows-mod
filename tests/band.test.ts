import { expect, test } from 'claude-code/testing'

// The Flows button above the prompt: drawn over another mod's band, and it opens and closes the pane.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`the Flows button sits above another mod's band and toggles the pane (${surface})`, async ($, on) => {
    let shown = false
    const opened: string[] = []
    on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Text', props: {}, children: ["another mod's bar"] }) as never)
    on('ui.panes', async () => ({ value: shown ? [{ id: 'flows', isShown: true }] : [] }) as never)
    on('ui.open', async (_$: unknown, e: { id: string }) => (opened.push(e.id), (shown = true), { value: { isPlaced: true } }) as never)
    on('ui.close', async () => ((shown = false), { value: undefined }) as never)
    on('session.cwd', async () => ({ value: 'C:/Dev/Site' }) as never)
    on('fs.list', async () => ({ value: [] }) as never)
    on('clock.now', async () => ({ value: 0 }) as never)

    const band = await $.ui.mount({ plugin: 'flows', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    const texts = (await band.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts).toContain("another mod's bar")
    expect(await band.find({ key: 'flows-toggle' })).toBeDefined()

    await band.press({ key: 'flows-toggle' })
    expect(opened).toEqual(['flows'])
    expect(shown).toBe(true)
    await band.press({ key: 'flows-toggle' })
    expect(shown).toBe(false)
  })
}

test('the Flows button gives way to a survey', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Text', props: {}, children: ['survey'] }) as never)
  const band = await $.ui.mount({ plugin: 'flows', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: true, isWorking: false } as never })
  expect(await band.find({ key: 'flows-toggle' })).toBeUndefined()
})
