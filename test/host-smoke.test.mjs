/**
 * 宿主半成品冒烟测试：用最小假 harness 加载 `index.js`，驱动一次真实 HTTP 路由调用，
 * 断言路由注册、栅栏、响应结构与计价结果。这层覆盖的是「装上真应用之前的最后一道门」。
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { consumeSession, createUsageState } from '../lib/usage-fold.js'
import { dayWindow } from '../lib/session-log.js'
import { isPeak } from '../lib/pricing.js'

/** 造一个走 OpenCode Go（只有美元价目）的会话。 */
function opencodeSession() {
  const events = [{
    type: 'assistant/message',
    seq: 0,
    // 2026-09-28 是周一，UTC 03:01 落在高峰时段，便于直接按高峰价断言。
    time: Date.UTC(2026, 8, 28, 3, 1),
    data: {
      turn: 0, step: 0,
      usage: { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2e6 },
      message: { source: { kind: 'model', provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    },
  }]
  return { seq: events.length, eventAt: seq => events[seq] }
}

/** 造一个会话：两次结算 + 一条非结算事件。 */
function fakeSession() {
  const events = [
    { type: 'step/start', seq: 0, time: Date.UTC(2026, 8, 27, 3, 0), data: {} },
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.UTC(2026, 8, 27, 3, 1),
      data: {
        turn: 0, step: 0,
        usage: { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0, totalTokens: 3e6 },
        message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      },
    },
    { type: 'tool/call', seq: 2, time: Date.UTC(2026, 8, 27, 3, 2), data: {} },
  ]
  return { seq: events.length, eventAt: seq => events[seq] }
}

/** 造一个最小 ctx：`get` 直接返回假服务，`effect` 立即执行并记下清理函数。 */
function fakeCtx(options = {}) {
  const captured = { route: undefined, routes: new Map(), effects: 0, disposers: [] }
  const services = {
    // 只有 s1 是活动会话；其他 id 与 ghost 一样返回 undefined。
    sessions: { get: id => (id === 's1' ? fakeSession() : id === 's2' ? opencodeSession() : undefined) },
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'file' }) },
    deepseekAccount: undefined,
    webServer: options.noWebServer === true ? undefined : {
      register: route => {
        captured.routes.set(route.path, route)
        // 兼容既有断言：captured.route 仍指向主路由。
        if (route.path === '/plugin/session-cost') captured.route = route
        return () => { captured.routes.delete(route.path) }
      },
    },
    connection: options.noConnection === true ? undefined : {
      requestRejection: () => options.reject === undefined ? undefined : options.reject,
    },
  }
  const ctx = {
    baseUrl: options.baseUrl ?? 'file:///tmp/session-cost-test/',
    get: name => services[name],
    on: () => () => {},
    effect: fn => {
      captured.effects += 1
      const dispose = fn()
      captured.disposers.push(dispose)
      return dispose
    },
  }
  /** 展开所有 effect，等价于插件卸载（清掉注册重试的定时器）。 */
  captured.disposeAll = () => {
    for (const dispose of captured.disposers.splice(0)) {
      if (typeof dispose === 'function') dispose()
    }
  }
  return { ctx, captured }
}

/** 假请求。 */
function fakeReq(url, headers = {}) {
  return { url, method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } }
}

/** 假响应，收集状态码与响应体。 */
function fakeRes() {
  const out = {}
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body },
  }
}

/** 发起一次路由调用并解析 JSON。 */
async function call(captured, url, headers, reqOverride) {
  const res = fakeRes()
  const path = url === undefined || url === '' ? '/plugin/session-cost' : String(url).split('?')[0]
  const route = captured.routes.get(path) ?? (path === '/plugin/session-cost' ? captured.route : undefined)
  if (route === undefined) throw new Error(`no route for ${path} (have ${[...captured.routes.keys()].join(',')})`)
  await route.handler(reqOverride ?? fakeReq(url, headers), res)
  return { status: res.out.status, body: res.out.body === undefined ? undefined : JSON.parse(res.out.body) }
}

test('apply 注册 /plugin/session-cost 路由（webServer 晚到时靠重试注册）', async () => {
  const { ctx, captured } = fakeCtx()
  apply(ctx, { currency: 'CNY', balanceSource: 'off' })
  assert.equal(captured.route?.kind, 'exact')
  assert.equal(captured.route?.path, '/plugin/session-cost')
  assert.equal(typeof captured.route?.handler, 'function')
})

