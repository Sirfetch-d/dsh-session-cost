/** 价目表与金额计算的单元测试。 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  BUILTIN_PRICES, buildPriceTable, emptyPeriods, emptyTokens, formatAmount, formatTokens,
  isPeak, normalizeModel, priceTokens, resolvePrice, rollupRoutes, summarizeCost,
} from '../lib/pricing.js'

test('isPeak 只认工作日 UTC 01:00–04:00 与 06:00–10:00', () => {
  // 2026-09-25 是周五。
  assert.equal(isPeak(Date.UTC(2026, 8, 25, 2, 0)), true)
  assert.equal(isPeak(Date.UTC(2026, 8, 25, 7, 30)), true)
  assert.equal(isPeak(Date.UTC(2026, 8, 25, 5, 0)), false)
  assert.equal(isPeak(Date.UTC(2026, 8, 25, 12, 0)), false)
  // 2026-09-26/27 是周末，全天低谷。
  assert.equal(isPeak(Date.UTC(2026, 8, 26, 2, 0)), false)
  assert.equal(isPeak(Date.UTC(2026, 8, 27, 7, 0)), false)
  // 边界：04:00 与 10:00 已经是低谷。
  assert.equal(isPeak(Date.UTC(2026, 8, 25, 4, 0)), false)
  assert.equal(isPeak(Date.UTC(2026, 8, 25, 10, 0)), false)
})

test('normalizeModel 去掉 provider 前缀与日期后缀', () => {
  assert.equal(normalizeModel('deepseek-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('DeepSeek-V4-Pro-0813'), 'deepseek-v4-pro')
  assert.equal(normalizeModel('opencode-go/deepseek-v4.1-flash'), 'deepseek-v4.1-flash')
  assert.equal(normalizeModel(''), '')
})

test('resolvePrice 按 provider/model → model → 归一化名 → * 顺序命中', () => {
  const table = buildPriceTable('CNY', { 'magpie/deepseek-v4.1-flash': { outputPer1M: 1 } })
  assert.equal(resolvePrice(table, 'deepseek-official', 'deepseek-flash').key, 'deepseek-flash')
  assert.equal(resolvePrice(table, 'magpie', 'deepseek-v4.1-flash').key, 'magpie/deepseek-v4.1-flash')
  assert.equal(resolvePrice(table, 'other', 'deepseek-v4-pro-0813').key, 'deepseek-v4-pro')
  assert.equal(resolvePrice(table, 'other', 'unknown-model'), undefined)
  assert.equal(resolvePrice(buildPriceTable('CNY', { '*': { outputPer1M: 2 } }), 'x', 'y').key, '*')
})

test('priceTokens 高峰按表价、低谷打折，缓存读写分价', () => {
  const price = { cacheHitPer1M: 0.04, cacheMissPer1M: 2, outputPer1M: 8, offPeakFactor: 0.5 }
  const peak = priceTokens({ uncachedInput: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 }, price, true)
  assert.equal(peak.amount, 0.04 + 2 + 8)
  const off = priceTokens({ uncachedInput: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 }, price, false)
  assert.equal(off.amount, (0.04 + 2 + 8) / 2)
  // 缓存写入按未命中价计。
  const write = priceTokens({ uncachedInput: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }, price, true)
  assert.equal(write.amount, 2)
})

/** 构造只填一个时段的路由桶（另一时段全 0）。 */
function periodOnly(period, tokens) {
  const buckets = {
    peak: { ...emptyTokens() },
    offPeak: { ...emptyTokens() },
  }
  const target = buckets[period]
  for (const [key, value] of Object.entries(tokens)) target[key] = value
  target.calls = 1
  target.total = target.uncachedInput + target.cacheRead + target.cacheWrite + target.output
  return buckets
}

test('summarizeCost 分时段计价并汇总，未配置单价的模型单独列出', () => {
  const routes = {
    'deepseek-official\u0000deepseek-flash': {
      provider: 'deepseek-official', model: 'deepseek-flash', ...emptyPeriods(),
    },
    'magpie\u0000deepseek-v4.1-flash': {
      provider: 'magpie', model: 'deepseek-v4.1-flash', ...emptyPeriods(),
    },
  }
  const flash = routes['deepseek-official\u0000deepseek-flash']
  flash.peak.cacheRead = 1e6
  flash.peak.calls = 1
  flash.offPeak.cacheRead = 1e6
  flash.offPeak.calls = 1
  routes['magpie\u0000deepseek-v4.1-flash'].peak.output = 1e6

  const result = summarizeCost(routes, { currency: 'CNY', prices: {} })
  assert.equal(result.priced, false)
  assert.equal(result.amount, 0.04 + 0.02)
  assert.deepEqual(result.unpriced.map(route => route.model), ['deepseek-v4.1-flash'])
  const flashRow = result.routes.find(route => route.model === 'deepseek-flash')
  assert.equal(flashRow.tokens.cacheRead, 2e6)
  assert.equal(flashRow.tokens.total, 2e6)
  // 面板要交代「钱是怎么算的」，所以响应里带实际生效的单价。
  assert.deepEqual(flashRow.rates, {
    cacheHitPer1M: 0.04, cacheMissPer1M: 2, cacheWritePer1M: 2, outputPer1M: 8,
    offPeakFactor: 0.5, currency: 'CNY',
  })
  const unpricedRow = result.routes.find(route => route.model === 'deepseek-v4.1-flash')
  assert.equal(unpricedRow.rates, null, '未配置单价的路由不带 rates')

  const withDefault = summarizeCost(routes, {
    currency: 'CNY',
    prices: {},
    defaultPrice: { cacheHitPer1M: 0, cacheMissPer1M: 0, outputPer1M: 10 },
  })
  assert.equal(withDefault.priced, true)
  assert.equal(Math.round(withDefault.amount * 1e6) / 1e6, 0.06 + 10)
})

