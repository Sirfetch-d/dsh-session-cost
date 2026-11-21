/**
 * 开发工具：静态自检——清单与两个半成品之间最容易写错的一致性约束。
 * 用法：ELECTRON_RUN_AS_NODE=1 "<node>" tools/verify.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check(typeof manifest.name === 'string' && manifest.name !== '', 'package.json 缺少 name')

// 1) ModuleLoader 的 id 必须等于包名（否则客户端行注册不上）。
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/u.exec(clientSource)
check(idMatch !== null, 'client.js 未找到 window.__ModuleLoader__.load({ id })')
check(idMatch?.[1] === manifest.name, `client.js 的 id (${String(idMatch?.[1])}) 必须等于包名 (${String(manifest.name)})`)

// 2) 客户端入口必须被 exports 暴露，且文件存在。
const clientExport = manifest.exports?.['./client']
check(typeof clientExport === 'string', 'package.json exports 缺少 "./client"')
check(typeof clientExport !== 'string' || existsSync(join(root, clientExport)), `exports["./client"] 指向的文件不存在：${String(clientExport)}`)

// 3) dsh 清单字段齐全。
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform 必须是 web')
check(typeof manifest.dsh?.bundle?.patch === 'string', 'dsh.bundle.patch 必须指向补丁文件')
check(existsSync(join(root, String(manifest.dsh?.bundle?.patch ?? 'missing'))), 'dsh.bundle.patch 指向的文件不存在')

// 4) 补丁里插入的模块名必须等于包名。
// 打包白名单：没有 files 时 `npm pack` 会把 .devhome（本机会话密钥 + 测试会话日志）一起打进去。
check(Array.isArray(manifest.files) && manifest.files.length > 0,
  'package.json 缺少 files 白名单（否则 npm pack 会带上 .devhome）')
const fileEntries = manifest.files.map(entry => String(entry).replace(/^\.\//u, ''))
check(!fileEntries.some(entry => entry.includes('.devhome')), 'files 不应包含 .devhome')

/**
 * 判断某个发布路径是否被 files 白名单覆盖（支持目录与通配符）。
 * @param {string} target - exports/icon/patch 里写的相对路径。
 * @returns {boolean} 是否会被打进包。
 */
function covered(target) {
  const path = String(target).replace(/^\.\//u, '')
  // 这几个文件 npm 强制包含，不必列进 files。
  if (path === 'package.json' || path === 'README.md' || path === 'LICENSE') return true
  return fileEntries.some(entry => {
    if (entry.endsWith('/')) return path.startsWith(entry)
    if (entry.includes('*')) return path.startsWith(entry.slice(0, entry.indexOf('*')))
    return path === entry
  })
}

for (const target of Object.values(manifest.exports ?? {})) {
  if (typeof target === 'string') check(covered(target), `exports 指向的 ${target} 不在 files 白名单里（装上去会缺文件）`)
}
for (const [label, target] of [['icon', manifest.icon], ['dsh.bundle.patch', manifest.dsh?.bundle?.patch]]) {
  if (typeof target === 'string') check(covered(target), `${label} 指向的 ${target} 不在 files 白名单里`)
}

// 忽略规则必须写在插件目录内：仓库根的 .gitignore 挡不住「把这个目录单独成仓库」的情况。
check(existsSync(join(root, '.gitignore')), '插件目录缺少 .gitignore（.devhome 必须被忽略）')
const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
check(/^\.devhome\/?$/mu.test(ignore), '.gitignore 必须忽略 .devhome/')

const patch = readFileSync(join(root, String(manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')), 'utf8')
const patchName = /name:\s*'([^']+)'/u.exec(patch)
check(patchName?.[1] === manifest.name, `cordis.patch.yml 的 name (${String(patchName?.[1])}) 必须等于包名 (${String(manifest.name)})`)

// 5) 宿主半成品必须导出 apply。
const host = await import(new URL('../index.js', import.meta.url).href)
check(typeof host.apply === 'function', '宿主半成品必须导出 apply(ctx, config)')
check(host.name === 'session-cost', '宿主半成品的 name 导出应为 session-cost')

// 6) 客户端半成品的 require 只能命中平台 seed 表（与 client/web/src/seed.ts 对齐）。
const SEED_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]
const requires = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/gu)].map(match => match[1])
check(requires.length > 0, 'client.js 未 require 任何平台模块（至少需要 react）')
for (const spec of requires) {
  check(SEED_MODULES.includes(spec), `client.js 里的 require('${spec}') 不在平台 seed 表内`)
}

if (failures.length === 0) {
  console.log(`verify ok — ${String(manifest.name)}@${String(manifest.version)}`)
} else {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
