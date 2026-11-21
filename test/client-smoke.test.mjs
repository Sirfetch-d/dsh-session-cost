/**
 * 浏览器半成品冒烟测试：用最小 DOM / React / ui-primitives 桩加载 `client.js`，
 * 走一遍 ModuleLoader 契约 → factory → apply（槽位注册）→ 组件渲染
 * （在途 / 成功 / 明细 / 失败兜底 / 弹窗与关闭原语接线）。
 *
 * 这里不追求还原 React 语义，只保证「模块能加载、注册进正确的槽位、各状态渲染不抛异常、
 * 文案与关键接线正确」——真实的交互与像素验证留给应用内。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 平台 seed 表允许的 require 目标（与 @deepseek-ai/dsh-client-web 的 seed.ts 对齐）。 */
const SEED_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * 建一个最小 React 桩：createElement 出普通对象树，useState 按预置队列返回。
 * @param {Array} states - 每次 useState 依次返回的 `[value, setter]`。
 * @param {Array} refs - 每次 useRef 依次返回的 ref 对象（默认按初值新建）。
 * @returns {object} React 形状的桩，另记录 effect 次数。
 */
function createReactStub(states, refs = []) {
  const queue = [...states]
  const refQueue = [...refs]
  /** 最小类组件基类：错误边界用例需要它。 */
  class Component {
    constructor(props) { this.props = props ?? {} }
    setState(next) { this.state = { ...this.state, ...next } }
  }
  const stub = {
    Component,
    Fragment: Symbol('Fragment'),
    effects: 0,
    layoutEffects: 0,
    layoutCleanups: [],
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter(child => child !== null && child !== undefined) }
    },
    useState(initial) {
      return queue.length > 0 ? queue.shift() : [initial, () => {}]
    },
    useEffect() { stub.effects += 1 },
    // 定位 hook 在 layout effect 里测位：桩直接执行一次，便于断言几何与清理。
    useLayoutEffect(effect) {
      stub.layoutEffects += 1
      const cleanup = effect()
      if (typeof cleanup === 'function') stub.layoutCleanups.push(cleanup)
      return cleanup
    },
    useRef(initial) { return refQueue.length > 0 ? refQueue.shift() : { current: initial ?? null } },
    memo: component => component,
  }
  return stub
}

/**
 * 一次遍历同时收集文本与宿主元素。
 *
 * 必须只走一遍：函数组件在遍历时被调用，而 useState 桩的队列会被消耗。
 * @param {object} node - 元素树。
 * @param {{text: string[], elements: object[]}} acc - 收集器。
 * @returns {{text: string[], elements: object[]}} 同一个收集器。
 */
function walk(node, acc = { text: [], elements: [] }) {
  if (node === null || node === undefined || node === false) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.text.push(String(node)); return acc }
  if (Array.isArray(node)) { for (const item of node) walk(item, acc); return acc }
  if (typeof node.type === 'function' && node.type.isPanelBoundary === true) {
    // 类组件：最小 React 桩不执行它的 render，直接把它当容器往下走。
    acc.elements.push(node)
    for (const child of node.children) walk(child, acc)
    return acc
  }
  if (typeof node.type === 'function') { walk(node.type({ ...node.props, children: node.children }), acc); return acc }
  acc.elements.push(node)
  for (const child of node.children) walk(child, acc)
  return acc
}

/**
 * 组件里的 useState 顺序（改动组件时要同步这里）：
 * 1) 弹窗开关 `open`，2) 悬停态 `hover`，3) 弹窗坐标（本地锚点 hook），
 * 4) 取数状态，5) 轮询 tick。
 * @param {object} [options] - 预置值。
 * @returns {Array} 依次交给 useState 的 `[value, setter]`。
 */
function hooks({ open = false, hover = false, pos = { left: 10, top: 20 }, state } = {}) {
  return [[open, () => {}], [hover, () => {}], [pos, () => {}], [state ?? { phase: 'loading' }, () => {}]]
}

