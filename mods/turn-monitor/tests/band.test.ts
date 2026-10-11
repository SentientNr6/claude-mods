import { expect, mock, test } from 'claude-code/testing'

const band = (isWorking: boolean) =>
  ({
    plugin: 'turn-monitor',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking,
      maxRows: 10,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

test('the band shows the effort, and is dim behind "last turn" while a turn runs', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 12_000, window: 200_000, percent: 6 },
      rateLimits: [],
    },
  }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: 'C:\\project' }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })

  // A subagent's request in between does not change the main loop's effort.
  const step = { turnId: 'turn-1', model: 'claude-opus-5-5', messageCount: 1 }
  for await (const _ of $.turn.step({ ...step, index: 0, effort: 'high' })) {
    // The step's chunks: none from the test's own bottom.
  }
  for await (const _ of $.turn.step({ ...step, index: 0, effort: 'low', agentId: 'a1' })) {
    // As above.
  }

  await $.turn.complete({
    answer: 'done',
    durationMs: 5_000,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 10,
      output_tokens: 200,
      cache_read_input_tokens: 3_000,
      cache_creation_input_tokens: 400,
    },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount({ surface, ...band(false) })

    expect(await idle.find({ type: 'Text', text: 'last turn' })).toBeUndefined()
    expect((await idle.find({ type: 'Text', text: 'Opus 5.5 High' }))?.props.dimColor).not.toBe(true)
    await idle.unmount()

    const working = await $.ui.mount({ surface, ...band(true) })

    expect(await working.find({ type: 'Text', text: 'last turn' })).toBeDefined()
    for (const text of ['Opus 5.5 High', '5.0s', 'ctx:12k 6%', 'cr:3k', 'out:200']) {
      expect((await working.find({ type: 'Text', text }))?.props.dimColor).toBe(true)
    }
    await working.unmount()
  }
})

test('before any finished turn the band has no "last turn" label', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ surface, ...band(true) })

    expect(await ui.find({ type: 'Text', text: 'last turn' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'after the next finished turn' })).toBeDefined()
    await ui.unmount()
  }
})