test('内置表的峰谷系数与官方一致', () => {
  for (const currency of Object.keys(BUILTIN_PRICES)) {
    for (const price of Object.values(BUILTIN_PRICES[currency])) {
      assert.equal(typeof price.cacheHitPer1M, 'number')
      assert.equal(typeof price.cacheMissPer1M, 'number')
      assert.equal(typeof price.outputPer1M, 'number')
    }
  }
  const table = buildPriceTable('USD', {})
  assert.equal(table.get('deepseek-flash').offPeakFactor, 0.5)
})

test('金额与 token 格式化', () => {
  assert.equal(formatAmount(0, 'CNY'), '¥0.00')
  assert.equal(formatAmount(0.0042, 'CNY'), '¥0.0042')
  assert.equal(formatAmount(0.4213, 'CNY'), '¥0.421')
  assert.equal(formatAmount(12.345, 'USD'), '$12.35')
  assert.equal(formatAmount(Number.NaN, 'CNY'), '¥—')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(12345), '12k')
  assert.equal(formatTokens(7033633), '7.0M')
})

test('OpenCode Go 价目按 USD 表命中，并区分路由写法', () => {
  // 文档 https://opencode.ai/v2/docs/console/go 「Usage limits」：
  // DeepSeek V4.1 Flash 高峰 输入 0.30 / 输出 1.20 / 命中 0.006（USD / 1M）。
  const viaModelPrefix = summarizeCost({
    a: {
      provider: 'deepseek-official', model: 'opencode-go/deepseek-v4.1-flash',
      ...periodOnly('peak', { uncachedInput: 1e6, output: 1e6 }),
    },
  }, { currency: 'USD', prices: {} })
  assert.equal(viaModelPrefix.amount, 0.30 + 1.20, 'model 前缀写法应命中')
  assert.deepEqual(viaModelPrefix.unpriced, [])

  const viaProvider = summarizeCost({
    b: {
      provider: 'opencode-go', model: 'deepseek-v4.1-flash',
      ...periodOnly('peak', { uncachedInput: 1e6, output: 1e6 }),
    },
  }, { currency: 'USD', prices: {} })
  assert.equal(viaProvider.amount, 0.30 + 1.20, 'provider=opencode-go 写法应命中同一价目')

  // 低谷档是高峰的一半（文档的 Off-Peak 行）。
  const offPeak = summarizeCost({
    c: {
      provider: 'opencode-go', model: 'deepseek-v4.1-flash',
      ...periodOnly('offPeak', { uncachedInput: 1e6, output: 1e6 }),
    },
  }, { currency: 'USD', prices: {} })
  assert.equal(Math.round(offPeak.amount * 1e6) / 1e6, 0.15 + 0.60)

  // 不污染别的 provider 的同名模型：DeepSeek 官方自己的表另有单价。
  const official = summarizeCost({
    d: {
      provider: 'deepseek-official', model: 'deepseek-flash',
      ...periodOnly('peak', { uncachedInput: 1e6 }),
    },
  }, { currency: 'USD', prices: {} })
  assert.equal(official.amount, 0.30, '官方的 deepseek-flash 单价不应被 opencode-go 覆盖')
})

test('缓存写入单价单独给定时按它计，否则回落到未命中价', () => {
  // MiniMax M2.7：输入 0.30 / 输出 1.20 / 命中 0.06 / 写出 0.375（USD / 1M）。
  const given = priceTokens(
    { uncachedInput: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 },
    BUILTIN_PRICES.USD['opencode-go/minimax-m2.7'], true,
  )
  assert.equal(given.amount, 0.375)

  // DeepSeek 不单独收缓存写入费 → 用未命中价。
  const fallback = priceTokens(
    { uncachedInput: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 },
    BUILTIN_PRICES.USD['deepseek-flash'], true,
  )
  assert.equal(fallback.amount, 0.30)
})

