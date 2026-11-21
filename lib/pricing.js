/**
 * 内置价目表与计费计算（纯函数，可在 Node 下单测）。
 *
 * 单价按「每 100 万 token」计。两张表分别定价、互不换算：
 *
 * - **DeepSeek 官方**（CNY / USD）按官方定价页，峰谷时段以 UTC 判定（高峰 = 周一至
 *   周五 01:00–04:00 与 06:00–10:00，其余为低谷，低谷为高峰的 50%）；
 * - **OpenCode Go**（仅 USD）按官方「Usage limits」页公布的 token 价目——那是订阅套餐
 *   的**额度计价口径**（月度额度以内不另外按 token 收费），不是每调用一次就扣多少钱。
 *   其中 DeepSeek 系模型官方给了峰谷两档，这里换算成「高峰价 + offPeakFactor 0.5」。
 *
 * 币种与折算：展示币种是 CNY 时，只有 USD 价目的模型需要 `usdToCny` 汇率才计入金额；
 * 没配汇率就只显示 token，并在响应里标成需要折算（不猜汇率）。
 *
 * `usage.inputTokens` 是**未命中缓存**的输入（harness 语义），`cacheReadTokens`
 * 是命中缓存的输入，`cacheWriteTokens` 是写入缓存；三者单价可分别给定。
 * `cacheWritePer1M` 缺省时按未命中价计（DeepSeek 不单独收缓存写入费，按未命中计价
 * 不会低估）。
 *
 * @module dsh-session-cost/pricing
 */

/** 高峰时段的 UTC 小时区间（左闭右开），周一至周五生效。 */
export const PEAK_UTC_WINDOWS = [[1, 4], [6, 10]]

/** 低谷折扣系数。 */
export const OFF_PEAK_FACTOR = 0.5

/**
 * OpenCode Go 公布的 token 价目（USD / 1M token），键是**模型 id**（见文档的 Model ID 表）。
 *
 * 来源：https://opencode.ai/v2/docs/console/go 「Usage limits」——订阅套餐用这套价把用量
 * 折算成额度消耗（Go $10/月、Go Plus $40/月，两档 token 价相同，只有月度额度不同）。
 *
 * 两处已知近似（README 也记着）：
 * - 分上下文档位的模型（`> 256K` / `> 200K` / `> 272K`）只取 ≤ 档，超大上下文会低估；
 * - 免费模型直接记 0。
 */
