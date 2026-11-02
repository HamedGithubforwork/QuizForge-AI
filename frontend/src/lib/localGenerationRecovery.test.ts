import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LocalGenerationUnresponsiveError,
  runRecoverableLocalGeneration,
} from './localGenerationRecovery.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('successful local generation finishes without cancelling Electron', async () => {
  let cancellations = 0
  const result = await runRecoverableLocalGeneration(async () => ({
    ok: true, quiz: { questions: [{ question: 'Supported fact?' }] },
  }), {
    timeoutMs: 30,
    cancelNative: async () => { cancellations++ },
  })
  assert.equal(result.ok, true)
  await tick()
  assert.equal(cancellations, 0)
})

test('a hung Electron generation IPC times out and requests native cancellation', async () => {
  let cancellations = 0
  const stalled = new Promise<never>(() => {})
  await assert.rejects(
    runRecoverableLocalGeneration(() => stalled, {
      timeoutMs: 10,
      cancelNative: async () => { cancellations++ },
    }),
    error => error instanceof LocalGenerationUnresponsiveError &&
      /restart the desktop app/i.test(error.message),
  )
  await tick()
  assert.equal(cancellations, 1)
})

test('manual cancellation releases the UI even when native cancellation IPC never resolves', async () => {
  let cancelCount = 0
  const controller = new AbortController()
  let started = false
  let resolveLate!: (value: string) => void
  const task = new Promise<string>(resolve => { resolveLate = resolve })
  const result = runRecoverableLocalGeneration(() => {
    started = true
    return task
  }, {
    signal: controller.signal,
    timeoutMs: 200,
    cancelNative: () => {
      cancelCount++
      return new Promise<void>(() => {})
    },
  })
  await tick()
  assert.equal(started, true)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  resolveLate('Old result must be ignored')
  await tick()
  assert.equal(cancelCount, 1)
  assert.equal(await runRecoverableLocalGeneration(async () => 'new quiz', {
    cancelNative: async () => {},
    timeoutMs: 200,
  }), 'new quiz')
})

test('aborting before generation never starts page loading or inference', async () => {
  const controller = new AbortController()
  controller.abort()
  let started = false
  await assert.rejects(runRecoverableLocalGeneration(async () => {
    started = true
    return 'unexpected'
  }, {
    signal: controller.signal,
    cancelNative: async () => {},
  }), { name: 'AbortError' })
  assert.equal(started, false)
})

test('ordinary model errors propagate without a spurious cancellation', async () => {
  let cancellations = 0
  await assert.rejects(runRecoverableLocalGeneration(async () => {
    throw new Error('generation_failed')
  }, {
    timeoutMs: 100,
    cancelNative: async () => { cancellations++ },
  }), /generation_failed/)
  await tick()
  assert.equal(cancellations, 0)
})

test('a timeout also covers stalled source-page loading before inference', async () => {
  let modelCalled = false
  let cancellations = 0
  await assert.rejects(runRecoverableLocalGeneration(async () => {
    await new Promise<never>(() => {}) // simulate lost source-text IPC
    modelCalled = true
    return null
  }, {
    timeoutMs: 10,
    cancelNative: async () => { cancellations++ },
  }), LocalGenerationUnresponsiveError)
  await tick()
  assert.equal(modelCalled, false)
  assert.equal(cancellations, 1)
})

test('invalid timeout is rejected before starting generation', async () => {
  let started = false
  await assert.rejects(runRecoverableLocalGeneration(async () => {
    started = true
    return null
  }, {
    timeoutMs: -1,
    cancelNative: async () => {},
  }), TypeError)
  assert.equal(started, false)
})
