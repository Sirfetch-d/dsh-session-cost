# 会话消费 · dsh-session-cost

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在输入框下方的
环境条里显示**当前会话花了多少钱**，点开是明细。

> **English**: a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
> shows the running cost of the current session in the composer dock — estimated from the session's
> real token usage against per-model peak/off-peak rates, cross-checked against your DeepSeek account
> or API-key balance, plus OpenCode Go subscription quota. Everything is read locally; see
> [网络请求与隐私](#网络请求与隐私).

**它做什么**

- 环境条上一个药丸：本会话估算消费（如 `¥1.23`），点开是明细面板；
- 明细里给 token 分项（未命中 / 命中 / 输出 / 合计 / 结算次数）、缓存命中率；
- **按模型**与**按供应商**两个维度的金额，并列出实际生效的单价；
- 账户余额，以及「自插件首次观测起」的余额变化（交叉验证估算是否靠谱）；
- **今日消费**（跨会话统计本机日志，按北京时区切日）；
- **订阅额度**：OpenCode Go 的 5 小时 / 本周 / 本月周期用量、剩余与重置倒计时。

**你需要什么**

- 一个装好的 DSH：官网 <https://www.deepseek.com/harness/>，源码
  <https://github.com/deepseek-ai/deepseek-harness>，文档 <https://deepseek-harness.github.io/deepseek-harness/>；
- 想显示金额不需要任何账号：单价表内置，直接按 token 估算；
- 想显示余额/订阅额度才需要凭据（DeepSeek 账号或 API key / `OPENCODE_GO_API_KEY`），没有就自动跳过。

<!-- 截图：把你的面板截图存成 docs/screenshot.png，然后删掉下面两行注释即可。
![面板](./docs/screenshot.png)
-->

## 面板长什么样

（下面是文本示意，数字随会话变化。）

```
本会话估算消费                        ¥1.23
────────────────────────────────────────────
缓存命中率                           98.7%
输入（未命中缓存）                 123,456
输入（缓存命中）                12,345,678
输出                                45,678
合计                            12,514,812
结算次数                                42

按模型
  deepseek-flash                      ¥1.23
  单价 命中 0.04 / 输入 2 / 输出 8 每 1M token CNY（按结算发生时段计价，低谷 ×0.5）
按供应商
  deepseek-official                   ¥1.23

账户余额
  今日消费 · UTC+8                   ¥4.56
  当前余额 · API key               ¥100.00
  余额变化 · 自 12:34:56             ¥0.78
更新于 12:34:56
```

> 试过用 `id: usage` 接管官方那条「token 总量 · 缓存命中率」药丸，但 dock 那一格由官方
> `dsh-client-ui-chat` 自己注册，插件抢先注册会让 ui-chat 激活失败、整个 web boot 中止
> （`web boot: 1 entry did not activate`）。已经回滚：官方药丸保持原样，插件只注册自己的 cell。
> 想缩小它可以用官方设置 `performanceUsage: 'compact'`（缩成只显示缓存命中率）。

两个数字来源，互相印证：

| 数字 | 来源 | 口径 |
| --- | --- | --- |
| **估算消费**（主数字） | 会话持久日志里每次结算的 `usage`（真实计费 token） | 按模型单价 × 峰谷时段折算，见下 |
| **账户余额 / 会话期间变化** | 已登录的 DeepSeek 账号（平台会话）或当前 API key（`GET /user/balance`） | 账户级真实扣费，余额差值 |

DSH 本身没有任何金额概念（只有 token），所以**单价表由本插件自己维护**，可在配置里覆盖。

## 安装

插件是**本地 bundle**，装在某个 profile 里（桌面版默认 `desktop`）。两种方式任选：

**方式 A：用插件管理器（推荐）**

```sh
git clone https://github.com/Sirfetch-d/dsh-session-cost.git
```

然后在 DSH 的「设置 → 插件」里安装这个目录，或让 agent 调 plugin-manager 的 `install_bundle`，
`target` 传克隆下来的目录绝对路径。它会自己写 profile 依赖（`link:`）并加进
`dsh.profile.bundles`。

**方式 B：手动改 profile**

```sh
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 里加：  "dsh-session-cost": "link:<本目录的绝对路径>"
# package.json 的 dsh.profile.bundles 末尾加："dsh-session-cost"
pnpm install
```

> 换包名/搬目录时容易漏一处：profile 的 `cordis.patch.yml` 里如果给本插件写过
> **override 行**（例如为了开 `debug: true`），那一行的 `name` 也要跟着改。override 按包名
> 解析模块，名字对不上会整行解析失败，表现就是「插件消失」。

**改完 `index.js` / `lib/*.js` 后必须完整重启应用**：宿主半成品由 Node 以 ESM 导入，
profile 重载会复用已缓存的模块，只有新进程才会重新读取文件。`client.js` 改完刷新页面即可
（它走 HTTP 现取），但**移动插件目录后也要重启**——bundle 路径是启动时定下的。

卸载：把 bundle 从 `dsh.profile.bundles` 里去掉、`pnpm remove dsh-session-cost`，再重启。

## 配置

所有选项写在 profile 的 `cordis.patch.yml` 里（没写的用默认值）：

```yaml
- id: session-cost
  name: 'dsh-session-cost'
  config:
    currency: 'CNY'            # 'CNY' | 'USD'
    todayTimezoneOffsetMinutes: 480   # 「今日消费」与「按 provider」统计都按北京时区切日
    todayCacheMs: 60000               # 「今日消费」与「按 provider」统计的重算间隔（两段共用）
    usdToCny: 7.1                     # 可选：美元价目折算成人民币的汇率（无默认值）
    balanceSource: 'auto'      # auto | apikey | account | off
    apiKeyRef: 'DEEPSEEK_API_KEY'
    balanceBaseUrl: 'https://api.deepseek.com'
    balanceCacheMs: 20000
    enabled: true
    debug: false               # true 时写 <profile>/.session-cost/debug.log（超过 512KB 自动截断）
    prices:
      # 想改单价就写在这里：键可以是 "provider/model"、纯 model，或 "*"（兜底）
      deepseek-flash: { cacheHitPer1M: 0.04, cacheMissPer1M: 2, outputPer1M: 8 }
    # defaultPrice: { cacheHitPer1M: 0.04, cacheMissPer1M: 2, outputPer1M: 8 }
    subscription:              # 弹窗里的「订阅额度」段（OpenCode Go 周期用量）
      enabled: true            # false = 不显示这一段，也不会发起用量请求
      kind: 'opencode-go'      # 目前只内置这一个适配器
      apiKeyRef: 'OPENCODE_GO_API_KEY'   # 没配这个凭据就不发请求
      endpoint: ''             # 留空用内置地址；自建代理时填自己的
      refreshMs: 60000         # 结果复用时长
      timeoutMs: 8000          # 单次请求超时
```

- `balanceSource: auto` = 先试 API key，拿不到再试已登录账号。
- 想彻底不联网、只看估算，设 `balanceSource: 'off'`。
- `defaultPrice` 是内置表未命中时的兜底单价；不写就只显示 token、不计金额（不瞎猜）。

## 金额口径

- **token 来源**：会话持久日志里 `assistant/message`（以及 `assistant/attempt`）事件的
  `usage`。口径与 DSH 自己的 `tokenUsage` 投影一致：同一 `(turn, step)` 的**后一次**结算
  **替换**前一次（避免重放/重复结算被计两次），`llm/retry-started` 之后的重试会再次计入
  ——被放弃的那次尝试同样被计费。
- **分价**：`inputTokens` 是**未命中缓存**的输入，`cacheReadTokens` 是命中缓存的输入，
  单价不同；`cacheWriteTokens` 按未命中价计。
- **峰谷**：DeepSeek 高峰为周一至周五 `01:00–04:00` 与 `06:00–10:00` UTC，其余时段为低谷，
  低谷按表价的 50%。插件按每条结算事件**自身的时间**判定时段，所以跨时段的会话会分别计价。
- **内置单价**（每 100 万 token，**高峰价**，低谷自动减半）：

  | 模型 | 币种 | 缓存命中 | 未命中 | 输出 |
  | --- | --- | --- | --- | --- |
  | `deepseek-flash`（V4.1-Flash） | CNY | 0.04 | 2 | 8 |
  | `deepseek-flash` | USD | 0.006 | 0.30 | 1.20 |
  | `deepseek-v4-pro` | CNY | 0.30 | 9 | 27 |
  | `deepseek-v4-pro` | USD | 0.044 | 1.32 | 3.96 |

  来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> 与
  <https://api-docs.deepseek.com/quick_start/pricing/>。CNY / USD 是两套独立定价，
  不做汇率换算——余额接口返回哪种币种，主数字就用对应币种的表。
- **没有配置单价的模型**（例如走 OpenCode / OpenRouter 等网关的模型）不会被瞎猜：
  仍然显示 token 数，但不计入金额，面板里单独列出。

## 按 provider 统计（宿主路由）

`GET /plugin/session-cost/providers?days=N`：本机所有会话日志在「最近 N 天」内，**每个 provider 用了多少
token、折合多少钱**。热力图面板底部那一段就是渲染它（这一段**不在**消费弹窗里）。

- `days`：1–365，默认 30；越界/非法值回落到默认或上限；
- 不需要 live 会话（只读本机日志），但走同一套栅栏：回环来源 + `connection.requestRejection`；
- token 与金额口径与「金额口径」一节完全一致（同一个折叠链路、同一套价目表）；
- 返回 `{ ok: true, providers: { status, days, label, rows, tokens, currency, priced, converted, display, sessions, truncated, since, until } }`，
  每行是 `{ provider, tokens, amount, display, currency, priced, converted, native }`；
- 展示币种是人民币、而某个 provider 只有美元价目（例如 OpenCode Go）时：配了 `usdToCny` 就折算并标 `converted`；
  没配就把原生金额放在 `native` 里，由调用方展示成 `$x.xx*`——不支持就显示 `—`，不编数字；
- 结果按 `todayCacheMs` 缓存，文件级解析结果按 `(窗口, size, mtime)` 缓存。

## 余额说明

- **API key 路径**：`GET {balanceBaseUrl}/user/balance`，`Authorization: Bearer <key>`，
  金额是字符串；返回充值余额与赠金余额。
- **账号路径**：走 harness 的 `ctx.deepseekAccount.getBalance()`（平台会话）。
- **今日消费**不在余额接口里（DeepSeek 没有账单接口），而是**跨会话扫描本机会话日志**估算：
  取 `<dsh home>/sessions/**` 下每个会话目录**最新的一份**日志，只看 `mtime` 落在今日窗口内的文件，
  按每条结算事件自身时间过滤后计价。默认窗口按**北京时区（UTC+8）**切日，
  可用 `todayTimezoneOffsetMinutes` 改成别的时区。它统计的是**本机全部会话**，
  与「当前会话」不是同一个数；子代理会话有自己的日志，因此也会被计入。
- 余额是**账户级**数据：同一账号下的其他客户端/会话也会体现在「会话期间余额变化」里，
  面板上有对应说明。插件在首次观测到该会话时记下基线，重启后会重新取基线。
- 余额查询有 `balanceCacheMs` 短缓存，避免每次渲染都打网络；余额只有两位小数，
  差值比单次调用金额粗，只适合做量级校验。

## 网络请求与隐私

插件对外只做两件事，都可以单独关掉；其余全部是读本机文件：

| 行为 | 目标 | 凭据 | 频率 | 关闭方式 |
| --- | --- | --- | --- | --- |
| 查账户余额 | `GET {balanceBaseUrl}/user/balance`（默认 `https://api.deepseek.com`） | 已登录的 DeepSeek 账号（平台会话），或 `apiKeyRef` 指向的 API key | 每次取数，结果缓存 `balanceCacheMs`（默认 20s） | `balanceSource: off` |
| 查订阅额度 | `GET {subscription.endpoint}`（默认 OpenCode Go 的用量接口） | `subscription.apiKeyRef`（默认 `OPENCODE_GO_API_KEY`） | 每次取数，结果缓存 `subscription.refreshMs`（默认 60s），超时 `timeoutMs`（默认 8s） | `subscription.enabled: false` |

明确几点：

- **没配置的凭据不会发请求**：没有 `OPENCODE_GO_API_KEY` 时那次请求根本不会发生，页面显示「未配置」。
- **不上传任何数据**：会话日志只在本机读（估价、「今日消费」、按 provider 统计都是本地扫描），
  插件没有遥测、没有统计上报。
- **对 UI 只开本机路由**：`GET /plugin/session-cost` 与 `/plugin/session-cost/providers`，
  只接受回环来源，并复用 DSH 连接层自带的校验（`connection.requestRejection`），没有自造鉴权。
- **想彻底断网又保留 token 明细**：`balanceSource: off` + `subscription.enabled: false`，
  此时插件只读本机日志，不发起任何对外请求。

## 排错

徽标变琥珀色、显示「消费 xx tokens」而不是金额，说明**浏览器半成品拿不到宿主数据**。
最常见的成因就是插件刚更新过：宿主半成品由 Node 以 ESM 导入，`profile` 重载与刷新页面都
不会重新读取 `index.js`，必须**完全退出并重开应用**。点开徽标会看到同样的提示。

重启后应有：

```sh
tail -3 ~/.dsh/profiles/desktop/.session-cost/debug.log
# … register attempt#2 (retry) webServer=ready connection=ready
# … route /plugin/session-cost registered
# … report session=… ok=true amount=¥0.1234 tokens=…
```

如果日志里只有 `register attempt#1 … webServer=missing` 且之后没有注册成功，说明宿主环境
里没有 `webServer`（例如 headless profile），此时插件会安静降级，不影响应用。

## 已知限制

- 「按 provider」统计扫的是本机会话日志，只覆盖这台机器；换机器、日志被清理或超过 `todayMaxFiles`
  的文件都不会出现在统计里。
- 「本会话估算消费」只统计当前会话自己的日志；同一次委派的子代理会话不计入这个数字
  （但会体现在「今日消费」里）。
- 估算基于 token 单价表；DeepSeek 官方没有按会话/按请求的费用接口，
  账号级真实扣费只能靠余额差值近似。
- 余额接口没有 `updated_at`，无法判断快照新鲜度。

## 结构

```
index.js            宿主半成品：折叠会话日志 → 计价 → 读余额 → 注册 HTTP 路由
client.js           浏览器半成品：环境条徽标 + 明细面板（手写 ModuleLoader bundle）
lib/pricing.js      价目表、峰谷判定、金额计算与格式化（纯函数）
lib/usage-fold.js   会话事件 → 计费 token 桶（纯函数）
lib/balance.js      API key / 账号余额读取与归一化
lib/session-log.js  跨会话扫描会话日志（多帧 zstd 解码、按目录取最新、文件级缓存）
lib/subscription.js 订阅用量读取与归一化（百分比夹取、失败原因如实降级）
locale/             \{zh,en\}.json：插件卡片用的中英文元信息
icon.svg            插件图标
cordis.patch.yml    profile 补丁：插入 bundle 行与默认配置
tools/              开发工具：真实日志回放校验、今日统计核对、静态自检、会话日志结构查看
test/               单元测试（计价/折叠/今日/订阅）、宿主冒烟、浏览器半成品冒烟
.gitignore          忽略 .devhome/（内含本机会话密钥）与日志、依赖——本目录单独成仓库时也不漏
.devhome/           开发沙箱：另一个独立 DSH_HOME，与日常用的 profile 无关，可随时删除
```

### 弹窗行为与外观

点开的明细面板与官方统计药丸用**同一套机制**：锚点定位（portal 到 body、跟随滚动/缩放
并在视口内夹取）+ `useDismissOnOutsidePointer`（点面板外任意位置关闭）+ `Escape` 关闭，
配色沿用 `stat-dialog` 的 `--dsw-*` token。

> 定位那一段由插件自带（`client.js` 的 `useAnchoredPosition`），不是
> `@deepseek-ai/dsh-client-ui-primitives` 的导出：DSH 0.2.2 删掉了那个导出（官方改走 CSS
> Anchor Positioning，见升级指南 `v0.2.2-alpha.2/css-anchored-menus`）。继续 require 会在渲染时
> `TypeError`，整个药丸被 slot 的错误边界吃掉，看起来就是「底部插件全消失」。
> 自带实现与 0.2.1 的官方语义一致，因此在非 Chromium 浏览器上也能用。

外观**全部走内联样式，刻意不注入 `<style>`**，这是踩过坑后的选择：

- 手写 bundle 注入样式表是一条额外的失败路径——样式没注入、被覆盖、或被更晚的清理移除时，
  `<button>` 会退化成系统默认灰按钮，而 `position: fixed` 丢失的面板会变成 `<body>` 末尾的
  一串无样式文本，看起来就是「点击没反应」；
- 内联样式对宿主应用的规则免疫，不受选择器优先级与插入顺序影响；
- 代价是 `:hover` 要用状态自己实现（pill 用 `onMouseEnter/Leave` 改颜色）。

另外两条防御：面板定位未测出时用**可见**的兜底坐标（而不是 `visibility: hidden`，否则测量一旦
没发生面板就永远看不见），面板内容包在真正的 **error boundary** 里（子组件渲染期抛错时降级为
一行提示，而不是整块空白）。

面板内容：缓存命中率与 token 分项（未命中/命中/输出/合计/结算次数）、**按模型**与**按供应商**两个维度
的金额与 token（同模型跨供应商会合并；没有可折算金额的行显示原生币种金额或带单位的 token 数，
不会和金额混在一起）、**实际生效的单价**、
**今日消费（跨会话，按配置时区切日）**、账户余额与「自插件首次观测起」的余额变化（带基线时刻）、数据更新时间。

口径说明（今日消费是跨会话、余额是账号级）不占版面，挂在对应行的悬停提示（`title`）上。

两处刻意的取舍：

- **token 用精确值（千分位）**，方便自己按单价核对金额；
- **「缓存写入」为 0 时不显示该行**（与官方用量面板同规则）。DeepSeek 的用量里没有这一桶：
  写入缓存的那部分 prompt token 直接按「未命中」价计费，之后再次命中才走缓存命中价。
  只有 provider 真的上报该桶（例如 Anthropic 风格的 `cache_creation_input_tokens`）时才会出现这一行。

### 通信方式与一个上游限制

宿主在 `GET /plugin/session-cost?session=<id>` 上返回 JSON，浏览器半成品同源 `fetch`，
并用 `useProjection('tokenUsage')` 作为「本会话有新消费」的刷新信号（会话切换、窗口重新
可见、30 秒兜底轮询也会触发）。

路由本身复用 connection 的信任与鉴权栅栏：`ctx.connection.requestRejection({ headers })`
与 `/api` 通道同一套 Host/Origin + 浏览器会话校验，无 cookie 时为 401。

> 注：`ctx.connection.rpc.handle()` 是文档化的逻辑 RPC 注册口，但在当前版本里它由连接服务
> 自身、缺少 `webServer` 注入的上下文执行 `owner.webServer`，任何外部调用者都会拿到
> `cannot get property "webServer" without inject`（已实测复现）。所以本插件退回到
> webserver 精确路由 + 显式调用 `requestRejection`。

## 开发

不需要装依赖、不需要构建，用运行时自带的 Node 跑（DSH 自带的运行时目录即可）：

```sh
# DSH 自带运行时（版本要够新：会话日志是 zstd，需要 Node >= 22.15）
NODE=~/.dsh/dsh-runtimes/<runtime>/dependencies/node/bin/node

# 全部测试（--test-force-exit 用于跳过注册重试定时器）
"$NODE" --test --test-force-exit test/*.test.mjs

# 也可以只跑某个文件
"$NODE" --test --test-force-exit test/subscription.test.mjs

# 清单一致性自检（包名/client id/补丁名/seed 表 require 白名单/打包白名单）
"$NODE" tools/verify.mjs

# 拿真实会话日志回放，并与独立实现的朴素求和交叉校验
"$NODE" tools/replay-session.mjs ~/.dsh/sessions/<dir>/<session>/session.v4.jsonl.zstd CNY

# 直接对真实会话目录跑一遍「今日消费」，核对金额与命中的会话数
"$NODE" tools/today-scan.mjs ~/.dsh/sessions CNY 480
```

### 独立开发实例（可选，不打扰正在用的应用）

`.devhome/` 是一个独立 DSH_HOME + `devcost` profile，可以在里面随意重启、驱动真实会话：

```sh
cd <DSH 源码 checkout>        # 已构建，提供 dsh CLI
export DSH_HOME=<本目录>/.devhome
ELECTRON_RUN_AS_NODE=1 "<Electron 可执行文件>" apps/cli/lib/bin.js \
  --profile devcost --no-open --port 19399
# 打开打印出来的带 token 的 URL 换 cookie 后，即可直接 POST /plugin/session-cost 验证
```

两个坑，都实测过：

- **不能用普通 node 跑 CLI**：DSH boot 需要 `node-addon-require-builtin` 的 native binding，
  普通 node 直接报 `No usable native binding found`。反过来说，**测试与自检用普通 node 就行**。
- **Electron 版本要和源码 checkout 对齐**：不匹配时报
  `unsupported Electron runtime fingerprint`（只支持特定主版本）。对不上就换源码版本，
  或者干脆在已安装的应用里开发。

## 许可证

MIT，见 [LICENSE](./LICENSE)。

## 关于包名

本插件以公开包名 `dsh-session-cost`（无 scope）发布，刻意偏离了开发工作区里
`@local/<目录名>` + `private: true` 的约定——那是本地插件的命名空间，无法发布到 npm，
也会和别人的同名插件冲突。改名只需三处一致（`package.json` 的 `name`、`client.js` 的
`id`、`cordis.patch.yml` 的 `name`），`tools/verify.mjs` 会挡住不一致的情况。
