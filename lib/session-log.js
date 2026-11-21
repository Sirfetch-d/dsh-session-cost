/**
 * 会话日志的读取与「今日消费」统计。
 *
 * 与 `lib/usage-fold.js` 的区别：那里折叠的是**当前这一个**会话的内存对象，这里要跨会话
 * 统计本机磁盘上的会话日志，所以需要自己读文件。
 *
 * 几个刻意的口径：
 * - **每个会话目录只取最新的一份日志**。同一会话在格式升级后可能留下
 *   `session.jsonl.zstd` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd` 多份，
 *   实测最新一代是旧一代的超集（事件起点相同、终点更晚），取最新既不会漏也不会重。
 * - **按文件 mtime 预筛**：日志是追加写的，含有今日事件的文件其 mtime 必然落在今日窗口内，
 *   所以 mtime 早于窗口起点的文件可以直接跳过，不必解压。
 * - **每个文件单独折叠再合并**：不同会话的 turn/step 编号各成体系，若混在一个折叠状态里，
 *   「同一 (turn, step) 后写覆盖先写」的规则会跨会话误伤。
 * - **按事件自身时间过滤**：只统计 `time` 落在窗口内的结算，峰谷价也由该时间决定。
 *
 * @module dsh-session-cost/session-log
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createUsageState, foldEvent, mergeUsageStates } from './usage-fold.js'

/** zstd 帧魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志文件名：`session.jsonl` / `session.v3.jsonl.zstd` 等各代写法。 */
const LOG_FILE = /^session(?:\.[a-z0-9]+)?\.jsonl(?:\.zstd)?$/u

/** 一天毫秒数。 */
const DAY_MS = 86_400_000

/**
 * 计算包含 `now` 的「今日」窗口。
 * @param {number} now - 当前毫秒时间戳。
 * @param {number} offsetMinutes - 时区相对 UTC 的分钟偏移（北京 = 480）。
 * @returns {{start: number, end: number, offsetMinutes: number, label: string}} 窗口与展示用的时区标签。
 */
export function dayWindow(now, offsetMinutes) {
  const offset = Number.isFinite(offsetMinutes) ? Math.trunc(offsetMinutes) : 480
  const start = Math.floor((now + offset * 60_000) / DAY_MS) * DAY_MS - offset * 60_000
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return {
    start,
    end: start + DAY_MS,
    offsetMinutes: offset,
    label: `UTC${sign}${hours}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`}`,
  }
}

/**
 * 读出一个会话日志文件里的全部 JSONL 行。
 *
 * 兼容三种落盘形态：多帧 zstd、纯文本 jsonl、以及后缀与内容不符的情况（按魔数判断）。
 * @param {string} file - 日志文件绝对路径。
 * @returns {object[]} 解析出的行；坏行被跳过。
 */
export function readLogRows(file) {
  const buffer = readFileSync(file)
  const texts = []
  if (buffer.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
    const offsets = []
    for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + 1)) offsets.push(at)
    for (let index = 0; index < offsets.length; index += 1) {
      const start = offsets[index]
      const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
      try {
        texts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
      } catch {
        /* 单帧损坏不影响其余帧 */
      }
    }
  } else {
    texts.push(buffer.toString('utf8'))
  }
  const rows = []
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  return rows
}

/**
 * 列出窗口内可能有事件的会话日志：每个会话目录取最新的一份，并按 mtime 预筛。
 * @param {string} root - 会话根目录（`<dsh home>/sessions`）。
 * @param {number} windowStart - 窗口起点毫秒时间戳。
 * @param {object} [limits] - `{ maxFiles }`。
 * @returns {{files: object[], skippedOld: number, truncated: boolean}} 文件清单与统计。
 */
export function listWindowLogs(root, windowStart, limits = {}) {
  const maxFiles = Number.isSafeInteger(limits.maxFiles) && limits.maxFiles > 0 ? limits.maxFiles : 200
  const files = []
  let skippedOld = 0
  let truncated = false
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return { files, skippedOld, truncated, missing: true }
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    let sessions
    try {
      sessions = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionPath = join(workspacePath, session.name)
      let entries
      try {
        entries = readdirSync(sessionPath, { withFileTypes: true })
      } catch {
        continue
      }
      // 同一会话可能有多代日志：取 mtime 最新的那一份。
      let newest
      for (const entry of entries) {
        if (!entry.isFile() || !LOG_FILE.test(entry.name)) continue
        const path = join(sessionPath, entry.name)
        let info
        try {
          info = statSync(path)
        } catch {
          continue
        }
        if (newest === undefined || info.mtimeMs > newest.mtimeMs) {
          newest = { path, size: info.size, mtimeMs: info.mtimeMs }
        }
      }
      if (newest === undefined) continue
      if (newest.mtimeMs < windowStart) {
        skippedOld += 1
        continue
      }
      if (files.length >= maxFiles) {
        truncated = true
        continue
      }
      files.push(newest)
    }
  }
  return { files, skippedOld, truncated, missing: false }
}

/**
 * 统计窗口内所有会话的计费 token（按模型路由分桶）。
 *
 * 每个文件单独折叠后合并；文件级缓存以 `(windowStart, size, mtimeMs)` 为键，
 * 因此稳定状态下每轮只看变化的文件。
 * @param {object} options - `{ root, windowStart, windowEnd, cache, maxFiles }`。
 * @returns {{routes: object, files: number, bytes: number, parsed: number, skippedOld: number, truncated: boolean, missing: boolean}} 汇总结果。
 */
export function collectWindowUsage(options) {
  const windowStart = options.windowStart
  const windowEnd = options.windowEnd
  const cache = options.cache instanceof Map ? options.cache : new Map()
  const listing = listWindowLogs(options.root, windowStart, { maxFiles: options.maxFiles })
  const routes = {}
  let bytes = 0
  let parsed = 0
  const seen = new Set()
  for (const file of listing.files) {
    seen.add(file.path)
    bytes += file.size
    const cached = cache.get(file.path)
    if (cached !== undefined && cached.windowStart === windowStart
      && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      mergeUsageStates(routes, cached.routes)
      continue
    }
    const state = createUsageState()
    try {
      const rows = readLogRows(file.path)
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        // 只统计落在窗口内的结算（时间缺失的按文件 mtime 兜底，避免漏掉异常行）。
        const at = Number.isFinite(row.time) ? row.time : file.mtimeMs
        if (at < windowStart || at >= windowEnd) continue
        foldEvent(state, row)
      }
    } catch {
      /* 单个文件读失败不影响整体统计 */
    }
    cache.set(file.path, { windowStart, size: file.size, mtimeMs: file.mtimeMs, routes: state.routes })
    mergeUsageStates(routes, state.routes)
    parsed += 1
  }
  // 清掉已消失或跨天的缓存条目，避免长跑后无限增长。
  for (const path of [...cache.keys()]) {
    if (!seen.has(path) || cache.get(path).windowStart !== windowStart) cache.delete(path)
  }
  return {
    routes,
    files: listing.files.length,
    bytes,
    parsed,
    skippedOld: listing.skippedOld,
    truncated: listing.truncated === true,
    missing: listing.missing === true,
  }
}