/** 加载 client.js 并返回它注册的 bundle。 */
function loadBundle() {
  let loaded
  globalThis.window = {
    __ModuleLoader__: { load: spec => { loaded = spec } },
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.document = {
    body: {},
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
  }
  // client.js 是无导入的普通脚本，直接求值即可。
  new Function(source)()
  assert.ok(loaded !== undefined, 'client.js 必须调用 window.__ModuleLoader__.load')
  return loaded
}

/** 建一个最小客户端 ctx，并把槽位注册捕获下来。 */
function createClientCtx() {
  const captured = { slot: undefined, component: undefined, localeNamespaces: [], slots: [] }
  const ctx = {
    effect: fn => fn(),
    locale: {
      register: (ns) => { captured.localeNamespaces.push(ns); return () => {} },
      bind: () => (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
    },
    slots: {
      inject: (key, callback) => { captured.injectKey = key; callback() },
      register: (options, component) => {
        captured.slots.push({ options, component })
        if (captured.slot === undefined) { captured.slot = options; captured.component = component }
      },
    },
    get: () => undefined,
  }
  return { ctx, captured }
}

/**
 * 加载 bundle 并 apply。
 * @param {Array} states - useState 预置。
 * @returns {object} bundle/plugin/ctx/captured/react。
 */
function applyClient(states = []) {
  const bundle = loadBundle()
  const react = createReactStub(states)
  const plugin = bundle.factory(spec => {
    if (spec === 'react') return react
    if (spec === 'react-dom') return { createPortal: element => element }
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      // DSH 0.2.2 删掉了 useAnchoredPosition：桩里刻意不再提供，仍调用就会抛错。
      return { useDismissOnOutsidePointer: () => {} }
    }
    throw new Error(`unexpected require(${spec})`)
  })
  const { ctx, captured } = createClientCtx()
  plugin.apply(ctx)
  return { bundle, plugin, ctx, captured, react }
}

/** 一次成功响应的样例。 */
function report(overrides = {}) {
  return {
    ok: true,
    sessionId: 's1',
    currency: 'CNY',
    updatedAt: Date.UTC(2026, 8, 25, 13, 2, 49),
    estimate: {
      amount: 2.34, display: '¥2.34', priced: true, converted: false,
      byModel: [
        { key: 'deepseek-flash', tokens: { uncachedInput: 218000, cacheRead: 68000000, cacheWrite: 0, output: 193000, total: 68411000, calls: 285 }, amount: 2.34, priced: true, converted: false },
        { key: 'opencode-go/deepseek-v4.1-flash', tokens: { uncachedInput: 143000000, cacheRead: 2000000, cacheWrite: 0, output: 810000, total: 145810000, calls: 12 }, amount: null, priced: false, converted: false },
      ],
      byProvider: [
        { key: 'deepseek-official', tokens: { uncachedInput: 218000, cacheRead: 68000000, cacheWrite: 0, output: 193000, total: 68411000, calls: 285 }, amount: 2.34, priced: true, converted: false },
        { key: 'magpie', tokens: { uncachedInput: 143000000, cacheRead: 2000000, cacheWrite: 0, output: 810000, total: 145810000, calls: 12 }, amount: null, priced: false, converted: false },
      ],
      routes: [{
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        amount: 2.34,
        tokens: { total: 68_000_000 },
        rates: { cacheHitPer1M: 0.04, cacheMissPer1M: 2, outputPer1M: 8, offPeakFactor: 0.5 },
      }, {
        provider: 'magpie',
        model: 'opencode-go/deepseek-v4.1-flash',
        amount: null,
        tokens: { total: 145_810_000 },
        rates: null,
      }],
      unpriced: [{ provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash', reason: 'fx' }],
    },
    tokens: { uncachedInput: 218_000, cacheRead: 68_000_000, cacheWrite: 0, output: 193_000, total: 68_411_000, calls: 285 },
    bounds: { settlements: 285 },
    today: {
      status: 'ready', label: 'UTC+8', amount: 9.46, display: '¥9.46', currency: 'CNY',
      priced: true, unpriced: [], sessions: 13,
      since: Date.UTC(2026, 8, 24, 16, 0, 0), until: Date.UTC(2026, 8, 25, 16, 0, 0),
    },
    balance: {
      status: 'ready', source: 'apikey',
      primary: { currency: 'CNY', total: 97.2, display: '¥97.20' },
      baseline: { total: 97.27, at: Date.UTC(2026, 8, 25, 13, 1, 0), display: '¥97.27' },
      spentSince: { amount: 0.07, currency: 'CNY', display: '¥0.070', scope: 'account' },
    },
    ...overrides,
  }
}

const usage = { uncachedInputTokens: 218_000, outputTokens: 193_000, cacheReadTokens: 68_000_000, cacheWriteTokens: 0 }

test('client.js 用包名注册，并返回合法插件对象', () => {
  const { bundle, plugin } = applyClient()
  assert.equal(bundle.id, manifest.name, 'ModuleLoader id 必须等于包名')
  assert.equal(typeof bundle.factory, 'function')
  assert.equal(plugin.name, 'session-cost')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.inject.includes('slots') && plugin.inject.includes('locale'))
})

test('只 require 平台 seed 表里的模块', () => {
  const specs = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/gu)].map(match => match[1])
  assert.ok(specs.length > 0, '应至少 require react')
  for (const spec of specs) assert.ok(SEED_MODULES.includes(spec), `require('${spec}') 不在 seed 表内`)
  assert.ok(specs.includes('@deepseek-ai/dsh-client-ui-primitives'), '应复用官方弹窗原语')
  assert.ok(specs.includes('react-dom'), 'portal 需要 react-dom')
})