test('余额查询关闭时返回完整的估算结果', async () => {
  const { ctx, captured } = fakeCtx()
  apply(ctx, { currency: 'CNY', balanceSource: 'off' })
  const { status, body } = await call(captured, '/plugin/session-cost?session=s1')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 's1')
  assert.equal(body.currency, 'CNY')
  assert.equal(body.tokens.calls, 1)
  assert.deepEqual(body.tokens, {
    uncachedInput: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6, total: 3e6, calls: 1,
  })
  // 2026-09-27 是周日 → 低谷：内置表是高峰价 (0.04 + 2 + 8)，低谷为一半。
  assert.equal(body.estimate.amount, (0.04 + 2 + 8) / 2)
  assert.equal(body.estimate.display, '¥5.02')
  assert.equal(body.estimate.priced, true)
  assert.equal(body.balance.status, 'off')
  assert.equal(body.estimate.routes[0].model, 'deepseek-flash')
  assert.equal(body.bounds.settlements, 1)
})

test('闸栏拒绝时返回 401/403，不回数据', async () => {
  for (const rejection of [401, 403]) {
    const { ctx, captured } = fakeCtx({ reject: rejection })
    apply(ctx, { balanceSource: 'off' })
    const { status, body } = await call(captured, '/plugin/session-cost?session=s1')
    assert.equal(status, rejection)
    assert.equal(body.ok, false)
    assert.equal(body.reason, 'unauthorized')
  }
})

test('非回环来源直接 403', async () => {
  const { ctx, captured } = fakeCtx()
  apply(ctx, { balanceSource: 'off' })
  const remote = { url: '/plugin/session-cost?session=s1', method: 'GET', headers: {}, socket: { remoteAddress: '10.0.0.8' } }
  const { status, body } = await call(captured, '', {}, remote)
  assert.equal(status, 403)
  assert.equal(body.reason, 'forbidden')
})

test('非法会话 id / 会话不在活动状态都安静失败', async () => {
  const { ctx, captured } = fakeCtx()
  apply(ctx, { balanceSource: 'off' })
  assert.equal((await call(captured, '/plugin/session-cost')).body.reason, 'bad-session')
  assert.equal((await call(captured, `/plugin/session-cost?session=${'x'.repeat(400)}`)).body.reason, 'bad-session')
  assert.equal((await call(captured, '/plugin/session-cost?session=ghost')).body.reason, 'session-not-live')
})

test('enabled:false 时不返回金额', async () => {
  const { ctx, captured } = fakeCtx()
  apply(ctx, { enabled: false })
  const { body } = await call(captured, '/plugin/session-cost?session=s1')
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'disabled')
})

