/**
 * 订阅用量的纯逻辑层（OpenCode Go）。
 *
 * 口径来自官方文档 https://opencode.ai/docs/go/ 与实测响应
 * `GET https://opencode.ai/inference/go/v1/usage`（Bearer API key → 每个窗口的已用百分比 + resetsAt）。
 *
 * 本文件刻意在插件目录内自包含：DSH 插件之间不互相 import，需要同样的逻辑时各留一份副本。
 */

/** 三个窗口的固定顺序（5 小时滚动 / 本周 / 本月）。 */
export const WINDOW_IDS = ['rolling', 'weekly', 'monthly']

/** 内置适配器的默认用量地址。 */
export const OPENCODE_GO_ENDPOINT = 'https://opencode.ai/inference/go/v1/usage'

/** 内置适配器表：`kind` → 实现。加 provider 只在这里加一项。 */
export const ADAPTERS = {
  'opencode-go': {
    label: 'OpenCode Go',
    endpoint: OPENCODE_GO_ENDPOINT,
    /** 请求头：OpenCode 用标准 Bearer。 */
    headers: apiKey => ({ accept: 'application/json', authorization: `Bearer ${apiKey}` }),
  },
}

/**
 * 把「已用百分比」夹到 0–100，并算出剩余百分比。
 * @param {number} percent - 原始已用百分比（可能略超 100）。
 * @returns {{percent: number, remaining: number, over: boolean}} 规整后的百分比。
 */
export function clampPercent(percent) {
  const raw = Number.isFinite(percent) ? percent : 0
  const percentClamped = Math.max(0, Math.min(100, raw))
  return { percent: percentClamped, remaining: 100 - percentClamped, over: raw > 100 }
}

/**
 * 规整用量响应。
 * @param {unknown} body - 响应 JSON。
 * @returns {{windows: Record<string, {percent: number, remaining: number, over: boolean, status: string, resetsAt: string|null}>, order: string[]}|null}
 *   没有一个可用窗口时返回 null（当作响应不可用，不编造 0）。
 */
export function normalizeUsage(body) {
  const usage = body?.usage
  if (usage === null || typeof usage !== 'object') return null
  const windows = {}
  const order = []
  for (const id of WINDOW_IDS) {
    const raw = usage[id]
    if (raw === null || typeof raw !== 'object' || !Number.isFinite(raw.percent)) continue
    const { percent, remaining, over } = clampPercent(raw.percent)
    const resetsAt = typeof raw.resetsAt === 'string' && Number.isFinite(Date.parse(raw.resetsAt)) ? raw.resetsAt : null
    windows[id] = {
      percent,
      remaining,
      over,
      status: typeof raw.status === 'string' && raw.status !== '' ? raw.status : 'unknown',
      resetsAt,
    }
    order.push(id)
  }
  return order.length === 0 ? null : { windows, order }
}

/**
 * 取一次某个 provider 的用量。
 *
 * 失败一律返回 `{status: <原因>}`，不抛异常：调用方只需要把原因如实显示出来。
 * @param {object} options - `{ kind, endpoint, apiKey, fetchImpl, timeoutMs, now }`。
 * @returns {Promise<object>} `{status:'ok', windows, order, fetchedAt}` 或 `{status:'no-key'|'unsupported'|'unauthorized'|'network'|'bad-response'|'http-<code>', reason?}`。
 */
export async function readUsage(options) {
  const adapter = ADAPTERS[options.kind]
  if (adapter === undefined) return { status: 'unsupported', reason: `unsupported-kind:${String(options.kind)}` }
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (apiKey === '') return { status: 'no-key' }
  const endpoint = typeof options.endpoint === 'string' && options.endpoint !== '' ? options.endpoint : adapter.endpoint
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { status: 'network', reason: 'fetch-unavailable' }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let timer
  if (controller !== undefined) {
    timer = setTimeout(() => { controller.abort() }, timeoutMs)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: adapter.headers(apiKey),
      signal: controller?.signal,
    })
  } catch (error) {
    const name = error?.name
    return { status: 'network', reason: name === 'AbortError' ? 'timeout' : String(error?.message ?? error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return { status: 'unauthorized' }
    return { status: `http-${String(response.status)}` }
  }
  let body
  try {
    body = await response.json()
  } catch {
    return { status: 'bad-response', reason: 'invalid-json' }
  }
  const normalized = normalizeUsage(body)
  if (normalized === null) return { status: 'bad-response', reason: 'no-usage-windows' }
  return {
    status: 'ok',
    windows: normalized.windows,
    order: normalized.order,
    fetchedAt: Number.isFinite(options.now) ? options.now : Date.now(),
  }
}
