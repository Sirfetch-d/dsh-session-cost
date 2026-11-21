/** 会话日志折叠口径的单元测试（不依赖真实日志）。 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { consumeSession, createUsageState, foldEvent, routeOf, usageOf } from '../lib/usage-fold.js'
import { summarizeCost } from '../lib/pricing.js'

/** 构造一条 assistant/message 结算事件。 */
function settlement(seq, turn, step, usage, options = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: options.time ?? Date.UTC(2026, 8, 25, 12, 0),
    data: {
      turn,
      step,
      usage,
      message: { source: { kind: 'model', provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-flash' } },
    },
  }
}

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
})

test('usageOf 优先 data.usage，回退到流里最后一个 usage chunk', () => {
  assert.deepEqual(usageOf(settlement(0, 0, 0, usage(10, 2))), {
    uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 2,
  })
  const streamed = {
    type: 'assistant/message',
    seq: 0,
    data: { turn: 0, step: 0, stream: [{ type: 'usage', usage: usage(1, 1) }, { type: 'usage', usage: usage(7, 3) }] },
  }
  assert.deepEqual(usageOf(streamed), { uncachedInput: 7, cacheRead: 0, cacheWrite: 0, output: 3 })
  assert.equal(usageOf({ type: 'assistant/message', data: {} }), undefined)
  assert.equal(usageOf({ type: 'assistant/message', data: { usage: { inputTokens: 1.5, outputTokens: 2 } } }), undefined)
})

test('routeOf 读 message.source 的 provider/model', () => {
  assert.deepEqual(routeOf(settlement(0, 0, 0, usage(1, 1), { provider: 'magpie', model: 'x/y' })), {
    provider: 'magpie', model: 'x/y',
  })
  assert.deepEqual(routeOf({ data: {} }), { provider: '', model: '' })
})

test('同一 (turn, step) 的后一次结算替换前一次', () => {
  const state = createUsageState()
  foldEvent(state, settlement(0, 0, 0, usage(100, 10)))
  foldEvent(state, settlement(1, 0, 0, usage(100, 12)))
  assert.equal(state.events, 2)
  const route = state.routes['deepseek-official\u0000deepseek-flash']
  assert.equal(route.offPeak.uncachedInput, 100)
  assert.equal(route.offPeak.output, 12)
  assert.equal(route.offPeak.calls, 1)
})

test('llm/retry-started 清空槽位，使重试后的尝试再次计入', () => {
  const state = createUsageState()
  foldEvent(state, settlement(0, 0, 0, usage(100, 10)))
  foldEvent(state, { type: 'llm/retry-started', seq: 1, data: { turn: 0, step: 0 } })
  foldEvent(state, settlement(2, 0, 0, usage(100, 10)))
  const route = state.routes['deepseek-official\u0000deepseek-flash']
  assert.equal(route.offPeak.calls, 2)
  assert.equal(route.offPeak.uncachedInput, 200)
})

test('不同 (turn, step) 累加，并按事件时间分入高峰 / 低谷桶', () => {
  const state = createUsageState()
  // 周五 02:00 UTC = 高峰；周日 02:00 UTC = 低谷。
  foldEvent(state, settlement(0, 0, 0, usage(100, 10), { time: Date.UTC(2026, 8, 25, 2, 0) }))
  foldEvent(state, settlement(1, 0, 1, usage(200, 20), { time: Date.UTC(2026, 8, 27, 2, 0) }))
  const route = state.routes['deepseek-official\u0000deepseek-flash']
  assert.equal(route.peak.uncachedInput, 100)
  assert.equal(route.offPeak.uncachedInput, 200)
  assert.equal(route.peak.calls + route.offPeak.calls, 2)
})

test('多模型路由分别记账并按各自单价计价', () => {
  const state = createUsageState()
  foldEvent(state, settlement(0, 0, 0, usage(1e6, 0), { provider: 'deepseek-official', model: 'deepseek-flash', time: Date.UTC(2026, 8, 27, 2, 0) }))
  foldEvent(state, settlement(1, 0, 1, usage(1e6, 0), { provider: 'deepseek-official', model: 'deepseek-v4-pro', time: Date.UTC(2026, 8, 27, 3, 0) }))
  const result = summarizeCost(state.routes, { currency: 'CNY', prices: {} })
  // 2026-09-27 是周日 → 低谷（表价 ×0.5）：flash 未命中 2 元/1M → 1 元；v4-pro 9 元/1M → 4.5 元。
  assert.equal(result.amount, 1 + 4.5)
  assert.equal(result.routes.length, 2)
  assert.equal(result.priced, true)
})

test('consumeSession 只消费未读事件，可重复调用', () => {
  const events = [
    settlement(0, 0, 0, usage(10, 1)),
    settlement(1, 0, 1, usage(20, 2)),
  ]
  const session = { seq: events.length, eventAt: seq => events[seq] }
  const state = createUsageState()
  assert.equal(consumeSession(state, session), 2)
  assert.equal(consumeSession(state, session), 0)
  events.push(settlement(2, 1, 0, usage(30, 3)))
  session.seq = events.length
  assert.equal(consumeSession(state, session), 1)
  assert.equal(state.events, 3)
  assert.equal(consumeSession(state, null), 0)
})

test('非结算事件不改变用量，但会推进已读位置', () => {
  const events = [
    { type: 'step/start', seq: 0, time: 1, data: {} },
    settlement(1, 0, 0, usage(5, 1)),
    { type: 'tool/call', seq: 2, time: 2, data: {} },
  ]
  const session = { seq: 3, eventAt: seq => events[seq] }
  const state = createUsageState()
  consumeSession(state, session)
  assert.equal(state.seq, 3)
  assert.equal(state.events, 1)
  assert.equal(state.routes['deepseek-official\u0000deepseek-flash'].offPeak.calls, 1)
})