test('展示币种是 CNY 时，USD 价目要汇率才折算，缺汇率如实标记', () => {
  const routes = {
    a: {
      provider: 'opencode-go', model: 'deepseek-v4.1-flash',
      ...periodOnly('peak', { uncachedInput: 1e6, output: 1e6 }),
    },
  }
  const noRate = summarizeCost(routes, { currency: 'CNY', prices: {} })
  assert.equal(noRate.priced, false)
  // 缺汇率时总额整体回落到原生币种，而不是报一个与明细矛盾的 ¥0.00。
  assert.equal(noRate.nativeTotal, true)
  assert.equal(noRate.currency, 'USD')
  assert.equal(Math.round(noRate.amount * 1e6) / 1e6, 1.5)
  assert.equal(noRate.unpriced.length, 1)
  assert.equal(noRate.unpriced[0].reason, 'fx', '缺的是汇率，不是缺单价')
  assert.equal(noRate.unpriced[0].tokens.uncachedInput, 1e6, '未定价也要给出 token 数')
  // 但金额本身照算，只是标成原生美元：用户零配置也能看到 opencode-go 花了多少。
  assert.equal(Math.round(noRate.routes[0].native.amount * 1e6) / 1e6, 1.5)
  assert.equal(noRate.routes[0].native.currency, 'USD')
  assert.equal(noRate.routes[0].amount, null, '路由本身没折进展示币种')
  assert.equal(noRate.byProvider[0].native.currency, 'USD', '供应商汇总也要带上原生金额')
  assert.equal(Math.round(noRate.byProvider[0].native.amount * 1e6) / 1e6, 1.5)

  const withRate = summarizeCost(routes, { currency: 'CNY', prices: {}, usdToCny: 7.1 })
  assert.equal(withRate.priced, true)
  assert.equal(Math.round(withRate.amount * 1e4) / 1e4, Math.round((0.30 + 1.20) * 7.1 * 1e4) / 1e4)
  assert.equal(withRate.converted, true)
  assert.equal(withRate.routes[0].converted, true, '面板据此加 ≈')
  assert.equal(withRate.routes[0].native, null, '折进来之后就不该再有原生金额')

  // 原生 CNY 计价 + 折算 USD 混在一起时标 partial（总价不是纯原生计价）。
  const mixed = summarizeCost({
    ...routes,
    b: { provider: 'deepseek-official', model: 'deepseek-flash', ...periodOnly('peak', { uncachedInput: 1e6 }) },
  }, { currency: 'CNY', prices: {}, usdToCny: 7.1 })
  assert.equal(mixed.partial, true)
  assert.equal(Math.round(mixed.amount * 1e4) / 1e4, Math.round((2 + 1.5 * 7.1) * 1e4) / 1e4)
})

test('rollupRoutes 按模型与供应商分别汇总（同模型跨供应商合并）', () => {
  const routes = {
    a: { provider: 'deepseek-official', model: 'opencode-go/deepseek-v4.1-flash', ...periodOnly('peak', { uncachedInput: 1e6, output: 1e6 }) },
    b: { provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash', ...periodOnly('peak', { uncachedInput: 3e6 }) },
    c: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', ...periodOnly('peak', { output: 2e6 }) },
  }
  const result = summarizeCost(routes, { currency: 'USD', prices: {} })
  const byModel = result.byModel
  assert.deepEqual(byModel.map(row => row.key).sort(), ['deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash'])
  const merged = byModel.find(row => row.key === 'opencode-go/deepseek-v4.1-flash')
  assert.equal(merged.tokens.uncachedInput, 4e6, '同一个模型跨供应商要合并')
  assert.equal(merged.tokens.output, 1e6)
  assert.equal(merged.priced, true)

  const byProvider = result.byProvider
  assert.deepEqual(byProvider.map(row => row.key).sort(), ['deepseek-official', 'magpie', 'opencode-go'])
  assert.equal(byProvider.find(row => row.key === 'magpie').tokens.uncachedInput, 3e6)

  // 金额降序：条目按金额从高到低排，便于一眼看到大头。
  const amounts = byProvider.map(row => row.amount)
  assert.deepEqual(amounts, [...amounts].sort((left, right) => right - left))
})

test('汇总里混入未定价路由时，该组金额是下界且 priced=false', () => {
  const result = summarizeCost({
    a: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', ...periodOnly('peak', { uncachedInput: 1e6 }) },
    b: { provider: 'opencode-go', model: 'unknown-model-xyz', ...periodOnly('peak', { uncachedInput: 2e6 }) },
  }, { currency: 'USD', prices: {} })
  const provider = result.byProvider.find(row => row.key === 'opencode-go')
  assert.equal(provider.priced, false, '组内有不定价路由时不能声称金额完整')
  assert.equal(provider.amount, 0.30, '金额只累加已定价的部分')
  assert.deepEqual(result.unpriced.map(entry => entry.model), ['unknown-model-xyz'])
  assert.equal(result.unpriced[0].reason, 'missing')
})