const OPENCODE_GO_USD = {
  'glm-5.3-flash': { cacheHitPer1M: 0.03, cacheMissPer1M: 0.15, outputPer1M: 0.50 },
  'glm-5.3': { cacheHitPer1M: 0.26, cacheMissPer1M: 1.40, outputPer1M: 4.40 },
  'glm-5.2': { cacheHitPer1M: 0.26, cacheMissPer1M: 1.40, outputPer1M: 4.40 },
  'kimi-k3': { cacheHitPer1M: 0.30, cacheMissPer1M: 3.00, outputPer1M: 15.00 },
  'kimi-k2.7-code': { cacheHitPer1M: 0.19, cacheMissPer1M: 0.95, outputPer1M: 4.00 },
  'kimi-k2.6': { cacheHitPer1M: 0.16, cacheMissPer1M: 0.95, outputPer1M: 4.00 },
  'longcat-2.0': { cacheHitPer1M: 0.006, cacheMissPer1M: 0.30, outputPer1M: 1.20 },
  'longcat-2.5-preview-free': { cacheHitPer1M: 0, cacheMissPer1M: 0, outputPer1M: 0 },
  'mimo-v2.6-flash': { cacheHitPer1M: 0.0028, cacheMissPer1M: 0.14, outputPer1M: 0.28 },
  'mimo-v2.6-pro': { cacheHitPer1M: 0.003625, cacheMissPer1M: 0.435, outputPer1M: 0.87 },
  'mimo-v2.5': { cacheHitPer1M: 0.0028, cacheMissPer1M: 0.14, outputPer1M: 0.28 },
  'mimo-v2.5-pro': { cacheHitPer1M: 0.003625, cacheMissPer1M: 0.435, outputPer1M: 0.87 },
  'minimax-m3': { cacheHitPer1M: 0.06, cacheMissPer1M: 0.30, outputPer1M: 1.20 },
  'minimax-m2.7': { cacheHitPer1M: 0.06, cacheMissPer1M: 0.30, outputPer1M: 1.20, cacheWritePer1M: 0.375 },
  'muse-spark-1.3-contributor': { cacheHitPer1M: 0.002, cacheMissPer1M: 0.10, outputPer1M: 0.20 },
  'muse-spark-1.2-contributor': { cacheHitPer1M: 0.002, cacheMissPer1M: 0.10, outputPer1M: 0.20 },
  'qwen3.8-max': { cacheHitPer1M: 0.25, cacheMissPer1M: 2.00, outputPer1M: 6.00, cacheWritePer1M: 2.50 },
  'qwen3.8-flash': { cacheHitPer1M: 0.016, cacheMissPer1M: 0.15, outputPer1M: 0.47, cacheWritePer1M: 0.20 },
  // 「> 256K tokens」档（输入 1.20 / 输出 4.80 / 命中 0.12 / 写出 1.50）未区分，取 ≤ 档。
  'qwen3.7-plus': { cacheHitPer1M: 0.04, cacheMissPer1M: 0.40, outputPer1M: 1.60, cacheWritePer1M: 0.50 },
  'hy4-preview': { cacheHitPer1M: 0.042, cacheMissPer1M: 0.834, outputPer1M: 2.501 },
  'hy3': { cacheHitPer1M: 0.035, cacheMissPer1M: 0.14, outputPer1M: 0.58 },
  // 「> 200K tokens」档（4.00 / 12.00 / 1.00）未区分，取 ≤ 档。
  'grok-4.7': { cacheHitPer1M: 0.50, cacheMissPer1M: 2.00, outputPer1M: 6.00 },
  'grok-4.6': { cacheHitPer1M: 0.50, cacheMissPer1M: 2.00, outputPer1M: 6.00 },
  // 「> 272K tokens」档未区分，取 ≤ 档。
  'gpt-6-luna': { cacheHitPer1M: 0.01, cacheMissPer1M: 0.10, outputPer1M: 0.50, cacheWritePer1M: 0.125 },
  'gpt-5.6-luna': { cacheHitPer1M: 0.02, cacheMissPer1M: 0.20, outputPer1M: 1.20, cacheWritePer1M: 0.25 },
  'space-bunny-free': { cacheHitPer1M: 0, cacheMissPer1M: 0, outputPer1M: 0 },
  // DeepSeek 系：文档给了 Off-Peak / Peak 两档，等价于「高峰价 + 低谷 50%」。
  'deepseek-v4.1-flash': { cacheHitPer1M: 0.006, cacheMissPer1M: 0.30, outputPer1M: 1.20, offPeakFactor: OFF_PEAK_FACTOR },
  'deepseek-v4-pro': { cacheHitPer1M: 0.044, cacheMissPer1M: 1.32, outputPer1M: 3.96, offPeakFactor: OFF_PEAK_FACTOR },
  'deepseek-v4-flash': { cacheHitPer1M: 0.006, cacheMissPer1M: 0.30, outputPer1M: 1.20, offPeakFactor: OFF_PEAK_FACTOR },
  'deepseek-v4-flash-vision-exp': { cacheHitPer1M: 0.006, cacheMissPer1M: 0.30, outputPer1M: 1.20, offPeakFactor: OFF_PEAK_FACTOR },
}

/**
 * OpenCode Go 条目在价目表里的键：统一加 `opencode-go/` 前缀。
 *
 * 这样两种常见的路由写法都能命中，且不会污染其它 provider 的同名模型
 * （例如 `opencode-go/deepseek-v4.1-flash` 与 DeepSeek 官方的 `deepseek-flash` 单价不同）：
 * - provider = `opencode-go`、model = `deepseek-v4.1-flash` → 命中 `provider/model` 候选；
 * - provider = 其它、model = `opencode-go/deepseek-v4.1-flash` → 命中 `model` 候选。
 */
const OPENCODE_GO_KEY_PREFIX = 'opencode-go/'

/**
 * 内置价目表：`{ 币种: { 模型键: { cacheHitPer1M, cacheMissPer1M, outputPer1M, cacheWritePer1M?, offPeakFactor } } }`。
 *
 * DeepSeek 官方（高峰档 + 低谷折扣）：
 * - CNY：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - USD：https://api-docs.deepseek.com/quick_start/pricing/
 */