test('apply 注册到 conversation.composer.dock 并注册中英文字典', () => {
  const { captured } = applyClient()
  assert.equal(captured.injectKey, 'conversation.composer.dock')
  assert.equal(captured.slot.name, 'conversation.composer.dock')
  assert.equal(captured.slot.id, 'session-cost')
  assert.equal(captured.slot.order, 10)
  assert.equal(captured.slot.locale, 'composer.session-cost')
  assert.equal(typeof captured.component, 'function')
  assert.deepEqual(captured.localeNamespaces, ['composer.session-cost', 'composer.session-cost'])
})

test('在途状态渲染「读取中」，不抛异常，且弹窗默认关闭', () => {
  const { captured } = applyClient(hooks())
  const { text, elements } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined }))
  assert.match(text.join('|'), /label/)
  assert.match(text.join('|'), /loading/)
  const pill = elements.find(element => element.props['data-session-cost'] !== undefined)
  assert.equal(pill?.props['aria-haspopup'], 'dialog')
  assert.equal(pill?.props['aria-expanded'], false)
  assert.equal(elements.find(element => element.props['data-session-cost-panel'] !== undefined), undefined)
})

test('宿主返回成功时渲染金额', () => {
  const { captured } = applyClient(hooks({ state: { phase: 'ready', data: report() } }))
  const { text } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => usage }))
  assert.match(text.join('|'), /¥2\.34/)
})

test('明细面板渲染 token、按模型、单价与余额（含基线时间）', () => {
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data: report() } }))
  const { text, elements } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => usage }))
  const joined = text.join('|')
  for (const expected of [
    'titleEstimate', 'input', 'cacheRead', 'output', 'total', 'settlements',
    'cacheHitRate', '99.7%',
    'byModel', 'deepseek-flash', '¥2.34',
    'rates', '0.04', 'ratesOffPeak',
    'titleBalance', 'balanceNow', 'balanceSourceApiKey', '¥97.20', 'balanceSpent', '¥0.070',
    'today', 'UTC+8', '¥9.46',
    'updated',
  ]) {
    assert.ok(joined.includes(expected), `面板应包含 ${expected}`)
  }
  // 两段长说明不占版面，只作为悬停提示。
  assert.ok(!joined.includes('todayScope'), '今日消费的说明不应出现在正文')
  assert.ok(!joined.includes('balanceAccountScope'), '余额口径说明不应出现在正文')
  // 面板用精确值，方便核对金额。
  assert.ok(joined.includes('68,000,000'), 'token 应以千分位精确值展示')
  assert.ok(joined.includes('218,000'))
  // 与官方用量面板一致：没有写入缓存这一桶时不占一行（只看行标签，单价行里另有语境）。
  const labels = elements.filter(element => element.type === 'dt').map(element => element.children[0])
  assert.ok(!labels.includes('cacheWrite'), 'cacheWrite 为 0 时不应占一行')
  assert.ok(!joined.includes('noPrice'), '有单价时不应显示未配置单价提示')
  assert.match(joined, /balanceSpent.*21:01:00/s, '余额变化的标签应带基线时间')
  const panel = elements.find(element => element.props['data-session-cost-panel'] !== undefined)
  assert.equal(panel?.props.role, 'dialog')
})

test('provider 上报了缓存写入时才显示该行', () => {
  const data = report({ tokens: { uncachedInput: 1000, cacheRead: 2000, cacheWrite: 3000, output: 400, total: 6400, calls: 1 } })
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data } }))
  const { text } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined }))
  const joined = text.join('|')
  assert.ok(joined.includes('cacheWrite'), '缓存写入非零时应显示该行')
  assert.ok(joined.includes('3,000'))
  // 命中率基数含写入桶：(2000 / (1000+2000+3000)) = 33.3%
  assert.ok(joined.includes('33.3%'))
})

