/**
 * session-cost 的浏览器半成品。
 *
 * 位置：`conversation.composer.dock`（输入框下方的环境条，与官方 StatsPills 同一排，
 * order 10 排在它右侧、上下文计量条左侧）。
 *
 * 数据：金额、单价明细、余额全部由宿主半成品计算，通过同源
 * `GET /plugin/session-cost?session=<id>` 取回（该路由复用 connection 的信任与鉴权
 * 栅栏，页面 cookie 自动随请求带上）；本文件只负责渲染与刷新时机。刷新时机有三个
 * 来源：`useProjection('tokenUsage')`（宿主在每次结算后推送的累计 token，作为
 * 「本会话有新消费」的信号）、会话切换、以及窗口重新可见 / 低频兜底轮询。
 *
 * 弹窗刻意与官方统计药丸用同一套机制：锚点定位（portal 到 body、视口内夹取、跟随
 * 滚动/缩放）+ `useDismissOnOutsidePointer`（点外部关闭）+ Escape 关闭，外观也沿用
 * stat-dialog 的 token，因此行为与视觉都与旁边的官方药丸一致。定位那部分在 DSH 0.2.2
 * 从 ui-primitives 移除后由本文件自带（见 `useAnchoredPosition`），不再依赖那个导出。
 *
 * 本文件是手写的 ModuleLoader bundle（无需构建），`id` 必须与 package.json 的
 * 包名一致；`require` 只能取平台 seed 表里的模块。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cost',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** 语言命名空间。 */
    const NS = 'composer.session-cost';
    /** 宿主路由。 */
    const ROUTE = '/plugin/session-cost';
    /** 结算后延迟取数，避免一次工具循环里连发多次请求。 */
    const DEBOUNCE_MS = 500;
    /** 兜底轮询间隔（主要为了让余额刷新）。 */
    const POLL_MS = 30000;
    /** 弹窗与触发点/视口边缘的距离，与官方药丸一致。 */
    const PANEL_GAP = 8;
    const PANEL_MARGIN = 12;
    /**
     * 锚点测量尚未完成时的兜底位置。
     *
     * 刻意用「可见」的兜底而不是 `visibility: hidden`：`useAnchoredPosition` 在
     * layout effect 里测位，首帧绘制前就会有真实坐标，所以这个位置用户基本看不到；
     * 而一旦测量因为任何原因没发生，隐藏态会让面板永远看不见（点击像没反应）。
     */
    const FALLBACK_POS = { left: 12, top: 12 };

    /* ------------------------------------------------------------------ 文案 */

    const ZH = {
      label: '消费',
      loading: '读取中…',
      unavailable: '宿主数据不可用',
      tokensOnly: 'tokens',
      titleEstimate: '本会话估算消费',
      titleBalance: '账户余额',
      input: '输入（未命中缓存）',
      cacheRead: '输入（缓存命中）',
      cacheWrite: '缓存写入',
      cacheHitRate: '缓存命中率',
      subscriptionTitle: '订阅额度',
      subscriptionRolling: '5 小时',
      subscriptionWeekly: '本周',
      subscriptionMonthly: '本月',
      subscriptionUsed: '已用 {value}',
      subscriptionRemaining: '剩余 {value}',
      subscriptionReset: '{value}后重置',
      subscriptionNoKey: '未配置密钥',
      subscriptionUnauthorized: '密钥无效或已过期',
      subscriptionNetwork: '连不上用量接口',
      subscriptionUnsupported: '暂不支持这种 provider',
      subscriptionBadResponse: '响应看不懂',
      subscriptionInternal: '宿主内部出错',
      subscriptionMinutes: '{value} 分钟',
      subscriptionHours: '{value} 小时',
      subscriptionHoursMinutes: '{hours} 小时 {minutes} 分',
      subscriptionDays: '{value} 天',
      subscriptionDaysHours: '{days} 天 {hours} 小时',
      subscriptionNow: '现在',
      output: '输出',
      total: '合计',
      settlements: '结算次数',
      byModel: '按模型',
      byProvider: '按供应商',
      rates: '单价',
      ratesUnit: '每 1M token',
      ratesNote: '按结算发生时段计价',
      ratesOffPeak: '低谷 ×{factor}',
      noPrice: '未配置单价，未计入金额',
      priceHint: '在 profile 的 cordis.patch.yml 里补 prices 后即可计入。',
      titleUnpriced: '未配置单价',
      partialPrice: '该组内有未配置单价的路由，金额只是下界。',
      convertedNote: '金额由美元价目按 usdToCny 折算。',
      tokensUnit: 'tok',
      nativeNote: 'Priced in {currency}; not converted and not included in the total above.',
      nativeNote: '该行按 {currency} 计价，未折算，未计入上面的合计。',
      balanceSourceApiKey: 'API key',
      balanceSourceAccount: 'DeepSeek 账号',
      balanceNow: '当前余额',
      balanceSpent: '余额变化',
      today: '今日消费',
      todayScope: '跨会话统计本机全部会话日志，按结算时间落在今日的 token 估算。',
      from: '自',
      balanceOff: '未开启余额查询',
      balanceUnavailable: '余额不可用',
      balanceAccountScope: '余额是账号级数据，同一账号下其他会话也会计入这段差值。',
      updated: '更新于',
      more: '点击查看明细',
      hostUnavailable: '宿主数据不可用',
      hostUnavailableHint: '如果刚安装或更新本插件，请完全退出并重开应用——仅刷新页面不会重新加载宿主半成品。',
      localTokens: '本会话 token（本地投影）',
    };
    const EN = {
      label: 'Cost',
      loading: 'loading…',
      unavailable: 'host data unavailable',
      tokensOnly: 'tokens',
      titleEstimate: 'Estimated session spend',
      titleBalance: 'Account balance',
      input: 'Input (cache miss)',
      cacheRead: 'Input (cache hit)',
      cacheWrite: 'Cache write',
      cacheHitRate: 'Cache hit rate',
      subscriptionTitle: 'Subscription',
      subscriptionRolling: '5-hour',
      subscriptionWeekly: 'Weekly',
      subscriptionMonthly: 'Monthly',
      subscriptionUsed: '{value} used',
      subscriptionRemaining: '{value} left',
      subscriptionReset: 'resets in {value}',
      subscriptionNoKey: 'no API key configured',
      subscriptionUnauthorized: 'API key rejected or expired',
      subscriptionNetwork: 'cannot reach the usage endpoint',
      subscriptionUnsupported: 'unsupported provider kind',
      subscriptionBadResponse: 'unreadable response',
      subscriptionInternal: 'host error',
      subscriptionMinutes: '{value}m',
      subscriptionHours: '{value}h',
      subscriptionHoursMinutes: '{hours}h {minutes}m',
      subscriptionDays: '{value}d',
      subscriptionDaysHours: '{days}d {hours}h',
      subscriptionNow: 'now',
      output: 'Output',
      total: 'Total',
      settlements: 'Settlements',
      byModel: 'By model',
      byProvider: 'By provider',
      rates: 'Rates',
      ratesUnit: 'per 1M tokens',
      ratesNote: 'priced by the period each settlement landed in',
      ratesOffPeak: 'off-peak ×{factor}',
      noPrice: 'no unit price configured — excluded from the amount',
      priceHint: 'Add them under prices in the profile cordis.patch.yml.',
      titleUnpriced: 'No unit price',
      partialPrice: 'Some routes in this group have no unit price; the amount is a lower bound.',
      convertedNote: 'Converted from USD rates via usdToCny.',
      tokensUnit: 'tok',
      nativeNote: 'Priced in {currency}; not converted and not included in the total above.',
      nativeNote: '该行按 {currency} 计价，未折算，未计入上面的合计。',
      balanceSourceApiKey: 'API key',
      balanceSourceAccount: 'DeepSeek account',
      balanceNow: 'Current balance',
      balanceSpent: 'Balance change',
      today: 'Today',
      todayScope: 'Across every local session log, estimated from settlements dated today.',
      from: 'from',
      balanceOff: 'balance query off',
      balanceUnavailable: 'balance unavailable',
      balanceAccountScope: 'Balance is account-wide; other sessions on the same account count here too.',
      updated: 'updated',
      more: 'click for details',
      hostUnavailable: 'Host data unavailable',
      hostUnavailableHint: 'If you just installed or updated this plugin, fully quit and reopen the app — reloading the page does not reload the Host half.',
      localTokens: 'This session, tokens (local projection)',
    };

    /* ------------------------------------------------------------------ 样式 */

    // 全部外观走内联样式，刻意不注入 <style>：
    // 1) 手写 bundle 里注入样式表是一条额外的失败路径（没注入/被覆盖/被清理都会让
    //    <button> 退化成系统默认灰按钮，面板也变成一串无样式文本）；
    // 2) 内联样式对宿主应用的其它规则免疫，不受选择器优先级与插入顺序影响；
    // 3) 唯一的代价是 :hover 要用状态自己实现（见下面 pill 的 hover 处理）。
    // 视觉仍然对齐 ui-chat 的 stat-dialog：同一批 --dsw-* token、同一套 dl 网格。
    const S = {
      wrap: { display: 'inline-flex' },
      pill: {
        appearance: 'none', WebkitAppearance: 'none',
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        fontFamily: 'inherit', fontSize: '12px', lineHeight: '18px',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-tertiary)',
        background: 'transparent', border: '0', borderRadius: '4px',
        margin: '0', padding: '0 2px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      pillHover: { color: 'var(--dsw-alias-label-secondary)' },
      pillOpen: { color: 'var(--dsw-alias-label-secondary)' },
      dot: { width: '5px', height: '5px', borderRadius: '50%', flex: 'none' },
      dotReady: { background: 'var(--dsw-alias-state-success-primary)' },
      dotLoading: { background: 'var(--dsw-alias-state-idle-primary)' },
      dotFailed: { background: 'var(--dsw-alias-state-warn-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      panel: {
        position: 'fixed', zIndex: 1100, boxSizing: 'border-box',
        width: 'max-content',
        minWidth: 'min(320px, calc(100vw - 24px))',
        maxWidth: 'min(440px, calc(100vw - 24px))',
        maxHeight: 'min(70vh, 560px)', overflow: 'auto',
        padding: '16px',
        border: '0', borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18))',
        fontFamily: 'inherit', fontSize: '12px', lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
      },
      title: {
        display: 'flex', justifyContent: 'space-between', gap: '16px',
        marginBottom: '8px', color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
      },
      titleValue: { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-brand-primary)' },
      rule: { marginBottom: '10px', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      details: {
        display: 'grid', gridTemplateColumns: 'minmax(76px, auto) minmax(0, 1fr)',
        gap: '6px 16px', margin: '0', color: 'var(--dsw-alias-label-tertiary)',
      },
      dt: { minWidth: 0, margin: 0 },
      dd: { minWidth: 0, margin: 0, color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
      dtWide: { gridColumn: '1 / -1', textAlign: 'left' },
      ddWide: { gridColumn: '1 / -1', textAlign: 'left', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'normal' },
      section: { marginTop: '14px' },
      note: { color: 'var(--dsw-alias-label-tertiary)' },
    }

    /* ------------------------------------------------------------------ 数据 */

    /** 把 tokenUsage 投影压成一个可比较的刷新键。 */
    function revisionOf(usage) {
      if (usage === undefined || usage === null) return 'none';
      return [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].join(':');
    }

    /** 金额展示：宿主已经算好，这里只兜底。 */
    /**
     * 金额文本：字符串直接透传（宿主已格式化），数字按宿主同一套精度规则格式化
     * （小额保留 4 位，否则 ¥0.0042 会被四舍五入成 ¥0.00）。
     */
    function amountText(value, currency) {
      if (typeof value === 'string') return value;
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '';
      const amount = Number(value ?? 0);
      if (!Number.isFinite(amount)) return `${symbol}—`;
      const abs = Math.abs(amount);
      const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
      return `${symbol}${amount.toFixed(digits)}`;
    }

    /** token 缩写：万位以下原样，之后 k / M（只用于药丸，面板用精确值）。 */
    function tokenText(value) {
      const count = Number(value ?? 0);
      if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`;
      if (count >= 1e4) return `${(count / 1e3).toFixed(0)}k`;
      return String(count);
    }

    /** 面板里的 token 用精确值（千分位），方便自己核对金额是怎么算出来的。 */
    function exactTokens(value) {
      return Number(value ?? 0).toLocaleString();
    }

    /**
     * 缓存命中率。与官方用量面板同口径（基数是整段 prompt），并且**不允许把部分命中
     * 四舍五入成 100%**：一位小数会进位到 100 时自动加精度，最多到三位。
     * @param {number} cacheRead - 命中缓存的 prompt token。
     * @param {number} prompt - prompt 侧总 token（未命中 + 命中 + 写入）。
     * @returns {string|undefined} 展示文本，没有 prompt 输入时返回 undefined。
     */
    function hitPercentText(cacheRead, prompt) {
      if (!(prompt > 0)) return undefined;
      if (cacheRead >= prompt) return '100%';
      for (const places of [1, 2, 3]) {
        const scale = 10 ** places;
        const rounded = Math.round(cacheRead / prompt * 100 * scale) / scale;
        if (rounded < 100) return `${rounded}%`;
      }
      return '<100%';
    }

    /** 时间：HH:MM:SS。 */
    function timeText(at) {
      if (!Number.isFinite(at)) return '—';
      const date = new Date(at);
      const pad = value => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** 单价文案：命中 / 未命中 / 输出，附低谷折扣。 */
    function ratesText(rates, t) {
      if (rates === null || rates === undefined) return undefined;
      const numbers = [
        `${t('cacheRead')} ${rates.cacheHitPer1M}`,
        `${t('input')} ${rates.cacheMissPer1M}`,
      ];
      // 缓存写入另有单价时才列出来（DeepSeek 系没有，按未命中价计）。
      const writeRate = Number(rates.cacheWritePer1M);
      if (Number.isFinite(writeRate) && writeRate !== Number(rates.cacheMissPer1M)) {
        numbers.push(`${t('cacheWrite')} ${rates.cacheWritePer1M}`);
      }
      numbers.push(`${t('output')} ${rates.outputPer1M}`);
      const currency = rates.currency === undefined ? '' : ` ${rates.currency}`;
      const factor = Number(rates.offPeakFactor);
      const note = Number.isFinite(factor) && factor !== 1 ? `，${t('ratesOffPeak', { factor })}` : '';
      return `${t('rates')} ${numbers.join(' / ')} ${t('ratesUnit')}${currency}（${t('ratesNote')}${note}）`;
    }

    /**
     * 拉取宿主数据：会话切换或刷新键变化时重新取数，并带一次防抖。
     * @param {string} sessionId - 当前会话 id。
     * @param {string} revision - 刷新键。
     * @returns {{phase: string, data?: object}} 取数状态。
     */
    function useCostData(sessionId, revision) {
      const [state, setState] = React.useState({ phase: 'loading' });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let cancelled = false;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          const url = `${ROUTE}?session=${encodeURIComponent(sessionId)}`;
          fetch(url, { credentials: 'same-origin', signal: controller.signal })
            .then(response => response.json())
            .then(payload => { if (!cancelled) setState({ phase: 'ready', data: payload }); })
            .catch(() => { if (!cancelled) setState({ phase: 'failed' }); });
        }, DEBOUNCE_MS);
        return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
      }, [sessionId, revision, tick]);
      // 低频兜底轮询 + 窗口重新可见时立刻刷新。
      React.useEffect(() => {
        const bump = () => { setTick(value => value + 1); };
        const interval = setInterval(bump, POLL_MS);
        const onVisible = () => { if (document.visibilityState === 'visible') bump(); };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        return () => {
          clearInterval(interval);
          document.removeEventListener('visibilitychange', onVisible);
          window.removeEventListener('focus', onVisible);
        };
      }, []);
      return state;
    }

    /**
     * 浮层与视口顶部的最小距离：桌面壳在窗口顶部留了一条拖拽带，面板不要压进去；
     * 全屏时只保留基础间距。
     * @param {number} min - 面板自己的视口边距（下限）。
     * @returns {number} 实际使用的顶部最小距离。
     */
    function overlayTopMargin(min) {
      const root = document.documentElement;
      const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'));
      if (Number.isNaN(clearance)) return min;
      return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20);
    }

    /**
     * 弹窗定位：portal 到 body 的固定面板按触发按钮的视口坐标摆放。
     *
     * DSH 0.2.2 移除了 `@deepseek-ai/dsh-client-ui-primitives` 的 `useAnchoredPosition`
     * 值导出（官方改走 CSS Anchor Positioning），而本插件的面板要在非 Chromium 浏览器里
     * 也能用，所以把原语实现抄进插件（AGENTS §5：平台表里没有的能力自己带）。语义与
     * 0.2.1 的官方实现一致：首次测量前返回 null、滚动 / 缩放 / 面板尺寸变化时重新摆、
     * 并夹在视口内。
     * @param {object} options - `open`、两个 ref、方向 `side`、对齐 `align`、间距 `gap`、视口边距 `margin`。
     * @returns {{left: number, top: number}|null} 面板的视口坐标；测量前为 null。
     */
    function useAnchoredPosition(options) {
      const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin } = options;
      const [position, setPosition] = React.useState(null);
      React.useLayoutEffect(() => {
        if (!open) {
          setPosition(null);
          return undefined;
        }
        const place = () => {
          const rect = anchorRef.current?.getBoundingClientRect?.();
          if (rect === undefined) return;
          const panel = panelRef.current;
          const width = panel?.offsetWidth ?? 0;
          const height = panel?.offsetHeight ?? 0;
          let left = align === 'end' ? rect.right - width : rect.left;
          let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap;
          if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
          if (height > 0) {
            top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin);
          }
          setPosition({ left, top });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        const panel = panelRef.current;
        let observer;
        if (typeof ResizeObserver !== 'undefined' && panel !== null && panel !== undefined) {
          observer = new ResizeObserver(place);
          observer.observe(panel);
        }
        return () => {
          if (observer !== undefined) observer.disconnect();
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
        };
      }, [open, anchorRef, panelRef, side, align, gap, margin]);
      return position;
    }

    /**
     * 弹窗座位：锚点定位（本插件自带）+ 点外部关闭（官方原语）+ Escape 关闭，
     * 行为与旁边的统计药丸一致（面板 portal 到 body，所以要把 panelRef 一起交给关闭逻辑）。
     * @param {boolean} open - 是否展开。
     * @param {Function} setOpen - 开关 setter。
     * @returns {{rootRef: object, panelRef: object, pos: object|null}} refs 与位置。
     */
    function useCostDialog(open, setOpen) {
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const pos = useAnchoredPosition({
        open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN,
      });
      primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = event => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); };
      }, [open, setOpen]);
      return { rootRef, panelRef, pos };
    }

    /**
     * 订阅窗口配色：<70% 正文、≥70% 警告、≥90% 危险。
     * @param {number} percent - 已用百分比。
     * @returns {string} CSS 颜色。
     */
    function subscriptionTone(percent) {
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary, #cf222e)';
      if (percent >= 70) return 'var(--dsw-alias-state-warn-primary, #bf8700)';
      return 'var(--dsw-alias-label-primary, currentColor)';
    }

    /**
     * 毫秒 → 「x 分钟 / x 小时 / x 天」。
     * @param {number} ms - 剩余毫秒。
     * @param {Function} t - 翻译函数。
     * @returns {string} 文案。
     */
    function subscriptionDuration(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return t('subscriptionNow');
      const minutes = Math.max(1, Math.round(ms / 60000));
      if (minutes < 60) return t('subscriptionMinutes', { value: minutes });
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      if (hours < 24) {
        return restMinutes === 0
          ? t('subscriptionHours', { value: hours })
          : t('subscriptionHoursMinutes', { hours, minutes: restMinutes });
      }
      const days = Math.floor(hours / 24);
      const restHours = hours % 24;
      return restHours === 0
        ? t('subscriptionDays', { value: days })
        : t('subscriptionDaysHours', { days, hours: restHours });
    }

    /**
     * 订阅取数失败 → 人话。
     * @param {object} info - 宿主给的 subscription 段。
     * @param {Function} t - 翻译函数。
     * @returns {string} 文案。
     */
    function subscriptionFailure(info, t) {
      const status = String(info.status ?? '');
      if (status === 'no-key') return t('subscriptionNoKey');
      if (status === 'unauthorized') return t('subscriptionUnauthorized');
      if (status === 'network') return t('subscriptionNetwork');
      if (status === 'unsupported') return t('subscriptionUnsupported');
      if (status === 'bad-response') return t('subscriptionBadResponse');
      if (status === 'internal') return t('subscriptionInternal');
      if (status.startsWith('http-')) return `HTTP ${status.slice(5)}`;
      return status;
    }

    /* ------------------------------------------------------------------ 视图 */

    /**
     * 面板内容的错误边界。
     *
     * `safeRender` 那种 try/catch 只能兜住「构造元素时」抛的错，子组件在 React 渲染期
     * 抛的错必须由 error boundary 接住——否则整棵子树被卸掉，表现就是「点了没反应」。
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error('session-cost: panel render failed', error);
      }

      render() {
        return this.state.failed
          ? h('div', { style: S.note }, this.props.fallbackText)
          : this.props.children;
      }
    }
    // 测试用标记：让最小 React 桩能认出这是类组件而不是普通函数组件。
    PanelBoundary.isPanelBoundary = true;

    /**
     * 构造面板内容；构造期抛错则降级为一行提示。
     * @param {Function} render - 真正的渲染函数。
     * @param {string} fallbackText - 兜底文案。
     * @returns {object} React 元素。
     */
    function safeRender(render, fallbackText) {
      try {
        return h(PanelBoundary, { fallbackText }, render());
      } catch (error) {
        console.error('session-cost: render failed', error);
        return h('div', { style: S.note }, fallbackText);
      }
    }

    /**
     * 面板里的一节：标题行 + 分隔线 + dl 网格。
     * @param {object} props - `{ title, value, valueStyle, children }`。
     * @returns {object} React 元素。
     */
    function Section({ title, value, valueStyle, children }) {
      return h('div', { style: S.section },
        h('div', { style: S.title },
          h('span', null, title),
          value === undefined ? null : h('span', { style: { ...S.titleValue, ...(valueStyle ?? {}) } }, value)),
        h('div', { style: S.rule, 'aria-hidden': true }),
        h('dl', { style: S.details }, children));
    }

    /**
     * 一行 dt/dd；`wide` 用于占满整行的说明文字，`title` 放不占版面的悬停解释。
     * @param {object} props - `{ label, value, wide, warn, title }`。
     * @returns {Array} dt 与 dd 两个元素。
     */
    function Row({ label, value, wide, warn, title }) {
      const wideStyle = wide === true ? { ...S.dtWide } : undefined;
      return [
        h('dt', { key: 'dt', title, style: { ...S.dt, ...(wideStyle ?? {}) } }, label),
        h('dd', {
          key: 'dd',
          title,
          style: {
            ...S.dd,
            ...(wide === true ? S.ddWide : {}),
            ...(warn === true ? S.warn : {}),
          },
        }, value),
      ];
    }

    /**
     * 「订阅额度」段：三个窗口的已用/剩余 + 各自的重置倒计时。
     *
     * 官方 usage 药丸里的「token 总量 + 缓存命中率」和这里的订阅额度都收进同一个弹窗，
     * 状态栏因此只留一个「消费」入口。
     * @param {object} props - `{ subscription, t }`。
     * @returns {object|null} 段落元素；没有这一段时 null。
     */
    function SubscriptionSection({ subscription, t }) {
      if (subscription === null || subscription === undefined) return null;
      const windows = subscription.status === 'ok' && subscription.windows !== undefined ? subscription.windows : null;
      const title = t('subscriptionTitle');
      const label = String(subscription.label ?? '');
      if (windows === null) {
        return h(Section, { title, value: label }, [
          h(Row, { key: 'error', label: t('subscriptionTitle'), value: subscriptionFailure(subscription, t), warn: true }),
        ]);
      }
      const order = Array.isArray(subscription.order) ? subscription.order : Object.keys(windows);
      const labels = { rolling: t('subscriptionRolling'), weekly: t('subscriptionWeekly'), monthly: t('subscriptionMonthly') };
      const rows = order
        .filter(id => windows[id] !== undefined)
        .map(id => {
          const window = windows[id];
          // 与热力图那条额度带同一口径：条与字都写**余量**。
          const parts = [
            t('subscriptionRemaining', { value: `${String(Math.round(window.remaining))}%` }),
          ];
          if (window.resetsAt !== null) {
            parts.push(t('subscriptionReset', { value: subscriptionDuration(Date.parse(window.resetsAt) - Date.now(), t) }));
          }
          return h(Row, { key: id, label: labels[id] ?? id, value: parts.join(' · '), warn: window.percent >= 70 });
        });
      return h(Section, { title, value: label }, rows);
    }

    /**
     * 明细面板内容（外层壳与定位由 SessionCostBadge 负责）。
     * @param {object} props - `{ data, t }`。
     * @returns {object} React 元素。
     */
    function DetailPanel({ data, t }) {
      const tokens = data.tokens ?? {};
      const estimate = data.estimate ?? {};
      const balance = data.balance ?? {};
      const routes = Array.isArray(estimate.routes) ? estimate.routes : [];
      const unpriced = Array.isArray(estimate.unpriced) ? estimate.unpriced : [];
      const sourceLabel = balance.source === 'apikey'
        ? t('balanceSourceApiKey')
        : balance.source === 'account' ? t('balanceSourceAccount') : null;
      // 命中率的基数是整段 prompt（未命中 + 命中 + 写入），与官方用量面板同口径。
      const promptTokens = (tokens.uncachedInput ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
      const hitRate = hitPercentText(tokens.cacheRead ?? 0, promptTokens);
      const children = [
        h(Section, {
          key: 'tokens',
          title: t('titleEstimate'),
          value: `${estimate.converted === true ? '≈' : ''}${amountText(estimate.display, estimate.currency ?? data.currency)}`,
        },
          [
            hitRate === undefined ? null : h(Row, { key: 'hitRate', label: t('cacheHitRate'), value: hitRate }),
            h(Row, { key: 'input', label: t('input'), value: exactTokens(tokens.uncachedInput) }),
            h(Row, { key: 'cacheRead', label: t('cacheRead'), value: exactTokens(tokens.cacheRead) }),
            // 与官方用量面板一致：provider 没有上报「写入缓存」这一桶时不占一行
            // （DeepSeek 就没有这个桶，写入量按未命中价计）。
            tokens.cacheWrite === 0 || tokens.cacheWrite === undefined
              ? null
              : h(Row, { key: 'cacheWrite', label: t('cacheWrite'), value: exactTokens(tokens.cacheWrite) }),
            h(Row, { key: 'output', label: t('output'), value: exactTokens(tokens.output) }),
            h(Row, { key: 'total', label: t('total'), value: exactTokens(tokens.total) }),
            h(Row, { key: 'calls', label: t('settlements'), value: String(tokens.calls ?? 0) }),
          ]),
      ];
      // 订阅额度：状态栏那条官方 usage 药丸（token 总量 + 缓存命中率）与会话消费的内容都收进这里，
      // 状态栏因此只留一个「消费」入口。
      children.push(h(SubscriptionSection, { key: 'subscription', subscription: data.subscription, t }));
      // 逐路由的单价明细：按模型聚合后挂在各模型下面（与官方用量面板观感一致）。
      const ratesByModel = new Map();
      for (const route of routes) {
        const key = route.model === '' ? route.provider : route.model;
        if (ratesByModel.has(key) === false) ratesByModel.set(key, []);
        const line = ratesText(route.rates, t);
        if (line !== undefined) ratesByModel.get(key).push(line);
      }
      /**
       * 汇总行（按模型 / 按供应商）的取值：
       * 有金额就显示金额（折算来的加 ≈），没有金额就显示 token 并带单位——
       * 「金额」和「token 数」混在同一列时，必须靠单位把两者区分开。
       */
      const rollupRows = (list, keyPrefix) => {
        const rows = [];
        for (const [index, row] of list.entries()) {
          const hasAmount = row.amount !== null && row.amount !== undefined;
          const hasNative = row.native !== null && row.native !== undefined;
          const titleParts = [];
          if (row.converted === true) titleParts.push(t('convertedNote'));
          if (row.priced === false) titleParts.push(t('partialPrice'));
          // 没有折算汇率时，仍然把原生币种的金额摆出来（带自己的符号），
          // 而不是只剩一个 token 数——用户看得到钱，但不会被算进上面的人民币合计。
          if (hasNative) titleParts.push(t('nativeNote', { currency: row.native.currency }));
          let value;
          if (hasAmount) {
            value = `${row.converted === true ? '≈' : ''}${amountText(row.amount, data.currency)}${row.priced === false ? '*' : ''}`;
          } else if (hasNative) {
            // 没配汇率就直接按原生币种显示，不摆在正文里说教（口径放在悬停提示里）。
            value = amountText(row.native.amount, row.native.currency);
          } else {
            value = `${tokenText(row.tokens?.total)} ${t('tokensUnit')}`;
          }
          rows.push(h(Row, {
            key: `${keyPrefix}#${index}`,
            label: row.key === '' ? t('unpriced') : row.key,
            value,
            title: titleParts.length === 0 ? undefined : titleParts.join(' '),
          }));
          // 按模型聚合的两种路径（宿主带 byModel / 旧宿主退回逐路由）都要贴单价明细。
          if (keyPrefix === 'model' || keyPrefix === 'route') {
            for (const [rateIndex, line] of (ratesByModel.get(row.key) ?? []).entries()) {
              rows.push(h(Row, { key: `rate#${index}#${rateIndex}`, label: '', value: line, wide: true }));
            }
          }
        }
        return rows;
      };

      const byModel = Array.isArray(estimate.byModel) && estimate.byModel.length > 0 ? estimate.byModel : undefined;
      const byProvider = Array.isArray(estimate.byProvider) && estimate.byProvider.length > 0 ? estimate.byProvider : undefined;
      if (byModel !== undefined) {
        children.push(h(Section, { key: 'byModel', title: t('byModel') }, rollupRows(byModel, 'model')));
      } else if (routes.length > 0) {
        // 宿主是旧版本（没有聚合字段）时的退路：按逐路由渲染，至少不空着。
        children.push(h(Section, { key: 'byModel', title: t('byModel') }, rollupRows(
          routes.map(route => ({
            key: route.model === '' ? route.provider : route.model,
            tokens: route.tokens,
            amount: route.amount,
            priced: route.amount !== null,
            converted: route.converted === true,
          })),
          'route',
        )));
      }
      if (byProvider !== undefined) {
        children.push(h(Section, { key: 'byProvider', title: t('byProvider') }, rollupRows(byProvider, 'provider')));
      }

      // 缺汇率的路由不在这里提示：它的金额已经按原生币种显示在按模型/按供应商里了。
      const missingUnpriced = unpriced.filter(entry => typeof entry === 'string' || entry.reason !== 'fx');
      if (missingUnpriced.length > 0) {
        const label = entry => (typeof entry === 'string' ? entry : `${entry.provider}/${entry.model}`);
        const missing = missingUnpriced;
        const unpricedRows = [];
        {
          unpricedRows.push(h(Row, {
            key: 'warn', label: '', value: `${t('noPrice')}: ${missing.map(label).join('、')}`, wide: true, warn: true,
          }));
          unpricedRows.push(h(Row, { key: 'hint', label: '', value: t('priceHint'), wide: true }));
        }
        children.push(h(Section, { key: 'unpriced', title: t('titleUnpriced') }, unpricedRows));
      }
      const balanceRows = [];
      const today = data.today ?? {};
      if (today.status === 'ready') {
        balanceRows.push(h(Row, {
          key: 'today',
          label: today.label === undefined ? t('today') : `${t('today')} · ${today.label}`,
          value: `${today.converted === true ? '≈' : ''}${amountText(today.display, today.currency ?? data.currency)}`,
          title: t('todayScope'),
        }));
      } else if (today.status !== undefined) {
        balanceRows.push(h(Row, { key: 'today', label: t('today'), value: '—' }));
      }
      if (balance.status === 'ready') {
        balanceRows.push(h(Row, {
          key: 'now',
          label: sourceLabel === null ? t('balanceNow') : `${t('balanceNow')} · ${sourceLabel}`,
          value: balance.primary === undefined ? '—' : balance.primary.display,
        }));
        if (balance.spentSince !== undefined) {
          balanceRows.push(h(Row, {
            key: 'spent',
            label: `${t('balanceSpent')} · ${t('from')} ${timeText(balance.baseline?.at)}`,
            value: balance.spentSince.display,
            title: t('balanceAccountScope'),
          }));
        }
      } else {
        balanceRows.push(h(Row, {
          key: 'off',
          label: '',
          value: balance.status === 'off' ? t('balanceOff') : t('balanceUnavailable'),
          wide: true,
        }));
      }
      children.push(h(Section, { key: 'balance', title: t('titleBalance') }, balanceRows));
      children.push(h('div', { key: 'updated', style: { ...S.section, ...S.note } },
        `${t('updated')} ${timeText(data.updatedAt)}`));
      return h(React.Fragment, null, children);
    }

    /**
     * 取不到宿主数据时的内容：说明原因、给出 token 兜底，并明确「要重启应用」。
     * @param {object} props - `{ usage, t }`。
     * @returns {object} React 元素。
     */
    function FallbackPanel({ usage, t }) {
      const rows = usage === undefined ? [] : [
        [t('input'), usage.uncachedInputTokens],
        [t('cacheRead'), usage.cacheReadTokens],
        [t('cacheWrite'), usage.cacheWriteTokens],
        [t('output'), usage.outputTokens],
      ];
      const children = [
        h(Section, { key: 'host', title: t('hostUnavailable'), valueStyle: S.warn }, [
          h(Row, { key: 'hint', label: '', value: t('hostUnavailableHint'), wide: true }),
        ]),
      ];
      if (rows.length > 0) {
        children.push(h(Section, { key: 'local', title: t('localTokens') }, [
          ...rows.map(([label, value], index) => h(Row, { key: `r${index}`, label, value: exactTokens(value) })),
          h(Row, {
            key: 'total',
            label: t('total'),
            value: exactTokens(rows.reduce((sum, [, value]) => sum + (Number(value) || 0), 0)),
          }),
        ]));
      }
      return h(React.Fragment, null, children);
    }

    /**
     * 环境条上的消费徽标；面板 portal 到 body，跟随滚动与视口夹取。
     * @param {object} props - 框架标准 props（`sessionId` / `useProjection` / `t`）。
     * @returns {object|null} React 元素。
     */
    function SessionCostBadge({ sessionId, useProjection, t }) {
      const usage = useProjection('tokenUsage');
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const { rootRef, panelRef, pos } = useCostDialog(open, setOpen);
      const state = useCostData(sessionId, revisionOf(usage));
      const data = state.phase === 'ready' ? state.data : undefined;
      const ok = data !== undefined && data.ok === true;
      const fallbackTokens = usage === undefined
        ? undefined
        : (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
          + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
      const failed = state.phase === 'failed' || (data !== undefined && data.ok === false);
      const text = ok
        ? amountText(data.estimate?.display, data.currency)
        : fallbackTokens === undefined
          ? (state.phase === 'loading' ? t('loading') : t('unavailable'))
          : `${tokenText(fallbackTokens)} ${t('tokensOnly')}`;
      const pillState = ok ? 'ready' : failed ? 'failed' : 'loading';
      const dotStyle = {
        ...S.dot,
        ...(pillState === 'ready' ? S.dotReady : pillState === 'loading' ? S.dotLoading : S.dotFailed),
      };
      const title = ok ? `${t('titleEstimate')} · ${t('more')}` : `${t('hostUnavailable')} · ${t('more')}`;
      return h('span', { ref: rootRef, style: S.wrap },
        h('button', {
          type: 'button',
          'data-session-cost': '',
          'data-state': pillState,
          'data-open': open ? '' : undefined,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title,
          style: {
            ...S.pill,
            ...(hover || open ? S.pillHover : {}),
            ...(failed ? S.warn : {}),
          },
          onMouseEnter: () => { setHover(true); },
          onMouseLeave: () => { setHover(false); },
          onClick: () => { setOpen(value => !value); },
        },
        h('span', { style: dotStyle }),
        h('span', null, `${t('label')} ${text}`)),
        open ? ReactDOM.createPortal(h('div', {
          ref: panelRef,
          'data-session-cost-panel': '',
          role: 'dialog',
          'aria-label': t('titleEstimate'),
          style: { ...S.panel, ...(pos ?? FALLBACK_POS) },
        }, safeRender(
          () => (ok ? h(DetailPanel, { data, t }) : h(FallbackPanel, { usage, t })),
          t('hostUnavailable'),
        )), document.body) : null);
    }

    /* ------------------------------------------------------------------ 插件 */

    return {
      name: 'session-cost',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'session-cost: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'session-cost: en dictionary');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'session-cost',
          order: 10,
          locale: NS,
        }, SessionCostBadge));
        // 遮蔽官方 usage 药丸（token 总量 + 缓存命中率）：它的内容本来就在上面这个弹窗的
        // token 明细里，状态栏只留一个「消费」入口。
        //
        // 机制（见 client-ui 的 slot register）：list slot 同 id 同 priority 会抛错，
        // **同 id 但更低的 priority 才是「遮蔽」**——按 priority 升序渲染、同 id 只留第一个，
        // 所以 priority: -1 会顶掉官方那一格；与激活顺序无关，不会抢注。
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'usage',
          order: 1,
          priority: -1,
          locale: NS,
        }, () => null));
      },
    };
  },
});
