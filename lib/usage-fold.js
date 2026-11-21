/**
 * 会话日志 → 计费 token 折叠（纯函数，可在 Node 下单测）。
 *
 * 口径对齐 harness 自己的 `tokenUsage` 投影（dsh-token-meter）：
 * - 只认 `assistant/message` / `assistant/attempt` 两种结算事件；
 * - 消费样本优先取 `event.data.usage`，回退到流里最后一个 `usage` chunk；
 * - 同一个 `(turn, step)` 的**后一次**结算**替换**前一次（`addReplacing`），
 *   避免重放或重复结算被计两次；`llm/retry-started` 会清空该槽位，因此被重试
 *   放弃的那次尝试仍然计入（它同样被计费）。
 *
 * 额外存下每条路由在高峰 / 低谷各自的花费桶，因为单价随时段变化。
 *
 * @module dsh-session-cost/usage-fold
 */

import { emptyPeriods, isPeak } from './pricing.js'

/**
 * 建一个空的折叠状态。
 * @returns {{seq: number, events: number, billed: number, routes: object, last: object|null, firstAt: number|null, lastAt: number|null}} 状态。
 */
export function createUsageState() {
  return { seq: 0, events: 0, billed: 0, routes: {}, last: null, firstAt: null, lastAt: null }
}

/**
 * 从一条结算事件里取 provider/model。
 * @param {object} event - 会话事件。
 * @returns {{provider: string, model: string}} 路由；缺失时为空串。
 */
export function routeOf(event) {
  const source = event?.data?.message?.source ?? {}
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    model: typeof source.model === 'string' ? source.model : '',
  }
}

/**
 * 从一条结算事件里取 token 用量。
 * @param {object} event - 会话事件。
 * @returns {{uncachedInput: number, cacheRead: number, cacheWrite: number, output: number}|undefined} 用量。
 */
export function usageOf(event) {
  let usage = event?.data?.usage
  if (usage === undefined && Array.isArray(event?.data?.stream)) {
    for (const chunk of event.data.stream) {
      if (chunk?.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage
    }
  }
  if (usage === null || typeof usage !== 'object') return undefined
  const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
  if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)) return undefined
  return {
    uncachedInput: count(usage.inputTokens),
    cacheRead: count(usage.cacheReadTokens),
    cacheWrite: count(usage.cacheWriteTokens),
    output: count(usage.outputTokens),
  }
}

/**
 * 往一个桶里加一份用量。
 * @param {object} bucket - 分时段桶。
 * @param {object} usage - 用量。
 * @returns {void}
 */
function addInto(bucket, usage) {
  bucket.uncachedInput += usage.uncachedInput
  bucket.cacheRead += usage.cacheRead
  bucket.cacheWrite += usage.cacheWrite
  bucket.output += usage.output
  bucket.calls += 1
}

/**
 * 从一个桶里减去一份用量（替换旧结算时用）。
 * @param {object} bucket - 分时段桶。
 * @param {object} usage - 用量。
 * @returns {void}
 */
function subtractFrom(bucket, usage) {
  bucket.uncachedInput -= usage.uncachedInput
  bucket.cacheRead -= usage.cacheRead
  bucket.cacheWrite -= usage.cacheWrite
  bucket.output -= usage.output
  bucket.calls -= 1
}

/**
 * 折叠一条会话事件；状态原地更新。
 * @param {object} state - {@link createUsageState} 的状态。
 * @param {object} event - 会话事件（必须带 `seq`）。
 * @returns {object} 同一个状态对象。
 */
export function foldEvent(state, event) {
  if (event === null || typeof event !== 'object') return state
  if (Number.isSafeInteger(event.seq)) state.seq = Math.max(state.seq, event.seq + 1)
  const at = Number.isFinite(event.time) ? event.time : null
  if (at !== null) {
    if (state.firstAt === null) state.firstAt = at
    state.lastAt = at
  }
  if (event.type === 'llm/retry-started') {
    const data = event.data ?? {}
    if (state.last !== null && state.last.turn === data.turn && state.last.step === data.step) state.last = null
    return state
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  const usage = usageOf(event)
  if (usage === undefined) return state
  const { provider, model } = routeOf(event)
  const key = `${provider}\u0000${model}`
  const route = state.routes[key] ??= { provider, model, ...emptyPeriods() }
  const data = event.data ?? {}
  const period = isPeak(at ?? 0) ? 'peak' : 'offPeak'
  const previous = state.last !== null && state.last.turn === data.turn && state.last.step === data.step
    ? state.last
    : undefined
  if (previous !== undefined) subtractFrom(state.routes[previous.key][previous.period], previous.usage)
  addInto(route[period], usage)
  state.last = { key, period, turn: data.turn, step: data.step, usage }
  state.events += 1
  state.billed += 1
  return state
}

/**
 * 把一段事件序列折叠进状态。
 * @param {object} state - 状态。
 * @param {Iterable<object>} events - 事件序列。
 * @returns {object} 同一个状态对象。
 */
export function foldEvents(state, events) {
  for (const event of events) foldEvent(state, event)
  return state
}

/**
 * 把一份路由桶合并进另一份（跨会话汇总用：每份各自折叠，最后相加）。
 * @param {object} target - 目标路由表，原地累加。
 * @param {object} source - 来源路由表。
 * @returns {object} 目标路由表。
 */
export function mergeUsageStates(target, source) {
  for (const [key, route] of Object.entries(source)) {
    const bucket = target[key] ??= { provider: route.provider, model: route.model, ...emptyPeriods() }
    for (const period of ['peak', 'offPeak']) {
      for (const field of ['uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'total', 'calls']) {
        bucket[period][field] += route[period]?.[field] ?? 0
      }
    }
  }
  return target
}

/**
 * 用会话对象把状态推进到最新（只处理未消费的事件序号）。
 *
 * 会话对象只需满足 `{ seq: number, eventAt(seq): object|undefined }`，
 * 与 `ctx.sessions.get(id)` 返回的 Session 一致。
 * @param {object} state - 状态。
 * @param {object} session - 会话。
 * @param {number} [budget] - 单次调用最多消费的事件数；超出的部分留到下次调用，
 *   避免超长日志在新装上首次读取时长时间占用事件循环。
 * @returns {number} 本次新消费的事件数。
 */
export function consumeSession(state, session, budget = 20000) {
  if (session === null || typeof session !== 'object') return 0
  const total = Number(session.seq)
  if (!Number.isSafeInteger(total)) return 0
  const limit = Number.isSafeInteger(budget) && budget > 0 ? budget : 20000
  let consumed = 0
  while (state.seq < total && consumed < limit) {
    const event = session.eventAt(state.seq)
    state.seq += 1
    consumed += 1
    if (event !== undefined) foldEvent(state, event)
  }
  return consumed
}