test('今日统计不可用时显示占位而不隐藏整段', () => {
  const data = report({ today: { status: 'failed', reason: 'no-sessions-root', label: 'UTC+8' } })
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data } }))
  const joined = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined })).text.join('|')
  assert.ok(joined.includes('today'), '今日消费这一行应保留')
  assert.ok(joined.includes('—'), '不可用时给占位')
  assert.ok(joined.includes('balanceNow'), '其余余额行不受影响')
})

test('宿主没返回 today 段时不影响面板渲染', () => {
  const data = report()
  delete data.today
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data } }))
  const joined = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined })).text.join('|')
  assert.ok(joined.includes('titleBalance'))
  assert.ok(!joined.includes('today'), '缺失时不该凭空造一行')
})

test('几乎全命中时不把命中率四舍五入成 100%', () => {
  const data = report({ tokens: { uncachedInput: 1000, cacheRead: 999_000, cacheWrite: 0, output: 10, total: 1_000_010, calls: 1 } })
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data } }))
  const joined = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined })).text.join('|')
  assert.ok(joined.includes('99.9%'), `应显示真实精度：${joined}`)
  assert.ok(!joined.includes('100%'), '部分命中不得显示为 100%')
})

test('全部命中显示 100%', () => {
  const data = report({ tokens: { uncachedInput: 0, cacheRead: 5000, cacheWrite: 0, output: 10, total: 5010, calls: 1 } })
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data } }))
  const joined = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined })).text.join('|')
  assert.ok(joined.includes('100%'))
})

test('弹窗定位：贴在药丸上方、按视口夹取，并在滚动/缩放时重算、卸载时解绑', () => {
  const bundle = loadBundle()
  const anchor = { rect: { left: 1200, right: 1260, top: 300, bottom: 320 }, getBoundingClientRect() { return this.rect } }
  const panel = { offsetWidth: 240, offsetHeight: 120 }
  const refs = [{ current: anchor }, { current: panel }]
  const positions = []
  const react = createReactStub([
    [true, () => {}],
    [false, () => {}],
    [null, value => { positions.push(value) }],
    [{ phase: 'ready', data: report() }, () => {}],
  ], refs)
  const added = []
  const removed = []
  globalThis.window.innerWidth = 1280
  globalThis.window.innerHeight = 800
  globalThis.window.addEventListener = (type, handler, capture) => { added.push({ type, handler, capture }) }
  globalThis.window.removeEventListener = (type, handler, capture) => { removed.push({ type, handler, capture }) }
  globalThis.document.documentElement = { hasAttribute: () => false }
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => (name === '--dsh-frame-top-clearance' ? '64' : '') })
  const plugin = bundle.factory(spec => {
    if (spec === 'react') return react
    if (spec === 'react-dom') return { createPortal: element => element }
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { useDismissOnOutsidePointer: () => {} }
    throw new Error(`unexpected require(${spec})`)
  })
  let component
  plugin.apply({
    effect: fn => fn(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (key, cb) => cb(), register: (options, value) => { if (options.id === 'session-cost') component = value } },
    get: () => undefined,
  })
  component({ sessionId: 's1', t: key => key, useProjection: () => usage })
  // 右侧触发点：left 夹到 1280 - 240 - 12；top 走「上方 8px 间距」，且不低于顶部拖拽带。
  assert.deepEqual(positions[0], { left: 1028, top: 172 }, '应贴在触发点上方并夹进视口')
  anchor.rect = { left: 100, right: 160, top: 300, bottom: 320 }
  added.find(item => item.type === 'scroll').handler()
  assert.deepEqual(positions[1], { left: 100, top: 172 }, '滚动时应重算')
  assert.equal(added.filter(item => item.type === 'scroll').length, 1, '应监听捕获阶段滚动')
  assert.equal(added.filter(item => item.type === 'resize').length, 1, '应监听窗口缩放')
  react.layoutCleanups[0]()
  assert.deepEqual(removed.map(item => item.type).sort(), ['resize', 'scroll'], '卸载时应解绑两个监听')
})