export const BUILTIN_PRICES = {
  CNY: {
    'deepseek-flash': { cacheHitPer1M: 0.04, cacheMissPer1M: 2, outputPer1M: 8 },
    'deepseek-v4-pro': { cacheHitPer1M: 0.30, cacheMissPer1M: 9, outputPer1M: 27 },
  },
  USD: {
    'deepseek-flash': { cacheHitPer1M: 0.006, cacheMissPer1M: 0.30, outputPer1M: 1.20 },
    'deepseek-v4-pro': { cacheHitPer1M: 0.044, cacheMissPer1M: 1.32, outputPer1M: 3.96 },
    ...Object.fromEntries(Object.entries(OPENCODE_GO_USD)
      .map(([model, price]) => [`${OPENCODE_GO_KEY_PREFIX}${model}`, price])),
  },
}

/** 各币种的展示符号。 */
export const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }

/** 支持的币种。 */
export const CURRENCIES = ['CNY', 'USD']

/**
 * 归一化模型名：去掉 provider 前缀、去掉结尾的 -0813 之类日期后缀，转小写。
 * @param {string} model - 原始模型 id，例如 `opencode-go/deepseek-v4.1-flash`。
 * @returns {string} 归一化后的候选键（不含日期后缀的那一段）。
 */
export function normalizeModel(model) {
  const text = String(model ?? '').trim().toLowerCase()
  if (text === '') return ''
  const tail = text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text
  return tail.replace(/-\d{4,8}$/u, '')
}

/**
 * 判断某个时间点是否处于 DeepSeek 高峰计费时段。
 * @param {number} at - 毫秒时间戳或 Date。
 * @returns {boolean} 高峰返回 true。
 */
export function isPeak(at) {
  const date = at instanceof Date ? at : new Date(Number(at))
  if (Number.isNaN(date.getTime())) return false
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return PEAK_UTC_WINDOWS.some(([start, end]) => hour >= start && hour < end)
}

/**
 * 取某个币种的价目表：内置表叠加用户在 cordis.patch.yml 里写的 `prices` 覆盖。
 *
 * 覆盖键的匹配顺序为 `<provider>/<model>` → `<model>` → 归一化模型名 → `*`；
 * 覆盖值只需写想改的字段，其余沿用内置值。
 * @param {string} currency - `CNY` 或 `USD`。
 * @param {object} overrides - 用户覆盖表。
 * @returns {Map<string, object>} 键为小写匹配键的价目表。
 */
export function buildPriceTable(currency, overrides = {}) {
  const table = new Map()
  for (const [model, price] of Object.entries(BUILTIN_PRICES[currency] ?? {})) {
    table.set(model, { offPeakFactor: OFF_PEAK_FACTOR, ...price })
  }
  for (const [key, price] of Object.entries(overrides ?? {})) {
    if (price === null || typeof price !== 'object') continue
    const normalizedKey = String(key).trim().toLowerCase()
    const current = table.get(normalizedKey) ?? { offPeakFactor: OFF_PEAK_FACTOR }
    table.set(normalizedKey, { ...current, ...price })
  }
  return table
}

/**
 * 为一条模型路由找单价。
 * @param {Map<string, object>} table - {@link buildPriceTable} 的结果。
 * @param {string} provider - provider id，例如 `deepseek-official`。
 * @param {string} model - 模型 id。
 * @returns {{key: string, price: object} | undefined} 命中的键与单价。
 */
export function resolvePrice(table, provider, model) {
  const providerKey = `${String(provider ?? '').toLowerCase()}/${String(model ?? '').toLowerCase()}`
  const candidates = [providerKey, String(model ?? '').toLowerCase(), normalizeModel(model), '*']
  for (const candidate of candidates) {
    if (candidate === '' || candidate === '/') continue
    const price = table.get(candidate)
    if (price !== undefined) return { key: candidate, price }
  }
  return undefined
}

/**
 * 把一组 token 计数折算成金额。
 * @param {object} tokens - `{ uncachedInput, cacheRead, cacheWrite, output }`。
 * @param {object} price - 单价（每 100 万 token）。
 * @param {boolean} peak - 是否高峰时段。
 * @returns {{amount: number, effectiveFactor: number}} 金额与生效折扣系数。
 */
export function priceTokens(tokens, price, peak) {
  const factor = peak ? 1 : (typeof price.offPeakFactor === 'number' ? price.offPeakFactor : 1)
  const writeRate = price.cacheWritePer1M ?? price.cacheMissPer1M ?? 0
  const raw = (tokens.cacheRead ?? 0) * (price.cacheHitPer1M ?? 0)
    + (tokens.uncachedInput ?? 0) * (price.cacheMissPer1M ?? 0)
    + (tokens.cacheWrite ?? 0) * writeRate
    + (tokens.output ?? 0) * (price.outputPer1M ?? 0)
  return { amount: (raw / 1e6) * factor, effectiveFactor: factor }
}

