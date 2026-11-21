/**
 * 开发工具：直接对真实会话目录跑一遍「今日消费」统计，打印明细，便于核对。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "<node>" tools/today-scan.mjs [会话根目录] [CNY|USD] [时区偏移分钟] [usdToCny]
 * 默认：~/.dsh/sessions、CNY、480（北京）、不配汇率（美元价目的模型只给原生金额）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collectWindowUsage, dayWindow } from '../lib/session-log.js'
import { formatAmount, summarizeCost } from '../lib/pricing.js'

const root = process.argv[2] ?? join(homedir(), '.dsh', 'sessions')
const currency = process.argv[3] ?? 'CNY'
const offsetMinutes = Number(process.argv[4] ?? 480)
const usdToCny = process.argv[5] === undefined ? undefined : Number(process.argv[5])

const window = dayWindow(Date.now(), offsetMinutes)
const collected = collectWindowUsage({ root, windowStart: window.start, windowEnd: window.end })
const cost = summarizeCost(collected.routes, { currency, prices: {}, usdToCny })

console.log(`root          ${root}`)
console.log(`window        ${new Date(window.start).toISOString()} → ${new Date(window.end).toISOString()}  (${window.label})`)
console.log(`sessions      ${collected.files} 个${collected.truncated ? '（已截断）' : ''}，解析 ${collected.parsed} 个，跳过旧文件 ${collected.skippedOld} 个`)
console.log(`bytes         ${(collected.bytes / 1024).toFixed(0)} KiB`)
// 用 cost.currency（生效币种）而不是配置币种：缺汇率时总额会整体回落到原生币种。
console.log(`amount (${cost.currency})  ${formatAmount(cost.amount, cost.currency)}${cost.priced ? '' : '（含未计入的模型）'}${cost.partial ? '  ≈（含折算）' : ''}${cost.nativeTotal ? '  [原生币种合计]' : ''}`)
console.log(`usdToCny      ${usdToCny === undefined || !Number.isFinite(usdToCny) ? '未配置（美元价目的模型只显示原生金额）' : usdToCny}`)
for (const route of cost.routes) {
  const money = route.amount !== null
    ? formatAmount(route.amount, currency)
    : route.native === null ? '未配置单价' : `${formatAmount(route.native.amount, route.native.currency)}（原本币种，未计入合计）`
  const rates = route.rates === null
    ? ''
    : ` [单价 ${route.rates.cacheHitPer1M}/${route.rates.cacheMissPer1M}/${route.rates.outputPer1M}${route.rates.cacheWritePer1M === route.rates.cacheMissPer1M ? '' : `/${route.rates.cacheWritePer1M}`} ${route.rates.currency}]`
  console.log(`  - ${route.provider}/${route.model}: ${route.tokens.total} tok, ${money}${rates}`)
}
for (const [label, list] of [['按模型', cost.byModel], ['按供应商', cost.byProvider]]) {
  console.log(`${label}`)
  for (const row of list) {
    const money = row.amount !== null
      ? formatAmount(row.amount, cost.currency)
      : row.native === null ? '—' : `${formatAmount(row.native.amount, row.native.currency)}（原生币种）`
    console.log(`  ${row.key}: ${row.tokens.total} tok, ${money}${row.priced ? '' : ' *下界'}`)
  }
}
if (cost.unpriced.length > 0) {
  for (const entry of cost.unpriced) console.log(`unpriced      ${entry.provider}/${entry.model} (${entry.reason})`)
}