test('点外部关闭仍走官方原语 useDismissOnOutsidePointer', () => {
  const bundle = loadBundle()
  const react = createReactStub(hooks({ open: true, state: { phase: 'ready', data: report() } }))
  const calls = { dismiss: 0 }
  const primitives = {
    useDismissOnOutsidePointer: (root, open, setOpen, panel) => {
      calls.dismiss += 1
      calls.dismissArgs = { root: root !== undefined, open, hasSetter: typeof setOpen === 'function', panel: panel !== undefined }
    },
  }
  const plugin = bundle.factory(spec => {
    if (spec === 'react') return react
    if (spec === 'react-dom') return { createPortal: element => element }
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require(${spec})`)
  })
  let component
  plugin.apply({
    effect: fn => fn(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (key, cb) => cb(), register: (options, value) => { if (options.id === 'session-cost') component = value } },
    get: () => undefined,
  })
  const { elements } = walk(component({ sessionId: 's1', t: key => key, useProjection: () => usage }))
  assert.equal(calls.dismiss, 1, '应使用 useDismissOnOutsidePointer 处理点外部关闭')
  assert.deepEqual(calls.dismissArgs, { root: true, open: true, hasSetter: true, panel: true })
  const panel = elements.find(element => element.props['data-session-cost-panel'] !== undefined)
  assert.equal(panel?.props.style.position, 'fixed', '面板固定在视口（portal + 锚点定位）')
  assert.equal(panel?.props.style.left, 10, '位置来自锚点计算')
  assert.equal(panel?.props.style.top, 20)
})

test('Escape 关闭：open 时注册 document keydown 并回调关闭', () => {
  const listeners = []
  const originalDocument = globalThis.document
  const originalFetch = globalThis.fetch
  const bundle = loadBundle()
  const react = createReactStub(hooks({ open: true, state: { phase: 'ready', data: report() } }))
  // 这个用例要让 effect 真的执行，才能观察到 keydown 的注册。
  const cleanups = []
  react.useEffect = (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  globalThis.document = {
    ...globalThis.document,
    addEventListener: (type, handler) => { listeners.push([type, handler]) },
    removeEventListener: () => {},
  }
  globalThis.fetch = () => Promise.reject(new Error('not under test'))
  try {
    const plugin = bundle.factory(spec => {
      if (spec === 'react') return react
      if (spec === 'react-dom') return { createPortal: element => element }
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
        return { useDismissOnOutsidePointer: () => {} }
      }
      throw new Error(`unexpected require(${spec})`)
    })
    let component
    plugin.apply({
      effect: fn => fn(),
      locale: { register: () => () => {}, bind: () => key => key },
      slots: { inject: (key, cb) => cb(), register: (options, value) => { if (options.id === 'session-cost') component = value } },
      get: () => undefined,
    })
    component({ sessionId: 's1', t: key => key, useProjection: () => usage })
    const keydown = listeners.find(([type]) => type === 'keydown')
    assert.ok(keydown !== undefined, 'open 时应注册 keydown 监听')
    assert.doesNotThrow(() => { keydown[1]({ key: 'Escape' }) })
  } finally {
    for (const cleanup of cleanups) cleanup()
    globalThis.document = originalDocument
    globalThis.fetch = originalFetch
  }
})

test('按模型与按供应商分开两节，标题不再重复', () => {
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data: report() } }))
  const { elements, text } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined }))
  const titles = elements.filter(element => element.props.style?.display === 'flex').map(element => element.children[0].children[0])
  assert.equal(titles.filter(title => title === 'byModel').length, 1, '「按模型」只应出现一次')
  assert.equal(titles.filter(title => title === 'byProvider').length, 1, '应新增「按供应商」一节')
  const joined = text.join('|')
  assert.ok(joined.includes('byProvider'), '供应商维度要渲染出来')
  // 两条路由都有 token 时，未定价那条显示 token 并带单位，不会和金额混在一起。
  assert.ok(joined.includes('146M tok'), '没有可折算金额的行显示 token 数并带单位')
  // 只有「缺汇率」的路由不给提示：金额已经按原生币种显示在明细里了。
  assert.ok(!joined.includes('titleUnpriced'), '缺汇率不该弹提示段')
  assert.ok(!joined.includes('noRate'), '缺汇率不再单独提示')
})

test('缺汇率不提示、按原生币种显示；配了汇率则折算并标 ≈', () => {
  // 情形一：只有 USD 价目的模型 + 展示币种是 CNY + 没配汇率 → 直接按美元显示，不给提示。
  const noRate = report({
    estimate: {
      ...report().estimate,
      amount: 1.26, currency: 'USD', nativeTotal: true, display: '$1.26', priced: false, converted: false,
      byModel: [{ key: 'opencode-go/deepseek-v4.1-flash', tokens: { uncachedInput: 143000000, cacheRead: 0, cacheWrite: 0, output: 0, total: 143000000, calls: 3 }, amount: null, priced: false, converted: false, native: { amount: 1.26, currency: 'USD' } }],
      byProvider: [{ key: 'magpie', tokens: { uncachedInput: 143000000, cacheRead: 0, cacheWrite: 0, output: 0, total: 143000000, calls: 3 }, amount: null, priced: false, converted: false, native: { amount: 1.26, currency: 'USD' } }],
      unpriced: [{ provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash', reason: 'fx' }],
    },
  })
  const nativeWalk = walk(applyClient(hooks({ open: true, state: { phase: 'ready', data: noRate } }))
    .captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined }))
  const joined = nativeWalk.text.join('|')
  const labels = nativeWalk.elements.filter(element => element.type === 'dt').map(element => element.children[0])
  const values = nativeWalk.elements.filter(element => element.type === 'dd').map(element => element.children[0])
  assert.ok(!joined.includes('titleUnpriced'), '缺汇率不该弹「未配置单价」段')
  assert.ok(!joined.includes('noRate') && !joined.includes('rateHint'), '缺汇率不再有正文提示')
  assert.equal(values.filter(value => value === '$1.26').length, 2, '按模型与按供应商两节都直接用美元符号显示')
  // 总额也得跟着变成美元，否则会出现「合计 ¥0.00 / 明细 $1.26」的自相矛盾读法。
  const headerValues = nativeWalk.elements
    .filter(element => element.props.style?.color === 'var(--dsw-alias-brand-primary)')
    .map(element => element.children[0])
  assert.ok(headerValues.includes('$1.26'), '总额按原生币种显示')
  assert.ok(!joined.includes('¥0.00'), '不该再出现与明细矛盾的 ¥0.00 合计')
  // 模型名本身当然会作为「按模型」那一行的标签出现；这里要挡的是警告文案里的那种「点名」。
  assert.ok(!joined.includes('noPrice'), '不该出现「未配置单价，未计入金额」的警告')
  assert.ok(labels.includes('opencode-go/deepseek-v4.1-flash'), '模型维度照常列出模型名')
  // 口径放在悬停提示里，不占版面。
  const hoverTitles = nativeWalk.elements.filter(element => element.props.title !== undefined).map(element => element.props.title)
  assert.ok(hoverTitles.some(title => String(title).includes('nativeNote')), '原生币种的口径挂在悬停提示上')

  // 情形二：配了汇率 → 金额出现且带 ≈，总额也带 ≈。
  const converted = report({
    estimate: {
      ...report().estimate,
      amount: 7.1, display: '¥7.10', priced: true, converted: true,
      byModel: [{ key: 'opencode-go/deepseek-v4.1-flash', tokens: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, total: 1e6, calls: 1 }, amount: 7.1, priced: true, converted: true }],
      byProvider: [{ key: 'opencode-go', tokens: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, total: 1e6, calls: 1 }, amount: 7.1, priced: true, converted: true }],
      unpriced: [],
    },
  })
  const second = applyClient(hooks({ open: true, state: { phase: 'ready', data: converted } }))
  const walked = walk(second.captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined }))
  const amounts = walked.elements.filter(element => element.type === 'dd').map(element => element.children[0])
  assert.ok(amounts.includes('≈¥7.10'), '折算来的金额要加 ≈')
  assert.ok(amounts.includes('≈¥7.10'), '总额同样带 ≈')
  const titled = walked.elements.filter(element => element.props.title !== undefined).map(element => element.props.title)
  assert.ok(titled.some(title => String(title).includes('convertedNote')), '折算行要有悬停说明')
})

test('今日消费与余额变化的口径说明挂在悬停提示上', () => {
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data: report() } }))
  const { elements } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined }))
  const titles = elements
    .filter(element => element.type === 'dt' || element.type === 'dd')
    .map(element => element.props.title)
    .filter(title => title !== undefined)
  assert.ok(titles.includes('todayScope'), '今日消费行应有 title 说明')
  assert.ok(titles.includes('balanceAccountScope'), '余额变化行应有 title 说明')
  const texts = elements.filter(element => element.type === 'dd').map(element => element.children[0])
  assert.ok(!texts.includes('todayScope'))
  assert.ok(!texts.includes('balanceAccountScope'))
})

test('宿主失败时降级显示 token 数，并标记失败态', () => {
  const { captured } = applyClient(hooks({ state: { phase: 'ready', data: { ok: false, reason: 'session-not-live' } } }))
  const { text, elements } = walk(captured.component({
    sessionId: 's1', t: key => key, useProjection: () => ({ uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 }),
  }))
  assert.match(text.join('|'), /3500/)
  assert.match(text.join('|'), /tokensOnly/)
  const pill = elements.find(element => element.props['data-session-cost'] !== undefined)
  assert.equal(pill?.props['data-state'], 'failed')
  assert.match(String(pill?.props.title), /hostUnavailable/)
})

test('宿主不可用时展开面板说明原因并给出本地 token 明细', () => {
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'failed' } }))
  const { text } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => usage }))
  const joined = text.join('|')
  for (const expected of ['hostUnavailable', 'hostUnavailableHint', 'localTokens', 'input', 'cacheRead', 'total', '68,000,000']) {
    assert.ok(joined.includes(expected), `兜底面板应包含 ${expected}`)
  }
})

test('未配置单价的模型被明确列出（宿主成功但无单价）', () => {
  const data = report({ estimate: { amount: 0, display: '¥0.00', priced: false, routes: [], unpriced: ['magpie/deepseek-v4.1-flash'] } })
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data } }))
  const { text } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => undefined }))
  const joined = text.join('|')
  assert.ok(joined.includes('magpie/deepseek-v4.1-flash'), '应列出未配置单价的模型')
  assert.ok(joined.includes('noPrice'))
  assert.ok(joined.includes('priceHint'))
})

test('外观全部内联，不依赖运行时注入的样式表', () => {
  // 曾经的实现往 <style> 里塞规则；一旦注入失败或被覆盖，按钮会退化成系统默认灰按钮，
  // 面板也会变成 body 末尾的一串无样式文本（看起来就是「点了没反应」）。这里把它钉死。
  assert.ok(!source.includes("createElement('style')"), '不应再注入 <style>')
  assert.ok(!source.includes('document.head'), '不应再触碰 document.head')
  const { captured } = applyClient(hooks({ state: { phase: 'ready', data: report() } }))
  const { elements } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => usage }))
  const pill = elements.find(element => element.props['data-session-cost'] !== undefined)
  assert.equal(pill?.props.style.appearance, 'none', '必须显式清掉系统按钮外观')
  assert.equal(pill?.props.style.background, 'transparent')
  assert.equal(pill?.props.style.border, '0')
  assert.equal(pill?.props.style.fontSize, '12px')
  assert.equal(pill?.props.style.fontFamily, 'inherit')
})

test('锚点还没测出位置时用可见兜底，避免面板永远隐形', () => {
  const bundle = loadBundle()
  const react = createReactStub(hooks({ open: true, pos: null, state: { phase: 'ready', data: report() } }))
  const plugin = bundle.factory(spec => {
    if (spec === 'react') return react
    if (spec === 'react-dom') return { createPortal: element => element }
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      return { useDismissOnOutsidePointer: () => {} }
    }
    throw new Error(`unexpected require(${spec})`)
  })
  let component
  plugin.apply({
    effect: fn => fn(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (key, cb) => cb(), register: (options, value) => { if (options.id === 'session-cost') component = value } },
    get: () => undefined,
  })
  const panel = walk(component({ sessionId: 's1', t: key => key, useProjection: () => usage }))
    .elements.find(element => element.props['data-session-cost-panel'] !== undefined)
  assert.equal(panel?.props.style.visibility, undefined, '兜底不得使用 visibility: hidden')
  assert.equal(typeof panel?.props.style.left, 'number')
  assert.equal(typeof panel?.props.style.top, 'number')
})

test('面板内容被 error boundary 包住，渲染期抛错也不会变成空白', () => {
  const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data: report() } }))
  const { elements } = walk(captured.component({ sessionId: 's1', t: key => key, useProjection: () => usage }))
  const boundary = elements.find(element => element.type?.isPanelBoundary === true)
  assert.ok(boundary !== undefined, '面板内容必须由 error boundary 包裹')
  assert.equal(typeof boundary.type.getDerivedStateFromError, 'function', '边界要能捕获渲染期错误')
  assert.equal(typeof boundary.type.prototype.componentDidCatch, 'function')
  assert.equal(typeof boundary.props.fallbackText, 'string')

  // 直接驱动边界：捕获到错误后应渲染兜底文案而不是空白。
  // 注意桩里 children 与 props 分开存，真实 React 会挂在 props.children 上。
  const instance = new boundary.type({ ...boundary.props, children: boundary.children })
  instance.state = { failed: false }
  assert.notEqual(instance.render(), undefined, '未出错时渲染原内容')
  instance.state = { failed: true }
  const fallback = instance.render()
  assert.equal(fallback.type, 'div')
  assert.deepEqual(fallback.children, [boundary.props.fallbackText])
})

test('取数走宿主路由：带 same-origin 凭据，并以 tokenUsage 投影与可见性作为刷新信号', () => {
  assert.ok(source.includes("credentials: 'same-origin'"), 'fetch 必须带 same-origin 凭据（鉴权 cookie）')
  assert.ok(source.includes('/plugin/session-cost'), 'fetch 必须打到宿主路由')
  assert.ok(source.includes("useProjection('tokenUsage')"), '必须用 tokenUsage 投影作为刷新信号')
  assert.ok(source.includes('visibilitychange'), '窗口重新可见时应刷新')
})

test('遮蔽官方 usage 药丸：同 id + 更低 priority（不能再同优先级抢注）', () => {
  const { captured } = applyClient()
  const byId = new Map(captured.slots.map(entry => [entry.options?.id, entry]))
  assert.deepEqual([...byId.keys()], ['session-cost', 'usage'], '消费自己一格 + 遮蔽官方 usage 一格')
  const shadow = byId.get('usage')
  assert.equal(shadow.options.name, 'conversation.composer.dock')
  // 关键不变量：priority 必须低于官方（官方默认 0）。同优先级会抛错并让 ui-chat 激活失败。
  assert.equal(shadow.options.priority, -1, '遮蔽必须用更低 priority')
  assert.equal(shadow.component(), null, '这一格渲染空：内容在消费弹窗里')
  assert.equal(byId.get('session-cost').options.priority, undefined, '自己那格不设 priority')
})

test('弹窗里的「订阅额度」：三个窗口的已用 + 重置倒计时；失败时写原因', () => {
  /** 带插值的翻译桩，方便断言具体百分比。 */
  const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)
  /** 渲染一次弹窗内容（open=true 的明细面板）。 */
  const renderPanel = overrides => {
    const data = { ...report(), ...overrides }
    const { captured } = applyClient(hooks({ open: true, state: { phase: 'ready', data } }))
    return walk(captured.component({ sessionId: 's1', t, useProjection: () => usage }))
  }
  const inHours = hours => new Date(Date.now() + hours * 3_600_000).toISOString()
  const subscription = {
    label: 'OpenCode Go',
    plan: '',
    status: 'ok',
    order: ['rolling', 'weekly', 'monthly'],
    windows: {
      rolling: { percent: 4, remaining: 96, status: 'ok', resetsAt: inHours(2) },
      weekly: { percent: 44, remaining: 56, status: 'ok', resetsAt: inHours(26) },
      monthly: { percent: 91, remaining: 9, status: 'ok', resetsAt: inHours(500) },
    },
  }
  const withQuota = renderPanel({ subscription })
  const joined = withQuota.text.join('|')
  assert.ok(joined.includes('subscriptionTitle'), `要有「订阅额度」：${joined}`)
  for (const key of ['subscriptionRolling', 'subscriptionWeekly', 'subscriptionMonthly']) {
    assert.ok(joined.includes(key), `要有 ${key}`)
  }
  // 条与字都写余量（与热力图额度带同一口径）。
  assert.ok(joined.includes('subscriptionRemaining'), `要有「剩余」：${joined}`)
  for (const percent of ['96%', '56%', '9%']) assert.ok(joined.includes(percent), `要有剩余 ${percent}：${joined}`)
  assert.ok(!joined.includes('subscriptionUsed'), `不该再写「已用」：${joined}`)
  assert.ok(joined.includes('subscriptionReset'), '要有重置倒计时')
  // 91% 那一行带 warn 标记（高用量转警告色）。
  const warnRows = withQuota.elements.filter(element => String(element.props?.style?.color ?? '').includes('state-warn'))
  assert.ok(warnRows.length > 0, '高用量那一行要警告色')

  const failed = renderPanel({ subscription: { label: 'OpenCode Go', plan: '', status: 'no-key' } })
  assert.ok(failed.text.join('|').includes('subscriptionNoKey'), '失败要如实写原因')
  assert.ok(!renderPanel({}).text.join('|').includes('subscriptionTitle'), '宿主没给这一段就不渲染')
})