/** 空 token 桶。 */
export function emptyTokens() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0 }
}

/** 空的分时段桶（高峰 / 低谷各一份）。 */
export function emptyPeriods() {
  return { peak: emptyTokens(), offPeak: emptyTokens() }
}

/**
 * 未配置单价的原因：
 * - `fx`：USD 价目里有、但当前展示币种需要 `usdToCny` 才能折算；
 * - `missing`：两张表都没有，也没有兜底单价。
 */
export const UNPRICED_REASON = { fx: 'fx', missing: 'missing' }

/**
 * 把逐路由结果按某个维度汇总（模型 / 供应商）。
 *
 * 金额只累加已定价的路由，`priced` 表示该组是否**全部**路由都有单价——因此
 * 「金额 + 未定价」同时出现时，金额是下界而不是全量。
 * @param {readonly object[]} routes - {@link summarizeCost} 产出的 routes。
 * @param {'model'|'provider'} dimension - 汇总维度。
 * @returns {readonly object[]} `{ key, tokens, amount, priced, converted, native }`，金额降序、token 降序。
 */
export function rollupRoutes(routes, dimension) {
  const groups = new Map()
  for (const route of routes) {
    const key = dimension === 'provider' ? route.provider : route.model
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, tokens: emptyTokens(), amount: 0, priced: true, converted: false, native: 0 }
      groups.set(key, group)
    }
    group.tokens.uncachedInput += route.tokens.uncachedInput
    group.tokens.cacheRead += route.tokens.cacheRead
    group.tokens.cacheWrite += route.tokens.cacheWrite
    group.tokens.output += route.tokens.output
    group.tokens.total += route.tokens.total
    group.tokens.calls += route.tokens.calls
    if (route.amount === null) group.priced = false
    else group.amount += route.amount
    if (route.converted === true) group.converted = true
    if (route.native != null) group.native += route.native.amount
  }
  const list = [...groups.values()]
  list.sort((left, right) => (right.amount - left.amount) || (right.tokens.total - left.tokens.total))
  return list.map(group => ({
    ...group,
    amount: group.priced ? group.amount : group.amount > 0 ? group.amount : null,
    // 该组一分钱都没折进来、但有原生美元金额时，把美元金额交出去（展示，不进合计）。
    native: group.amount === 0 && group.native > 0 ? { amount: group.native, currency: 'USD' } : null,
  }))
}

/**
 * 汇总每个模型路由的 token 与金额。
 * @param {Record<string, {provider: string, model: string, peak: object, offPeak: object}>} routes - 折叠产出的路由表。
 * @param {object} options - `{ currency, prices, defaultPrice, usdToCny }`。
 * @returns {object} `{ amount, currency, priced, partial, converted, nativeTotal, routes, byModel, byProvider, unpriced }`。
 *   `currency` 在「一条路由都没折进展示币种、但都有原生金额」时会是那个原生币种（`nativeTotal` 为真）。
 */
