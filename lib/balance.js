/**
 * 余额读取：API key 与已登录 DeepSeek 账号两条路径，统一成同一种钱包结构。
 *
 * - API key：`GET {baseUrl}/user/balance`，`Authorization: Bearer <sk-...>`。
 *   响应 `{ is_available, balance_infos: [{ currency, total_balance,
 *   granted_balance, topped_up_balance }] }`，金额是**字符串**。
 * - 已登录账号：走 harness 的 `ctx.deepseekAccount.getBalance(client)`，
 *   返回普通钱包与赠金钱包，金额同样是字符串。
 *
 * 这里只做读取与归一化，不缓存、不做差值——那是调用方的事。
 *
 * @module dsh-session-cost/balance
 */

/** 请求超时（毫秒）。 */
const TIMEOUT_MS = 8000

/**
 * 把任意金额写法归一成数字；非法值返回 undefined。
 * @param {unknown} value - 字符串或数字金额。
 * @returns {number|undefined} 数字金额。
 */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text)) return undefined
  const amount = Number(text)
  return Number.isFinite(amount) ? amount : undefined
}

/**
 * 归一化单个钱包。
 * @param {object} raw - `{ currency, total, granted, toppedUp }`。
 * @returns {object|null} 归一化钱包，字段缺失时为 null。
 */
function wallet(raw) {
  const total = parseAmount(raw.total)
  if (total === undefined) return null
  return {
    currency: raw.currency,
    total,
    granted: parseAmount(raw.granted) ?? 0,
    toppedUp: parseAmount(raw.toppedUp) ?? 0,
  }
}

/**
 * 查询 DeepSeek 开放平台余额（API key 路径）。
 * @param {object} options - `{ baseUrl, apiKey, currency, fetchImpl, timeoutMs }`。
 * @returns {Promise<object>} `{ status: 'ready', source: 'apikey', isAvailable, wallets }`
 *   或 `{ status: 'failed', source: 'apikey', reason }`。
 */
export async function readApiKeyBalance(options) {
  const base = String(options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const source = 'apikey'
  if (typeof fetchImpl !== 'function') return { status: 'failed', source, reason: 'no-fetch' }
  if (typeof options.apiKey !== 'string' || options.apiKey === '') {
    return { status: 'failed', source, reason: 'no-key' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs ?? TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${base}/user/balance`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return { status: 'failed', source, reason: `http-${response.status}` }
    const payload = await response.json()
    const rows = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
    const wallets = rows.map(row => wallet({
      currency: row?.currency,
      total: row?.total_balance,
      granted: row?.granted_balance,
      toppedUp: row?.topped_up_balance,
    })).filter(Boolean)
    if (wallets.length === 0) return { status: 'failed', source, reason: 'empty' }
    return { status: 'ready', source, isAvailable: payload?.is_available !== false, wallets }
  } catch (error) {
    return { status: 'failed', source, reason: error?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查询已登录 DeepSeek 账号的余额（平台会话路径）。
 * @param {object} options - `{ account, client }`；`account` 是 `ctx.deepseekAccount`。
 * @returns {Promise<object>} 与 {@link readApiKeyBalance} 同形的结果，source 为 `account`。
 */
export async function readAccountBalance(options) {
  const source = 'account'
  const account = options.account
  if (account === undefined || account === null || typeof account.getBalance !== 'function') {
    return { status: 'failed', source, reason: 'unavailable' }
  }
  try {
    const result = await account.getBalance(options.client)
    if (result === null || result === undefined) return { status: 'failed', source, reason: 'signed-out' }
    if (result.status !== 'ready') return { status: 'failed', source, reason: 'query-failed' }
    const wallets = [
      ...(Array.isArray(result.value) ? result.value : []).map(row => wallet({
        currency: row?.currency, total: row?.balance,
      })),
      ...(Array.isArray(result.bonusWallets) ? result.bonusWallets : []).map(row => wallet({
        currency: row?.currency, total: row?.balance,
      })),
    ].filter(Boolean)
    if (wallets.length === 0) return { status: 'failed', source, reason: 'empty' }
    return { status: 'ready', source, isAvailable: true, wallets }
  } catch (error) {
    return { status: 'failed', source, reason: error?.name === 'AbortError' ? 'timeout' : 'query-failed' }
  }
}

/**
 * 按配置选择余额来源。
 * @param {object} options - `{ mode, currency, ...readApiKeyBalance/readAccountBalance 的入参 }`。
 * @returns {Promise<object>} 统一结果；`mode: 'off'` 时返回 `{ status: 'off', source: null }`。
 */
export async function readBalance(options) {
  const mode = options.mode ?? 'auto'
  if (mode === 'off') return { status: 'off', source: null, wallets: [] }
  if (mode === 'account') return readAccountBalance(options)
  if (mode === 'apikey') return readApiKeyBalance(options)
  const byKey = await readApiKeyBalance(options)
  if (byKey.status === 'ready') return byKey
  const byAccount = await readAccountBalance(options)
  return byAccount.status === 'ready' ? byAccount : byKey
}

/**
 * 取展示币种对应的钱包；没有该币种时退回第一个。
 * @param {readonly object[]} wallets - 归一化钱包列表。
 * @param {string} currency - 展示币种。
 * @returns {object|undefined} 选中的钱包。
 */
export function primaryWallet(wallets, currency) {
  if (!Array.isArray(wallets) || wallets.length === 0) return undefined
  return wallets.find(row => row.currency === currency) ?? wallets[0]
}
