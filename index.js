/**
 * session-cost 的宿主半成品。
 *
 * 职责：
 * 1. 把每个会话的持久日志折叠成「按模型路由 / 按峰谷时段」的计费 token 桶
 *    （口径对齐 harness 自己的 tokenUsage 投影，见 `lib/usage-fold.js`）；
 * 2. 用 `lib/pricing.js` 的单价把 token 折算成金额；
 * 3. 通过已登录的 DeepSeek 账号或当前 API key 读取账户余额，给出会话期间余额变化；
 * 4. 把以上结果挂在 `GET /plugin/session-cost?session=<id>`，由浏览器半成品取回；
 *    该路由复用 connection 自己的 Host/Origin 与浏览器会话栅栏（`requestRejection`）。
 *
 * 本文件刻意不使用任何 `@deepseek-ai/*` 导入：本地 bundle 的宿主半成品在 profile
 * 目录中被 Node 直接解析，只有相对导入和 node: 内置模块保证可解析。所有 harness
 * 服务都在调用时用 `ctx.get()` 惰性取得，缺失时安静降级，绝不抛异常影响应用启动。
 *
 * @module dsh-session-cost
 */

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatAmount, summarizeCost, CURRENCIES } from './lib/pricing.js'
import { consumeSession, createUsageState } from './lib/usage-fold.js'
import { primaryWallet, readBalance } from './lib/balance.js'
import { collectWindowUsage, dayWindow } from './lib/session-log.js'
import { readUsage } from './lib/subscription.js'

/** Cordis 插件名。 */
export const name = 'session-cost'

/** 浏览器半成品取数的宿主路由。 */
const ROUTE = '/plugin/session-cost'

/** 「按 provider 统计」路由：给外部页面（热力图面板）按天数要一份统计。 */
const PROVIDER_ROUTE = '/plugin/session-cost/providers'

/** 按 provider 统计允许的最大天数（再长就只是把日志扫得更慢，没有额外意义）。 */
const PROVIDER_MAX_DAYS = 365

/** 默认统计天数（路由没带 days 时用这个）。 */
const DEFAULT_PROVIDER_DAYS = 30

/** 默认配置；cordis.patch.yml 里写的字段会覆盖对应项。 */
const DEFAULTS = {
  enabled: true,
  currency: 'CNY',
  balanceSource: 'auto',
  apiKeyRef: 'DEEPSEEK_API_KEY',
  balanceBaseUrl: 'https://api.deepseek.com',
  balanceCacheMs: 20000,
  debug: false,
  prices: {},
  /** 未命中内置价目表时的兜底单价；缺省表示「未配置单价，只显示 token」。 */
  defaultPrice: undefined,
  /** 「今日消费」的时区偏移（分钟），默认北京 UTC+8。 */
  todayTimezoneOffsetMinutes: 480,
  /** 「今日消费」的重算间隔（毫秒）；两次之间复用结果。 */
  todayCacheMs: 60000,
  /** 扫描会话日志的根目录；缺省从 profile 位置推出 `<dsh home>/sessions`。 */
  sessionsRoot: undefined,
  /** 单次扫描的会话目录上限。 */
  todayMaxFiles: 200,
  /**
   * 美元折算成人民币的汇率：展示币种是 CNY、但模型只有 USD 价目（如 OpenCode Go）时用它折算。
   * 刻意不给默认值——汇率是外部事实，猜一个数字比显示「拿不到」更糟。
   */
  usdToCny: undefined,
  /**
   * 弹窗里的「订阅额度」段：已配 API key 的订阅型 provider 本周期用量（默认 OpenCode Go）。
   * 关闭后弹窗里不出现这一段。
   */
  subscription: {
    enabled: true,
    kind: 'opencode-go',
    apiKeyRef: 'OPENCODE_GO_API_KEY',
    endpoint: '',
    label: '',
    plan: '',
    refreshMs: 60000,
    timeoutMs: 8000,
  },
}

