/** 「今日消费」跨会话统计的单元测试：窗口计算、日志读取、按目录取最新、文件缓存。 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { collectWindowUsage, dayWindow, listWindowLogs, readLogRows } from '../lib/session-log.js'
import { isPeak, summarizeCost } from '../lib/pricing.js'
import { createUsageState, mergeUsageStates } from '../lib/usage-fold.js'

/** 造一条结算事件的 JSONL 行；`at` 可显式指定 turn/step（用于验证覆盖规则）。 */
function settlement(seq, time, tokens, at = {}) {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: at.turn ?? 0,
      step: at.step ?? seq,
      usage: {
        inputTokens: tokens.input ?? 0,
        outputTokens: tokens.output ?? 0,
        cacheReadTokens: tokens.cacheRead ?? 0,
        cacheWriteTokens: 0,
        totalTokens: (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0),
      },
      message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
    },
  })
}

/** 在临时目录里搭一个会话根：workspace/session/log。 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'session-cost-'))
  const add = (workspace, session, file, lines, mtimeMs) => {
    const dir = join(root, workspace, session)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, file)
    writeFileSync(path, `${lines.join('\n')}\n`)
    if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
    return path
  }
  return { root, add, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('dayWindow 按给定时区切出「今日」', () => {
  // 北京 2026-09-25 23:59:59 = UTC 15:59:59，窗口起点应为北京 00:00（UTC 前一天 16:00）。
  const late = Date.UTC(2026, 8, 25, 15, 59, 59)
  const window = dayWindow(late, 480)
  assert.equal(window.start, Date.UTC(2026, 8, 24, 16, 0, 0))
  assert.equal(window.end, Date.UTC(2026, 8, 25, 16, 0, 0))
  assert.equal(window.label, 'UTC+8')
  assert.ok(late >= window.start && late < window.end)

  // 北京时间刚过零点：属于新的一天。
  const justAfter = Date.UTC(2026, 8, 25, 16, 0, 1)
  assert.equal(dayWindow(justAfter, 480).start, Date.UTC(2026, 8, 25, 16, 0, 0))

  // UTC 与半小时时区。
  assert.equal(dayWindow(late, 0).start, Date.UTC(2026, 8, 25, 0, 0, 0))
  assert.equal(dayWindow(late, 0).label, 'UTC+0')
  assert.equal(dayWindow(late, 330).label, 'UTC+5:30')
  assert.equal(dayWindow(late, -300).label, 'UTC-5')
  // 非法值退回北京时区。
  assert.equal(dayWindow(late, Number.NaN).label, 'UTC+8')
})

test('readLogRows 同时支持纯文本与多帧 zstd', () => {
  const { root, add, cleanup } = makeRoot()
  try {
    const plain = add('--w--', 'session-1', 'session.jsonl', [settlement(0, 1, { input: 5 })])
    assert.equal(readLogRows(plain).length, 1)

    // 两帧拼接：覆盖逐帧解压的路径。
    const dir = join(root, '--w--', 'session-2')
    mkdirSync(dir, { recursive: true })
    const multi = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(multi, Buffer.concat([
      zstdCompressSync(Buffer.from(`${settlement(0, 1, { input: 1 })}\n`)),
      zstdCompressSync(Buffer.from(`${settlement(1, 2, { input: 2 })}\n${settlement(2, 3, { input: 3 })}\n`)),
    ]))
    assert.equal(readLogRows(multi).length, 3)
  } finally {
    cleanup()
  }
})

test('每个会话目录只取最新一份日志（多代格式并存时）', () => {
  const { root, add, cleanup } = makeRoot()
  const now = Date.now()
  try {
    add('--w--', 'session-a', 'session.v3.jsonl', [settlement(0, now, { input: 1 })], now - 60_000)
    add('--w--', 'session-a', 'session.v4.jsonl', [settlement(0, now, { input: 1 }), settlement(1, now, { input: 1 })], now)
    add('--w--', 'session-b', 'session.jsonl', [settlement(0, now, { input: 1 })], now)
    const listing = listWindowLogs(root, now - 3600_000)
    assert.equal(listing.files.length, 2, '同一目录只应产出一份日志')
    assert.deepEqual(listing.files.map(file => file.path.split('/').pop()).sort(), ['session.jsonl', 'session.v4.jsonl'])
  } finally {
    cleanup()
  }
})

test('mtime 早于窗口起点的日志被跳过，不读取内容', () => {
  const { root, add, cleanup } = makeRoot()
  const dayStart = Date.now() - 3600_000
  try {
    add('--w--', 'session-old', 'session.jsonl', [settlement(0, dayStart + 60_000, { input: 1 })], dayStart - 86_400_000)
    add('--w--', 'session-new', 'session.jsonl', [settlement(0, dayStart + 60_000, { input: 1 })], dayStart + 60_000)
    const listing = listWindowLogs(root, dayStart)
    assert.equal(listing.files.length, 1)
    assert.equal(listing.skippedOld, 1)
  } finally {
    cleanup()
  }
})

test('只统计窗口内的结算，并按峰谷计价（跨会话相加）', () => {
  const { root, add, cleanup } = makeRoot()
  const now = Date.now()
  const window = dayWindow(now, 480)
  const inside = window.start + 3_600_000
  try {
    // 会话 A：窗口内 2 条同 (turn, step) 的结算（后写覆盖先写，只算 1 次 1M），
    // 另有 1 条 9M 落在窗口外（必须完全不计）。
    add('--w--', 'session-a', 'session.v4.jsonl', [
      settlement(0, inside, { input: 1_000_000 }, { turn: 0, step: 0 }),
      settlement(1, inside, { input: 1_000_000 }, { turn: 0, step: 0 }),
      settlement(2, window.start - 60_000, { input: 9_000_000 }, { turn: 1, step: 0 }),
    ], now)
    // 会话 B：窗口内 1 条。
    add('--w--', 'session-b', 'session.jsonl', [settlement(0, inside, { input: 1_000_000 })], now)

    const collected = collectWindowUsage({ root, windowStart: window.start, windowEnd: window.end })
    const cost = summarizeCost(collected.routes, { currency: 'CNY', prices: {} })
    // 两条 1M 未命中（窗口外那条不计）：高峰 2 元/1M，低谷减半。
    const factor = isPeak(inside) ? 1 : 0.5
    assert.equal(cost.amount, 2 * 2 * factor)
    assert.equal(collected.files, 2)
    assert.equal(collected.parsed, 2)
  } finally {
    cleanup()
  }
})

test('文件级缓存：内容未变时第二轮不再重新解析，变了才重解析', () => {
  const { root, add, cleanup } = makeRoot()
  const now = Date.now()
  const window = dayWindow(now, 480)
  const inside = window.start + 3_600_000
  let path
  try {
    path = add('--w--', 'session-a', 'session.jsonl', [settlement(0, inside, { input: 1_000_000 })], now)
    const cache = new Map()
    const first = collectWindowUsage({ root, windowStart: window.start, windowEnd: window.end, cache })
    assert.equal(first.parsed, 1)
    const second = collectWindowUsage({ root, windowStart: window.start, windowEnd: window.end, cache })
    assert.equal(second.parsed, 0, '未变化的文件不应重新解析')
    assert.equal(second.files, 1)

    // 追加一条并推进 mtime：应重新解析且金额翻倍。
    writeFileSync(path, `${settlement(0, inside, { input: 1_000_000 })}\n${settlement(1, inside, { input: 1_000_000 })}\n`)
    const later = now + 5000
    utimesSync(path, later / 1000, later / 1000)
    const third = collectWindowUsage({ root, windowStart: window.start, windowEnd: window.end, cache })
    assert.equal(third.parsed, 1)
    const factor = isPeak(inside) ? 1 : 0.5
    assert.equal(summarizeCost(third.routes, { currency: 'CNY', prices: {} }).amount, 2 * 2 * factor)
  } finally {
    cleanup()
  }
})

test('会话根不存在时安静失败', () => {
  const collected = collectWindowUsage({
    root: join(tmpdir(), 'session-cost-does-not-exist-12345'),
    windowStart: 0,
    windowEnd: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(collected.missing, true)
  assert.equal(collected.files, 0)
})

test('未配置单价的模型在今日统计里单独列出', () => {
  const { root, add, cleanup } = makeRoot()
  const now = Date.now()
  const window = dayWindow(now, 480)
  try {
    const line = JSON.stringify({
      type: 'assistant/message',
      seq: 0,
      time: window.start + 60_000,
      data: {
        turn: 0, step: 0,
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        message: { source: { kind: 'model', provider: 'magpie', model: 'some-unknown-model' } },
      },
    })
    add('--w--', 'session-a', 'session.jsonl', [line], now)
    const collected = collectWindowUsage({ root, windowStart: window.start, windowEnd: window.end })
    const cost = summarizeCost(collected.routes, { currency: 'CNY', prices: {} })
    assert.equal(cost.priced, false)
    assert.deepEqual(cost.unpriced.map(route => route.model), ['some-unknown-model'])
  } finally {
    cleanup()
  }
})

test('mergeUsageStates 逐桶相加且不改动来源', () => {
  const source = {
    'p\u0000m': {
      provider: 'p', model: 'm',
      peak: { uncachedInput: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 0, calls: 5 },
      offPeak: { uncachedInput: 10, cacheRead: 20, cacheWrite: 30, output: 40, total: 0, calls: 50 },
    },
  }
  const target = {}
  mergeUsageStates(target, source)
  mergeUsageStates(target, source)
  assert.deepEqual(target['p\u0000m'].peak, { uncachedInput: 2, cacheRead: 4, cacheWrite: 6, output: 8, total: 0, calls: 10 })
  assert.equal(target['p\u0000m'].offPeak.uncachedInput, 20)
  assert.equal(source['p\u0000m'].peak.uncachedInput, 1, '来源不应被改动')

  // 空状态也能安全相加。
  const empty = createUsageState()
  assert.deepEqual(mergeUsageStates({}, empty.routes), {})
})
