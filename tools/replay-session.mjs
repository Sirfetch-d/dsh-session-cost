/**
 * 开发工具：把一个真实的会话日志（zstd 分帧 JSONL）喂给折叠引擎，打印 token 与
 * 金额，并用一份「独立实现」的朴素求和交叉校验，确保折叠口径没有算错或漏算。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "$NODE" tools/replay-session.mjs \
 *     ~/.dsh/sessions/<dir>/<session>/session.v4.jsonl.zstd [CNY|USD]
 *
 * `$NODE` 用 DSH 自带运行时：~/.dsh/dsh-runtimes/<runtime>/dependencies/node/bin/node
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { createUsageState, consumeSession } from '../lib/usage-fold.js'
import { summarizeCost, formatAmount, isPeak } from '../lib/pricing.js'

/** 按 zstd magic 切帧并解出全部 JSONL 行。 */
function readLog(file) {
  const data = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let at = data.indexOf(magic); at !== -1; at = data.indexOf(magic, at + 1)) offsets.push(at)
  const rows = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : data.length
    let text
    try { text = zstdDecompressSync(data.subarray(start, end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
  }
  return rows
}

/** 独立实现：按 (turn, step) 后写覆盖先写，逐条累加。 */
function naiveTotals(events) {
  const slots = new Map()
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = event.data?.usage
    if (usage === undefined) continue
    const source = event.data?.message?.source ?? {}
    const key = `${event.data?.turn}:${event.data?.step}`
    slots.set(key, {
      provider: source.provider ?? '', model: source.model ?? '',
      period: isPeak(event.time ?? 0) ? 'peak' : 'offPeak',
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    })
  }
  const totals = { peak: 0, offPeak: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: slots.size }
  for (const slot of slots.values()) {
    const sum = slot.inputTokens + slot.outputTokens + slot.cacheReadTokens + slot.cacheWriteTokens
    totals[slot.period] += sum
    totals.input += slot.inputTokens
    totals.output += slot.outputTokens
    totals.cacheRead += slot.cacheReadTokens
    totals.cacheWrite += slot.cacheWriteTokens
  }
  return totals
}

const file = process.argv[2]
const currency = process.argv[3] ?? 'CNY'
if (file === undefined) {
  console.error('usage: replay-session.mjs <session.jsonl.zstd> [CNY|USD]')
  process.exit(2)
}
const rows = readLog(file)
const events = rows.filter(row => typeof row.type === 'string' && Number.isSafeInteger(row.seq))
const session = { seq: events.length, eventAt: seq => events[seq] }
const state = createUsageState()
consumeSession(state, session)
const cost = summarizeCost(state.routes, { currency, prices: {} })
const naive = naiveTotals(events)

const folded = { peak: 0, offPeak: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
for (const route of Object.values(state.routes)) {
  for (const period of ['peak', 'offPeak']) {
    folded[period] += route[period].uncachedInput + route[period].output + route[period].cacheRead + route[period].cacheWrite
  }
  folded.input += route.peak.uncachedInput + route.offPeak.uncachedInput
  folded.output += route.peak.output + route.offPeak.output
  folded.cacheRead += route.peak.cacheRead + route.offPeak.cacheRead
  folded.cacheWrite += route.peak.cacheWrite + route.offPeak.cacheWrite
  folded.calls += route.peak.calls + route.offPeak.calls
}

console.log(`file            ${file}`)
console.log(`events          ${events.length} (结算 ${folded.calls})`)
console.log(`tokens          in=${folded.input} cacheRead=${folded.cacheRead} cacheWrite=${folded.cacheWrite} out=${folded.output}`)
console.log(`peak/offPeak    ${folded.peak} / ${folded.offPeak}`)
console.log(`amount (${currency})  ${formatAmount(cost.amount, currency)}${cost.priced ? '' : ' (含未配置单价的模型)'}`)
for (const route of cost.routes) {
  console.log(`  - ${route.provider}/${route.model}: ${route.tokens.total} tok, ${route.amount === null ? '未配置单价' : formatAmount(route.amount, currency)}`)
}
let mismatches = 0
for (const key of Object.keys(naive)) {
  if (naive[key] !== folded[key]) {
    mismatches += 1
    console.log(`MISMATCH ${key}: fold=${folded[key]} naive=${naive[key]}`)
  }
}
console.log(mismatches === 0 ? 'CHECK ok — 折叠结果与独立求和一致' : `CHECK FAILED — ${mismatches} 处不一致`)
process.exit(mismatches === 0 ? 0 : 1)