/** 收集该 bundle 在本次运行中的全部活动状态。 */
class SessionCostRuntime {
  /**
   * @param {object} ctx - 插件上下文。
   * @param {object} config - 用户配置（未校验，逐字段兜底）。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.settings = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) }
    /** 每个会话的折叠状态与余额基线。 */
    this.sessions = new Map()
    /** 账户级余额缓存（余额接口无法按会话区分）。 */
    this.balance = { at: 0, result: undefined, pending: undefined }
    /** 订阅额度的短缓存：`{ at, value, pending }`。 */
    this.subscription = { at: 0, value: undefined, pending: undefined }
    /** 「今日消费」的结果缓存与文件级解析缓存。 */
    this.today = { at: 0, result: undefined }
    this.logCache = new Map()
    /** 「按 provider 统计」的短缓存：窗口 id → `{ at, result }`。 */
    this.providerStats = new Map()
    this.logFile = this.settings.debug === true ? this.resolveLogFile() : undefined
  }

  /**
   * 解析调试日志路径（profile 目录下的 `.session-cost/debug.log`）。
   * @returns {string|undefined} 绝对路径，无法解析时为 undefined。
   */
  profileDir() {
    try {
      const base = this.ctx.baseUrl
      if (typeof base !== 'string' || !base.startsWith('file:')) return undefined
      return fileURLToPath(new URL('.', base))
    } catch {
      return undefined
    }
  }

  /**
   * 解析会话日志根目录：配置优先，否则从 profile 目录上推两级到 `<dsh home>/sessions`。
   * @returns {string|undefined} 绝对路径。
   */
  sessionsRoot() {
    const configured = this.settings.sessionsRoot
    if (typeof configured === 'string' && configured !== '') return configured
    const profile = this.profileDir()
    if (profile === undefined) return undefined
    return join(dirname(dirname(profile)), 'sessions')
  }

  /**
   * 解析调试日志路径（profile 目录下的 `.session-cost/debug.log`）。
   * @returns {string|undefined} 绝对路径，无法解析时为 undefined。
   */
  resolveLogFile() {
    const profile = this.profileDir()
    return profile === undefined ? undefined : join(profile, '.session-cost', 'debug.log')
  }

  /**
   * 追加一行调试日志；任何失败都被吞掉（日志绝不能影响功能）。
   * @param {string} message - 日志内容。
   * @returns {void}
   */
  debug(message) {
    if (this.logFile === undefined) return
    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
      // 日志一直开着也不会无限增长：超过上限就整体截断重来。
      const MAX_BYTES = 512 * 1024
      try {
        if (statSync(this.logFile).size > MAX_BYTES) writeFileSync(this.logFile, '')
      } catch {
        /* 首次写入时文件还不存在 */
      }
      appendFileSync(this.logFile, `${new Date().toISOString()} ${message}\n`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  /**
   * 取得某个会话的折叠状态；会话不存在时返回 undefined。
   * @param {string} sessionId - 会话 id。
   * @returns {object|undefined} 折叠状态。
   */
  stateFor(sessionId) {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    const session = sessions.get(sessionId)
    if (session === undefined || session === null) return undefined
    let entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      entry = { usage: createUsageState(), baseline: undefined }
      this.sessions.set(sessionId, entry)
      this.pruneSessions()
    }
    entry.touchedAt = Date.now()
    try {
      const consumed = consumeSession(entry.usage, session)
      if (consumed > 0) this.debug(`session=${sessionId} consumed=${consumed} events=${entry.usage.events}`)
    } catch (error) {
      this.debug(`session=${sessionId} fold-failed ${String(error)}`)
    }
    return entry.usage
  }

  /**
   * 限制折叠状态的数量：超过上限时丢掉最久没被访问的会话（余额基线随之重置，
   * 下次访问会重新取基线，代价只是那段时间的差值重新开始计）。
   * @returns {void}
   */
  pruneSessions() {
    const LIMIT = 200
    if (this.sessions.size <= LIMIT) return
    const rows = [...this.sessions.entries()].sort((left, right) => (left[1].touchedAt ?? 0) - (right[1].touchedAt ?? 0))
    for (const [id] of rows.slice(0, this.sessions.size - LIMIT)) this.sessions.delete(id)
  }

  /**
   * 读取余额，带短时缓存；并发调用复用同一个请求。
   * @returns {Promise<object>} 统一余额结果。
   */
  async balanceNow() {
    const ttl = Number(this.settings.balanceCacheMs)
    const fresh = Number.isFinite(ttl) && ttl >= 0 && this.balance.result !== undefined
      && Date.now() - this.balance.at < ttl
    if (fresh) return this.balance.result
    if (this.balance.pending !== undefined) return this.balance.pending
    const pending = this.queryBalance()
    this.balance.pending = pending
    try {
      const result = await pending
      this.balance = { at: Date.now(), result, pending: undefined }
      return result
    } finally {
      if (this.balance.pending === pending) this.balance.pending = undefined
    }
  }

  /**
   * 按配置实际发起一次余额查询。
   * @returns {Promise<object>} 统一余额结果。
   */
  async queryBalance() {
    const settings = this.settings
    const credentials = this.ctx.get('credentials')
    let apiKey
    try {
      const resolved = await credentials?.resolve?.(String(settings.apiKeyRef))
      apiKey = resolved?.value
    } catch (error) {
      this.debug(`credentials-resolve-failed ${String(error)}`)
    }
    const account = this.ctx.get('deepseekAccount')
    const result = await readBalance({
      mode: settings.balanceSource,
      currency: settings.currency,
      apiKey,
      baseUrl: settings.balanceBaseUrl,
      account,
      client: this.accountClientMetadata(),
    })
    this.debug(`balance source=${String(result.source)} status=${String(result.status)}${result.reason === undefined ? '' : ` reason=${String(result.reason)}`}`)
    return result
  }

  /**
   * 构造账号接口需要的客户端身份（版本 / 语言 / 时区）。
   * @returns {{version: string, locale: string, timezoneOffsetSeconds: number}} 客户端身份。
   */
  accountClientMetadata() {
    return {
      version: process.env.DSH_CLIENT_VERSION ?? '0.1.0',
      locale: process.env.DSH_LOCALE ?? 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  /**
   * 组装一次查询的完整响应。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<object>} 可直接 JSON 化的响应体。
   */
  async report(sessionId, options = {}) {
    const settings = this.settings
    const currency = CURRENCIES.includes(settings.currency) ? settings.currency : DEFAULTS.currency
    if (settings.enabled === false) return { ok: false, reason: 'disabled', currency }
    const state = this.stateFor(sessionId)
    if (state === undefined) return { ok: false, reason: 'session-not-live', currency }
    const estimate = summarizeCost(state.routes, {
      currency,
      prices: settings.prices,
      defaultPrice: settings.defaultPrice,
      usdToCny: settings.usdToCny,
    })
    const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0 }
    for (const route of estimate.routes) {
      tokens.uncachedInput += route.tokens.uncachedInput
      tokens.cacheRead += route.tokens.cacheRead
      tokens.cacheWrite += route.tokens.cacheWrite
      tokens.output += route.tokens.output
      tokens.total += route.tokens.total
      tokens.calls += route.tokens.calls
    }
    const payload = {
      ok: true,
      sessionId,
      currency,
      enabled: true,
      updatedAt: Date.now(),
      estimate: {
        amount: estimate.amount,
        // 可能回落到原生币种（见 summarizeCost 的 nativeTotal）：展示文本必须用它自己的符号。
        currency: estimate.currency,
        nativeTotal: estimate.nativeTotal,
        display: formatAmount(estimate.amount, estimate.currency),
        priced: estimate.priced,
        // 有任何一分钱是折算来的，总价就不是纯原生计价，展示层要标 ≈。
        converted: estimate.converted,
        routes: estimate.routes,
        byModel: estimate.byModel,
        byProvider: estimate.byProvider,
        unpriced: estimate.unpriced.map(route => ({
          provider: route.provider,
          model: route.model,
          reason: route.reason,
        })),
      },
      tokens,
      bounds: { firstAt: state.firstAt, lastAt: state.lastAt, settlements: state.events },
      balance: { status: 'off', source: null, wallets: [] },
    }
    if (settings.balanceSource !== 'off') {
      payload.balance = await this.attachBalance(sessionId, currency)
    }
    // 订阅额度：取不到就不带这一段，弹窗其余内容照常。
    const subscription = await this.subscriptionReport()
    if (subscription !== undefined) payload.subscription = subscription
    payload.today = this.todayReport(currency)
    return payload
  }

  /**
   * 取订阅型 provider 的本周期用量（弹窗里的「订阅额度」段）。
   *
   * 只读一次用量接口，结果按 `subscription.refreshMs` 复用；失败返回 `{ status }` 让页面
   * 如实显示，不抛异常、不把旧值冒充新值。
   * @returns {Promise<object|undefined>} `{ label, plan, status, windows, order, fetchedAt }`；关闭时 undefined。
   */
  async subscriptionReport() {
    const settings = this.settings.subscription !== null && typeof this.settings.subscription === 'object'
      ? this.settings.subscription
      : {}
    if (settings.enabled === false) return undefined
    const refreshMs = Math.max(5000, Number(settings.refreshMs) || 60000)
    if (this.subscription.value !== undefined && Date.now() - this.subscription.at < refreshMs) {
      return this.subscription.value
    }
    if (this.subscription.pending !== undefined) return this.subscription.pending
    const task = (async () => {
      let apiKey
      try {
        const credentials = this.ctx.get('credentials')
        const resolved = await credentials?.resolve?.(String(settings.apiKeyRef ?? 'OPENCODE_GO_API_KEY'))
        apiKey = resolved?.value
      } catch (error) {
        this.debug(`subscription credentials-failed ${String(error)}`)
      }
      const result = await readUsage({
        kind: settings.kind ?? 'opencode-go',
        endpoint: typeof settings.endpoint === 'string' ? settings.endpoint : '',
        apiKey,
        timeoutMs: Math.max(1000, Number(settings.timeoutMs) || 8000),
      })
      const value = {
        label: typeof settings.label === 'string' && settings.label !== '' ? settings.label : 'OpenCode Go',
        plan: typeof settings.plan === 'string' ? settings.plan : '',
        status: result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.windows === undefined ? {} : { windows: result.windows, order: result.order }),
        fetchedAt: Date.now(),
      }
      this.debug(`subscription status=${result.status}`)
      this.subscription = { at: Date.now(), value, pending: undefined }
      return value
    })()
    this.subscription.pending = task
    try {
      return await task
    } catch (error) {
      this.debug(`subscription failed ${String(error)}`)
      this.subscription.pending = undefined
      return { label: 'OpenCode Go', plan: '', status: 'internal', fetchedAt: Date.now() }
    }
  }

  /**
   * 把「最近多少天」换成实际时间区间（按配置的时区切日，含今天）。
   * @param {number} days - 天数；会被夹到 `1..PROVIDER_MAX_DAYS`。
   * @returns {object} `{ id, label, start, end, days, offsetMinutes, zone }`。
   */
  providerRange(days) {
    const wanted = Number.isFinite(days) ? Math.trunc(days) : DEFAULT_PROVIDER_DAYS
    const span = Math.min(PROVIDER_MAX_DAYS, Math.max(1, wanted))
    const day = dayWindow(Date.now(), this.settings.todayTimezoneOffsetMinutes)
    const end = day.end
    const start = day.start - (span - 1) * 86_400_000
    return { id: `${String(span)}d`, label: `近 ${String(span)} 天`, start, end, days: span, offsetMinutes: day.offsetMinutes, zone: day.label }
  }

  /**
   * 按 provider 统计 tokens 与金额（跨会话，窗口可选）。
   *
   * 复用「今日消费」那条扫描链路：读本机会话日志 → 折叠结算 → 按 provider 汇总 token 与金额。
   * 结果按 `todayCacheMs` 缓存；每个窗口一份文件级缓存，避免来回切窗口时反复解压。
   * @param {string} currency - 展示币种。
   * @param {number} days - 最近多少天。
   * @returns {object} 统计段；读不到目录时给 failed 状态而不是抛异常。
   */
  providerReport(currency, days) {
    const range = this.providerRange(days)
    const ttl = Number(this.settings.todayCacheMs)
    const cached = this.providerStats.get(range.id)
    if (cached !== undefined && Number.isFinite(ttl) && ttl >= 0 && Date.now() - cached.at < ttl) {
      return cached.result
    }
    const root = this.sessionsRoot()
    const fail = reason => ({ status: 'failed', reason, days: range.days, label: range.label, currency, rows: [], since: range.start, until: range.end })
    if (root === undefined) return fail('no-root')
    let result
    try {
      const collected = collectWindowUsage({
        root,
        windowStart: range.start,
        windowEnd: range.end,
        cache: this.logCache,
        maxFiles: this.settings.todayMaxFiles,
      })
      if (collected.missing === true) {
        result = fail('no-sessions-root')
      } else {
        const cost = summarizeCost(collected.routes, {
          currency,
          prices: this.settings.prices,
          defaultPrice: this.settings.defaultPrice,
          usdToCny: this.settings.usdToCny,
        })
        const rows = cost.byProvider.map(group => ({
          provider: group.key === '' ? '未知' : group.key,
          tokens: group.tokens,
          amount: group.amount,
          display: group.amount === null ? null : formatAmount(group.amount, cost.currency),
          currency: cost.currency,
          priced: group.priced,
          converted: group.converted === true,
          native: group.native ?? null,
        }))
        const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0 }
        for (const row of rows) {
          tokens.uncachedInput += row.tokens.uncachedInput
          tokens.cacheRead += row.tokens.cacheRead
          tokens.cacheWrite += row.tokens.cacheWrite
          tokens.output += row.tokens.output
          tokens.total += row.tokens.total
          tokens.calls += row.tokens.calls
        }
        result = {
          status: 'ready',
          days: range.days,
          label: range.label,
          currency: cost.currency,
          amount: cost.amount,
          priced: cost.priced,
          converted: cost.converted,
          display: formatAmount(cost.amount, cost.currency),
          tokens,
          rows,
          sessions: collected.files,
          truncated: collected.truncated === true,
          since: range.start,
          until: range.end,
          zone: range.zone,
        }
      }
    } catch (error) {
      this.debug(`provider-stats-failed ${String(error)}`)
      result = fail('internal')
    }
    this.providerStats.set(range.id, { at: Date.now(), result })
    this.debug(`provider-stats window=${range.id} status=${String(result.status)} rows=${String((result.rows ?? []).length)}`)
    return result
  }

  /**
   * 「今日消费」：跨会话统计本机会话日志里落在今日窗口内的结算。
   *
   * 与余额不同，这个数字不依赖任何账号接口，所以只要插件启用就计算；结果按
   * `todayCacheMs` 复用，文件级解析结果另按 `(窗口, size, mtime)` 缓存。
   * @param {string} currency - 展示币种。
   * @returns {object} 今日消费段。
   */
  todayReport(currency) {
    const window = dayWindow(Date.now(), this.settings.todayTimezoneOffsetMinutes)
    const ttl = Number(this.settings.todayCacheMs)
    if (this.today.result !== undefined && Number.isFinite(ttl) && ttl >= 0
      && Date.now() - this.today.at < ttl) {
      return this.today.result
    }
    let result
    try {
      result = this.computeToday(currency, window)
    } catch (error) {
      this.debug(`today-failed ${String(error)}`)
      result = { status: 'failed', reason: 'internal', label: window.label }
    }
    this.today = { at: Date.now(), result }
    this.debug(`today status=${String(result.status)} label=${window.label} sessions=${String(result.sessions ?? 0)} amount=${String(result.display ?? result.reason)}`)
    return result
  }

  /**
   * 真正执行一次今日统计。
   * @param {string} currency - 展示币种。
   * @param {object} window - {@link dayWindow} 的结果。
   * @returns {object} 今日消费段。
   */
  computeToday(currency, window) {
    const root = this.sessionsRoot()
    if (root === undefined) return { status: 'failed', reason: 'no-root', label: window.label }
    const collected = collectWindowUsage({
      root,
      windowStart: window.start,
      windowEnd: window.end,
      cache: this.logCache,
      maxFiles: this.settings.todayMaxFiles,
    })
    if (collected.missing === true) return { status: 'failed', reason: 'no-sessions-root', label: window.label, root }
    const cost = summarizeCost(collected.routes, {
      currency,
      prices: this.settings.prices,
      defaultPrice: this.settings.defaultPrice,
      usdToCny: this.settings.usdToCny,
    })
    const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0 }
    for (const route of cost.routes) {
      tokens.uncachedInput += route.tokens.uncachedInput
      tokens.cacheRead += route.tokens.cacheRead
      tokens.cacheWrite += route.tokens.cacheWrite
      tokens.output += route.tokens.output
      tokens.total += route.tokens.total
      tokens.calls += route.tokens.calls
    }
    return {
      status: 'ready',
      label: window.label,
      timezoneOffsetMinutes: window.offsetMinutes,
      amount: cost.amount,
      display: formatAmount(cost.amount, cost.currency),
      currency: cost.currency,
      priced: cost.priced,
      converted: cost.converted,
      unpriced: cost.unpriced.map(route => ({
        provider: route.provider,
        model: route.model,
        reason: route.reason,
      })),
      routes: cost.routes,
      tokens,
      sessions: collected.files,
      parsed: collected.parsed,
      truncated: collected.truncated === true,
      since: window.start,
      until: window.end,
    }
  }

  /**
   * 把余额与「会话期间余额变化」并入响应。
   * @param {string} sessionId - 会话 id。
   * @param {string} currency - 展示币种。
   * @returns {Promise<object>} 余额段。
   */
  async attachBalance(sessionId, currency) {
    let result
    try {
      result = await this.balanceNow()
    } catch (error) {
      this.debug(`balance-failed ${String(error)}`)
      return { status: 'failed', source: null, reason: 'internal', wallets: [] }
    }
    if (result.status !== 'ready') {
      return { status: result.status, source: result.source ?? null, reason: result.reason, wallets: [] }
    }
    const wallets = result.wallets.map(row => ({
      currency: row.currency,
      total: row.total,
      granted: row.granted,
      toppedUp: row.toppedUp,
      display: formatAmount(row.total, row.currency),
    }))
    const wallet = primaryWallet(result.wallets, currency)
    const entry = this.sessions.get(sessionId)
    if (entry !== undefined && entry.baseline === undefined && wallet !== undefined) {
      entry.baseline = { currency: wallet.currency, total: wallet.total, at: Date.now() }
    }
    const baseline = entry?.baseline
    const spent = baseline !== undefined && wallet !== undefined && baseline.currency === wallet.currency
      ? Math.max(0, baseline.total - wallet.total)
      : undefined
    return {
      status: 'ready',
      source: result.source ?? null,
      isAvailable: result.isAvailable !== false,
      wallets,
      primary: wallet === undefined ? undefined : {
        currency: wallet.currency,
        total: wallet.total,
        display: formatAmount(wallet.total, wallet.currency),
      },
      baseline: baseline === undefined ? undefined : {
        total: baseline.total,
        at: baseline.at,
        display: formatAmount(baseline.total, baseline.currency),
      },
      spentSince: spent === undefined ? undefined : {
        amount: spent,
        currency: baseline.currency,
        display: formatAmount(spent, baseline.currency),
        // 余额是账户级数据：同一账号下的其他客户端/会话也会体现在这段差值里。
        scope: 'account',
      },
    }
  }
}