export function summarizeCost(routes, options) {
  const currency = options.currency
  const table = buildPriceTable(currency, options.prices)
  const fallback = options.defaultPrice
  // 展示币种不是 USD 时，USD 表另有用途：有汇率就折算，没汇率就把「缺汇率」如实标出来。
  const usdTable = currency === 'USD' ? table : buildPriceTable('USD', options.prices)
  const fxRate = Number(options.usdToCny)
  const canConvert = currency !== 'USD' && Number.isFinite(fxRate) && fxRate > 0
  const detail = []
  const unpriced = []
  let amount = 0
  let priced = true
  let converted = false

  for (const route of Object.values(routes)) {
    let hit = resolvePrice(table, route.provider, route.model)
    let fromUsd = false
    let nativePrice
    let reason
    if (hit === undefined && currency !== 'USD') {
      const usdHit = resolvePrice(usdTable, route.provider, route.model)
      if (usdHit !== undefined) {
        if (canConvert) {
          hit = usdHit
          fromUsd = true
        } else {
          // 有 USD 价目但没汇率：金额照样算出来给用户看（原生美元），只是不计入合计，
          // 因为把美元塞进人民币合计才是真的误导。
          reason = UNPRICED_REASON.fx
          nativePrice = usdHit.price
        }
      }
    }
    const price = hit?.price ?? fallback
    const tokens = emptyTokens()
    let routeAmount = 0
    for (const period of ['peak', 'offPeak']) {
      const bucket = route[period]
      const slice = {
        uncachedInput: bucket.uncachedInput ?? 0,
        cacheRead: bucket.cacheRead ?? 0,
        cacheWrite: bucket.cacheWrite ?? 0,
        output: bucket.output ?? 0,
      }
      tokens.uncachedInput += slice.uncachedInput
      tokens.cacheRead += slice.cacheRead
      tokens.cacheWrite += slice.cacheWrite
      tokens.output += slice.output
      tokens.calls += bucket.calls ?? 0
      if (price !== undefined) routeAmount += priceTokens(slice, price, period === 'peak').amount
    }
    if (fromUsd) routeAmount *= fxRate
    let nativeAmount
    if (nativePrice !== undefined) {
      nativeAmount = 0
      for (const period of ['peak', 'offPeak']) {
        const bucket = route[period]
        nativeAmount += priceTokens({
          uncachedInput: bucket.uncachedInput ?? 0,
          cacheRead: bucket.cacheRead ?? 0,
          cacheWrite: bucket.cacheWrite ?? 0,
          output: bucket.output ?? 0,
        }, nativePrice, period === 'peak').amount
      }
    }
    tokens.total = tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite + tokens.output
    const entry = {
      provider: route.provider,
      model: route.model,
      tokens,
      amount: price === undefined ? null : routeAmount,
      priceKey: hit?.key ?? (price === undefined ? null : '*'),
      currency,
      // 金额由 USD 价目折算而来（面板加 ≈，提醒不是原生计价）。
      converted: fromUsd,
      // 未计入合计的原生金额（缺汇率时给 USD 金额，展示用）。
      native: nativeAmount === undefined ? null : { amount: nativeAmount, currency: 'USD' },
      // 实际生效的单价（每 100 万 token，按价目原币种），面板据此交代钱是怎么算出来的。
      rates: price === undefined ? null : {
        cacheHitPer1M: price.cacheHitPer1M ?? 0,
        cacheMissPer1M: price.cacheMissPer1M ?? 0,
        cacheWritePer1M: price.cacheWritePer1M ?? price.cacheMissPer1M ?? 0,
        outputPer1M: price.outputPer1M ?? 0,
        offPeakFactor: price.offPeakFactor ?? 1,
        currency: fromUsd ? 'USD' : currency,
      },
    }
    if (price === undefined) {
      priced = false
      unpriced.push({
        provider: route.provider,
        model: route.model,
        tokens,
        reason: reason ?? UNPRICED_REASON.missing,
      })
    }
    if (price !== undefined) {
      amount += routeAmount
      if (fromUsd) converted = true
    }
    detail.push(entry)
  }
  detail.sort((left, right) => right.tokens.total - left.tokens.total)
  const byModel = rollupRoutes(detail, 'model')
  const byProvider = rollupRoutes(detail, 'provider')
  // 只要有一分钱是折算来的，总价就不是原生计价：标 `partial` 让面板加 ≈。
  const partial = converted && detail.some(route => route.amount !== null && route.converted !== true)
  // 一分钱都没折进展示币种、而每条路由都有原生币种金额时，总额本身就换成那个币种。
  // 不这么做就会出现「合计 ¥0.00 / 明细 $1.26」这种自相矛盾的读法。
  let totalCurrency = currency
  let nativeTotal = false
  if (amount === 0 && detail.length > 0 && detail.every(route => route.amount === null && route.native !== null)) {
    const nativeCurrencies = new Set(detail.map(route => route.native.currency))
    if (nativeCurrencies.size === 1) {
      totalCurrency = detail[0].native.currency
      nativeTotal = true
      amount = detail.reduce((sum, route) => sum + route.native.amount, 0)
    }
  }
  return {
    amount, currency: totalCurrency, priced, partial, converted, nativeTotal,
    routes: detail, byModel, byProvider, unpriced,
  }
}

/**
 * 金额格式化：小额保留 4 位小数，大额保留 2 位。
 * @param {number} amount - 金额。
 * @param {string} currency - 币种。
 * @returns {string} 带符号的展示文本，例如 `¥0.0421`。
 */
export function formatAmount(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] ?? ''
  if (!Number.isFinite(amount)) return `${symbol}—`
  const abs = Math.abs(amount)
  const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2
  return `${symbol}${amount.toFixed(digits)}`
}

/**
 * 格式化 token 数：千分位，超过 1 万用 k/M 缩写。
 * @param {number} value - token 数。
 * @returns {string} 展示文本。
 */
export function formatTokens(value) {
  const count = Number(value ?? 0)
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`
  if (count >= 1e4) return `${(count / 1e3).toFixed(0)}k`
  return String(count)
}
