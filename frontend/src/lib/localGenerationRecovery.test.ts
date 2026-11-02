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
    onTimeout: () => {},
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
      onTimeout: () => {},
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
    onTimeout: () => {},
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
    onTimeout: () => {},
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
    onTimeout: () => {},
  }), { name: 'AbortError' })
  assert.equal(started, false)
})

test('cancelling in the same event-loop turn prevents starting native inference', async () => {
  const controller = new AbortController()
  let started = false
  let cancelled = 0
  const result = runRecoverableLocalGeneration(async () => {
    started = true
    return 'unexpected'
  }, {
    signal: controller.signal,
    timeoutMs: 200,
    cancelNative: async () => { cancelled++ },
    onTimeout: () => {},
  })
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  await tick()
  assert.equal(started, false)
  assert.equal(cancelled, 1)
})

test('ordinary model errors propagate without a spurious cancellation', async () => {
  let cancellations = 0
  await assert.rejects(runRecoverableLocalGeneration(async () => {
    throw new Error('generation_failed')
  }, {
    timeoutMs: 100,
    cancelNative: async () => { cancellations++ },
    onTimeout: () => {},
  }), /generation_failed/)
  await tick()
  assert.equal(cancellations, 0)
})

test('watchdog aborts late PDF reads so they cannot start inference afterward', async () => {
  const controller = new AbortController()
  let modelCalled = false
  let cancellations = 0
  let releasePage!: () => void
  const pageText = new Promise<void>(resolve => { releasePage = resolve })
  await assert.rejects(runRecoverableLocalGeneration(async () => {
    await pageText
    controller.signal.throwIfAborted()
    modelCalled = true
    return null
  }, {
    signal: controller.signal,
    timeoutMs: 10,
    cancelNative: async () => { cancellations++ },
    onTimeout: () => controller.abort(),
  }), LocalGenerationUnresponsiveError)
  assert.equal(controller.signal.aborted, true)
  releasePage()
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
    onTimeout: () => {},
  }), TypeError)
  assert.equal(started, false)
})