test('API key 余额路径：解析凭据 → 打 /user/balance → 归一化钱包', async () => {
  const { ctx, captured } = fakeCtx()
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url, authorization: init.headers.authorization })
    return {
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
      }),
    }
  }
  try {
    apply(ctx, { currency: 'CNY', balanceSource: 'apikey', apiKeyRef: 'DEEPSEEK_API_KEY', subscription: { enabled: false } })
    const { body } = await call(captured, '/plugin/session-cost?session=s1')
    const requested = requests.find(request => String(request.url).includes('/user/balance'))
    assert.ok(requested !== undefined, `要打余额接口：${JSON.stringify(requests.map(r => r.url))}`)
    assert.equal(requested.url, 'https://api.deepseek.com/user/balance')
    assert.equal(requested.authorization, 'Bearer sk-test')
    assert.equal(body.balance.status, 'ready')
    assert.equal(body.balance.source, 'apikey')
    assert.equal(body.balance.primary.display, '¥110.00')
    assert.equal(body.balance.baseline.display, '¥110.00')
    assert.equal(body.balance.spentSince.amount, 0)
    assert.equal(body.balance.wallets[0].granted, 10)
    assert.equal(body.balance.wallets[0].toppedUp, 100)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('余额接口失败时只标记失败，不影响金额', async () => {
  const { ctx, captured } = fakeCtx()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
  try {
    apply(ctx, { balanceSource: 'apikey' })
    const { body } = await call(captured, '/plugin/session-cost?session=s1')
    assert.equal(body.balance.status, 'failed')
    assert.equal(body.balance.reason, 'http-401')
    assert.equal(body.ok, true)
    assert.equal(body.estimate.priced, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('没有 webServer/connection 时 apply 不抛异常', () => {
  const bare = fakeCtx({ noWebServer: true, noConnection: true })
  assert.doesNotThrow(() => { apply(bare.ctx, {}) })
  assert.equal(bare.captured.route, undefined)
  // 卸载：清掉注册重试的定时器，测试进程才能退出。
  bare.captured.disposeAll()
  assert.doesNotThrow(() => { apply({ get: () => undefined, effect: () => {} }, {}) })
})

test('OpenCode Go：只有美元价目时，缺汇率给原生金额、配汇率则折算并标 converted', async () => {
  const noRate = fakeCtx()
  apply(noRate.ctx, { balanceSource: 'off', todayCacheMs: 0 })
  const withoutRate = (await call(noRate.captured, '/plugin/session-cost?session=s2')).body
  // 高峰时段（UTC 03:00 是工作日高峰）：输入 0.30 + 输出 1.20 = 1.50 美元。
  assert.equal(withoutRate.estimate.priced, false)
  // 缺汇率时总额回落到原生币种：¥0.00 与明细里的 $1.50 并列才是真的误导。
  assert.equal(withoutRate.estimate.nativeTotal, true)
  assert.equal(withoutRate.estimate.currency, 'USD')
  assert.equal(withoutRate.estimate.display, '$1.50')
  assert.equal(withoutRate.estimate.converted, false)
  assert.deepEqual(withoutRate.estimate.unpriced, [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reason: 'fx' }])
  assert.equal(Math.round(withoutRate.estimate.byProvider[0].native.amount * 100) / 100, 1.5)
  assert.equal(withoutRate.estimate.byProvider[0].native.currency, 'USD')
  assert.equal(withoutRate.estimate.byProvider[0].key, 'opencode-go')
  assert.equal(withoutRate.estimate.byModel[0].key, 'deepseek-v4.1-flash')

  const withRate = fakeCtx()
  apply(withRate.ctx, { balanceSource: 'off', todayCacheMs: 0, currency: 'CNY', usdToCny: 7.1 })
  const converted = (await call(withRate.captured, '/plugin/session-cost?session=s2')).body
  assert.equal(converted.estimate.priced, true)
  assert.equal(converted.estimate.converted, true, '前端据此给总额加 ≈')
  assert.equal(Math.round(converted.estimate.amount * 100) / 100, Math.round(1.5 * 7.1 * 100) / 100)
  assert.deepEqual(converted.estimate.unpriced, [])
  assert.equal(converted.estimate.byModel[0].converted, true)
})

test('会话根不存在时「今日消费」安静失败，不影响其它段落', async () => {
  const { ctx, captured } = fakeCtx()
  apply(ctx, { balanceSource: 'off', todayCacheMs: 0 })
  const { body } = await call(captured, '/plugin/session-cost?session=s1')
  assert.equal(body.ok, true)
  assert.equal(body.estimate.priced, true)
  assert.equal(body.today.status, 'failed')
  assert.equal(body.today.reason, 'no-sessions-root')
  assert.equal(body.today.label, 'UTC+8')
})

test('「今日消费」按北京时区统计本机会话日志', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-cost-home-'))
  const profile = join(home, 'profiles', 'desktop')
  const sessionDir = join(home, 'sessions', '--w--', 'session-today')
  mkdirSync(profile, { recursive: true })
  mkdirSync(sessionDir, { recursive: true })
  const window = dayWindow(Date.now(), 480)
  const inside = window.start + 60_000
  const line = at => JSON.stringify({
    type: 'assistant/message', seq: 0, time: at,
    data: {
      turn: 0, step: 0,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 },
      message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
    },
  })
  // 一条落在今日窗口内，一条落在窗口之前。
  writeFileSync(join(sessionDir, 'session.jsonl'), `${line(inside)}\n`)
  const older = join(home, 'sessions', '--w--', 'session-older')
  mkdirSync(older, { recursive: true })
  writeFileSync(join(older, 'session.jsonl'), `${line(window.start - 3_600_000)}\n`)
  try {
    const { ctx, captured } = fakeCtx({ baseUrl: `file://${profile}/` })
    apply(ctx, { balanceSource: 'off', todayCacheMs: 0, todayTimezoneOffsetMinutes: 480 })
    const { body } = await call(captured, '/plugin/session-cost?session=s1')
    assert.equal(body.today.status, 'ready')
    assert.equal(body.today.label, 'UTC+8')
    assert.equal(body.today.sessions, 2, '两个会话目录都应被发现')
    // 只有窗口内那条计入：1M 未命中，高峰 2 元/1M，低谷减半。
    assert.equal(body.today.amount, 2 * (isPeak(inside) ? 1 : 0.5))
    assert.equal(body.today.display.startsWith('¥'), true)
    assert.equal(body.today.tokens.uncachedInput, 1_000_000)
    assert.equal(body.today.since, window.start)
    assert.equal(body.today.until, window.end)
    assert.equal(body.today.converted, false, '全是人民币价目时不该标折算')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('折叠状态可被 consumeSession 直接驱动（与端点同一路径）', () => {
  const session = fakeSession()
  const state = createUsageState()
  assert.equal(consumeSession(state, session), 3)
  assert.equal(state.events, 1)
  assert.equal(state.routes['deepseek-official\u0000deepseek-flash'].offPeak.calls, 1)
})

test('弹窗里的「订阅额度」：取官方用量接口、带缓存；关掉/没 key 时如实说明', async () => {
  const usageBody = {
    usage: {
      rolling: { status: 'ok', percent: 4, resetsAt: '2026-10-30T06:05:55.000Z' },
      weekly: { status: 'ok', percent: 44, resetsAt: '2026-11-02T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 44, resetsAt: '2026-11-22T06:58:00.000Z' },
    },
  }
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    return { ok: true, status: 200, async json() { return usageBody } }
  }
  try {
    const { ctx, captured } = fakeCtx()
    apply(ctx, { currency: 'CNY', balanceSource: 'off' })
    const { body } = await call(captured, '/plugin/session-cost?session=s1')
    assert.equal(body.subscription.status, 'ok')
    assert.equal(body.subscription.label, 'OpenCode Go')
    assert.deepEqual(body.subscription.order, ['rolling', 'weekly', 'monthly'])
    assert.equal(body.subscription.windows.weekly.percent, 44)
    assert.equal(body.subscription.windows.weekly.remaining, 56)
    assert.equal(calls.length, 1, '只打一次用量接口')
    assert.ok(calls[0].includes('/inference/go/v1/usage'), `地址要对：${calls[0]}`)
    await call(captured, '/plugin/session-cost?session=s1')
    assert.equal(calls.length, 1, '缓存期内复用')

    const offCtx = fakeCtx()
    apply(offCtx.ctx, { balanceSource: 'off', subscription: { enabled: false } })
    const off = await call(offCtx.captured, '/plugin/session-cost?session=s1')
    assert.equal(off.body.subscription, undefined, '关掉后 payload 里没有这一段')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('按 provider 统计路由：按天数给跨会话的 token 与金额（不需要 live 会话）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-cost-providers-'))
  const profile = join(home, 'profiles', 'desktop')
  const window = dayWindow(Date.now(), 480)
  const at = window.start + 60_000
  const line = (provider, model, input) => JSON.stringify({
    type: 'assistant/message', seq: 0, time: at,
    data: {
      turn: 0, step: 0,
      usage: { inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: input },
      message: { source: { kind: 'model', provider, model } },
    },
  })
  const dirA = join(home, 'sessions', '--w--', 'session-a')
  const dirB = join(home, 'sessions', '--w--', 'session-b')
  mkdirSync(profile, { recursive: true })
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  writeFileSync(join(dirA, 'session.jsonl'), `${line('deepseek-official', 'deepseek-flash', 1_000_000)}\n`)
  writeFileSync(join(dirB, 'session.jsonl'), `${line('opencode-go', 'deepseek-v4.1-flash', 2_000_000)}\n`)
  const { ctx, captured } = fakeCtx({ baseUrl: `file://${profile}/` })
  apply(ctx, { currency: 'CNY', balanceSource: 'off', todayCacheMs: 0, todayTimezoneOffsetMinutes: 480 })
  try {
    const { status, body } = await call(captured, '/plugin/session-cost/providers?days=7')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    const providers = body.providers
    assert.equal(providers.status, 'ready')
    assert.equal(providers.days, 7)
    assert.equal(providers.label, '近 7 天')
    assert.ok(Array.isArray(providers.rows) && providers.rows.length === 2, `两个 provider 各一行：${JSON.stringify(providers.rows)}`)
    const byProvider = new Map(providers.rows.map(row => [row.provider, row]))
    assert.equal(byProvider.get('deepseek-official').tokens.total, 1_000_000)
    assert.equal(byProvider.get('opencode-go').tokens.total, 2_000_000)
    // deepseek 有人民币价目；opencode 只有美元价目 → 给原生金额
    assert.equal(typeof byProvider.get('deepseek-official').display, 'string')
    assert.deepEqual(byProvider.get('opencode-go').native?.currency, 'USD')
    // days 夹取：非法/越界回落到合法值（默认 30，上限 365）
    const fallback = await call(captured, '/plugin/session-cost/providers?days=abc')
    assert.equal(fallback.body.providers.days, 30)
    const clamp = await call(captured, '/plugin/session-cost/providers?days=9999')
    assert.equal(clamp.body.providers.days, 365)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