/**
 * 判断请求是否来自本机回环地址。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 回环返回 true。
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

/**
 * 发送 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} body - 响应体。
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 挂载插件：注册 `GET /plugin/session-cost?session=<id>`。
 *
 * 关于通道选择：`ctx.connection.rpc.handle()` 是文档化的逻辑 RPC 注册口，但它在
 * 当前版本里由连接服务自身、缺少 `webServer` 注入的上下文执行 `owner.webServer`，
 * 任何外部调用者都会拿到 `cannot get property "webServer" without inject`（已实测）。
 * 因此这里退回到 webserver 的精确路由，并显式复用 connection 自己的信任/鉴权栅栏
 * （`requestRejection`），使它与 `/api` 通道享有同一套 Host/Origin 与浏览器会话校验。
 *
 * 注册只用 `ctx.get` + `ctx.effect` 两个必定存在的原语：服务可能在本行挂载之后才
 * 就绪，所以先立即试一次，失败就每秒重试直到 `webServer` 与 `connection` 都在。
 * 缺少这些服务（headless 等）时插件保持安静，不影响应用。
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 插件配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const runtime = new SessionCostRuntime(ctx, config)
  runtime.debug(`plugin apply currency=${String(runtime.settings.currency)} balanceSource=${String(runtime.settings.balanceSource)}`)

  /** 请求处理器：先过栅栏，再返回 JSON；任何异常都降级成 ok:false。 */
  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, reason: 'forbidden' })
        return
      }
      // 与 /api 同源的 Host/Origin + 浏览器会话校验；connection 缺失时跳过。
      const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
      if (rejection !== undefined) {
        sendJson(res, rejection, { ok: false, reason: 'unauthorized' })
        return
      }
      const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session') ?? ''
      if (sessionId === '' || sessionId.length > 200) {
        sendJson(res, 400, { ok: false, reason: 'bad-session' })
        return
      }
      const report = await runtime.report(sessionId)
      runtime.debug(`report session=${sessionId} ok=${String(report.ok)}${report.ok === true ? ` amount=${String(report.estimate?.display)} tokens=${String(report.tokens?.total)}` : ` reason=${String(report.reason)}`}`)
      sendJson(res, 200, report)
    } catch (error) {
      runtime.debug(`handler-failed ${String(error)}`)
      sendJson(res, 200, { ok: false, reason: 'internal' })
    }
  }

  /**
   * 「按 provider 统计」处理器：给热力图面板按天数要一份跨会话统计。
   *
   * 与主路由同一套栅栏（回环 + `requestRejection`），但**不需要 live 会话**：
   * 它只读本机会话日志，所以不传 session 也能用。
   */
  const providersHandler = (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, reason: 'forbidden' })
        return
      }
      const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
      if (rejection !== undefined) {
        sendJson(res, rejection, { ok: false, reason: 'unauthorized' })
        return
      }
      const url = new URL(req.url ?? PROVIDER_ROUTE, 'http://127.0.0.1')
      const days = Number(url.searchParams.get('days') ?? DEFAULT_PROVIDER_DAYS)
      const providers = runtime.providerReport(runtime.settings.currency, days)
      runtime.debug(`providers days=${String(days)} status=${String(providers.status)} rows=${String((providers.rows ?? []).length)}`)
      sendJson(res, 200, { ok: true, providers })
    } catch (error) {
      runtime.debug(`providers-handler-failed ${String(error)}`)
      sendJson(res, 200, { ok: false, reason: 'internal' })
    }
  }

  let dispose
  let attempts = 0
  const attempt = label => {
    if (dispose !== undefined) return true
    attempts += 1
    const webServer = ctx.get('webServer')
    const connection = ctx.get('connection')
    runtime.debug(`register attempt#${String(attempts)} (${label}) webServer=${webServer === undefined ? 'missing' : 'ready'} connection=${connection === undefined ? 'missing' : 'ready'}`)
    if (webServer === undefined || typeof webServer.register !== 'function') return false
    try {
      dispose = ctx.effect(() => {
        const offMain = webServer.register({ kind: 'exact', path: ROUTE, handler })
        const offProviders = webServer.register({ kind: 'exact', path: PROVIDER_ROUTE, handler: providersHandler })
        return () => { offMain(); offProviders() }
      }, 'session-cost: route')
      runtime.debug(`route ${ROUTE} registered (+ ${PROVIDER_ROUTE})`)
      return true
    } catch (error) {
      runtime.debug(`route registration threw ${String(error)}`)
      return false
    }
  }
  if (attempt('immediate')) return
  // 有界重试：服务通常在几秒内就绪；到上限就安静放弃，不留下永久定时器。
  const MAX_ATTEMPTS = 300
  const timer = setInterval(() => {
    if (attempt('retry') || attempts >= MAX_ATTEMPTS) {
      clearInterval(timer)
      if (dispose === undefined) runtime.debug(`route registration gave up after ${String(attempts)} attempts`)
    }
  }, 1000)
  ctx.effect(() => () => { clearInterval(timer) }, 'session-cost: registration retry')
}
