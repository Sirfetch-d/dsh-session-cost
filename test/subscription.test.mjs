/**
 * 订阅用量纯逻辑层的单元测试。
 *
 * 这层负责「把第三方用量接口的响应变成面板能显示的窗口」以及各种失败的如实降级，
 * 全部用注入的 `fetchImpl` 打桩，不联网。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ADAPTERS, OPENCODE_GO_ENDPOINT, WINDOW_IDS,
  clampPercent, normalizeUsage, readUsage,
} from '../lib/subscription.js'

test('窗口顺序固定为 5 小时 / 本周 / 本月，且内置适配器指向 OpenCode Go', () => {
  assert.deepEqual(WINDOW_IDS, ['rolling', 'weekly', 'monthly'])
  assert.equal(ADAPTERS['opencode-go'].endpoint, OPENCODE_GO_ENDPOINT)
  assert.equal(OPENCODE_GO_ENDPOINT, 'https://opencode.ai/inference/go/v1/usage')
})

test('clampPercent 夹到 0–100，算出剩余，并在超额时标记', () => {
  assert.deepEqual(clampPercent(37.5), { percent: 37.5, remaining: 62.5, over: false })
  assert.deepEqual(clampPercent(0), { percent: 0, remaining: 100, over: false })
  assert.deepEqual(clampPercent(100), { percent: 100, remaining: 0, over: false })
  // 接口可能返回略超 100 的值：显示夹到 100，但保留「超额」这一事实。
  assert.deepEqual(clampPercent(120), { percent: 100, remaining: 0, over: true })
  assert.deepEqual(clampPercent(-5), { percent: 0, remaining: 100, over: false })
  // 非数字不编造数值。
  assert.deepEqual(clampPercent(Number.NaN), { percent: 0, remaining: 100, over: false })
  assert.deepEqual(clampPercent(undefined), { percent: 0, remaining: 100, over: false })
})

test('normalizeUsage 只收有 percent 的窗口，未知窗口与非法值一律跳过', () => {
  const out = normalizeUsage({
    usage: {
      monthly: { percent: 101 },
      rolling: { percent: 42, resetsAt: '2026-11-21T20:00:00Z', status: 'ok' },
      weekly: { percent: 'abc' },
      other: { percent: 5 },
    },
  })
  assert.deepEqual(out.order, ['rolling', 'monthly'], '顺序按 WINDOW_IDS，不按响应键序')
  assert.equal(out.windows.rolling.percent, 42)
  assert.equal(out.windows.rolling.remaining, 58)
  assert.equal(out.windows.rolling.status, 'ok')
  assert.equal(out.windows.rolling.resetsAt, '2026-11-21T20:00:00Z')
  assert.equal(out.windows.monthly.over, true, '超额要保留')
  assert.equal(out.windows.monthly.status, 'unknown', '缺 status 时不编造具体状态')
  assert.equal(out.windows.monthly.resetsAt, null, '缺 resetsAt 时给 null')
})

test('normalizeUsage 没有任何可用窗口时返回 null（不编造 0%）', () => {
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage({ usage: {} }), null)
  assert.equal(normalizeUsage({ usage: { rolling: {} } }), null)
  assert.equal(normalizeUsage({ usage: { rolling: { percent: 'x' } } }), null)
  assert.equal(normalizeUsage({ usage: 3 }), null)
  assert.equal(normalizeUsage(null), null)
})

test('readUsage：没有配置 key 时一次请求都不发', async () => {
  let called = 0
  for (const apiKey of ['', '   ', undefined, null]) {
    const result = await readUsage({
      kind: 'opencode-go',
      apiKey,
      fetchImpl: async () => { called += 1; throw new Error('不应该发请求') },
    })
    assert.equal(result.status, 'no-key', `apiKey=${String(apiKey)} 时应为 no-key`)
  }
  assert.equal(called, 0)
})

test('readUsage：成功路径带 Bearer 头，返回窗口与取数时刻', async () => {
  const seen = {}
  const result = await readUsage({
    kind: 'opencode-go',
    apiKey: '  go-abc  ',
    now: 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      seen.url = url
      seen.init = init
      return { ok: true, status: 200, json: async () => ({ usage: { rolling: { percent: 10 } } }) }
    },
  })
  assert.equal(seen.url, OPENCODE_GO_ENDPOINT, '默认打到内置地址')
  assert.equal(seen.init.method, 'GET')
  assert.equal(seen.init.headers.authorization, 'Bearer go-abc', 'key 要去掉首尾空白')
  assert.equal(seen.init.headers.accept, 'application/json')
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.order, ['rolling'])
  assert.equal(result.windows.rolling.remaining, 90)
  assert.equal(result.fetchedAt, 1_700_000_000_000)
})

test('readUsage：endpoint 可覆盖（自建代理），未知 kind 明确不支持且不发请求', async () => {
  let seenUrl
  const proxied = await readUsage({
    kind: 'opencode-go',
    apiKey: 'k',
    endpoint: 'https://proxy.example/usage',
    fetchImpl: async url => {
      seenUrl = url
      return { ok: true, status: 200, json: async () => ({ usage: { monthly: { percent: 1 } } }) }
    },
  })
  assert.equal(seenUrl, 'https://proxy.example/usage')
  assert.equal(proxied.status, 'ok')

  let called = 0
  const unsupported = await readUsage({
    kind: 'not-a-provider',
    apiKey: 'k',
    fetchImpl: async () => { called += 1; throw new Error('不应该发请求') },
  })
  assert.equal(unsupported.status, 'unsupported')
  assert.match(unsupported.reason, /not-a-provider/u)
  assert.equal(called, 0)
})

test('readUsage：失败一律如实降级，不抛异常', async () => {
  /** 造一个返回固定状态码的桩。 */
  const statusFetch = status => async () => ({ ok: false, status })

  assert.equal((await readUsage({ kind: 'opencode-go', apiKey: 'k', fetchImpl: statusFetch(401) })).status, 'unauthorized')
  assert.equal((await readUsage({ kind: 'opencode-go', apiKey: 'k', fetchImpl: statusFetch(403) })).status, 'unauthorized')
  assert.equal((await readUsage({ kind: 'opencode-go', apiKey: 'k', fetchImpl: statusFetch(500) })).status, 'http-500')

  // 响应不是 JSON。
  const invalidJson = await readUsage({
    kind: 'opencode-go',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }),
  })
  assert.equal(invalidJson.status, 'bad-response')
  assert.equal(invalidJson.reason, 'invalid-json')

  // JSON 里没有可用窗口。
  const noWindows = await readUsage({
    kind: 'opencode-go',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ usage: {} }) }),
  })
  assert.equal(noWindows.status, 'bad-response')
  assert.equal(noWindows.reason, 'no-usage-windows')

  // 网络层直接抛错。
  const network = await readUsage({
    kind: 'opencode-go',
    apiKey: 'k',
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(network.status, 'network')
  assert.match(network.reason, /ECONNREFUSED/u)
})

test('readUsage：超时会中止请求并标成 timeout', async () => {
  const result = await readUsage({
    kind: 'opencode-go',
    apiKey: 'k',
    timeoutMs: 10,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }),
  })
  assert.equal(result.status, 'network')
  assert.equal(result.reason, 'timeout')
})
