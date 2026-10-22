#!/usr/bin/env node
// openGym 源码补丁：在上游 clone 之后、npm ci / vite build 之前跑。
//
// 补丁一：iOS 16.3 的 WKWebView 不认识 RegExp 后瞻断言
// ------------------------------------------------------------------
// 上游 frontend/src/lib/media-refs.js 用
//     const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i
// 校验主机名标签，(?<!-) 是后瞻断言，Safari 到 iOS 16.4 才支持。16.3 的 JSC 会把
// "(?<" 当成命名捕获组去解析名字，读到 "!-" 抛
//     SyntaxError: Invalid regular expression: invalid group specifier name
// 错误发生在模块解析期（parseModule），整条 import 链断掉 → index 入口不执行 →
// #root 永远为空 → 启动黑屏。换成逐字符等价的写法（2845 组输入穷举对比，0 差异）。
//
// 补丁二：解除 BYOK（自带 API key）模式的本机每日 10 次上限
// ------------------------------------------------------------------
// 上游 frontend/src/lib/coach-local.js:
//     export const LOCAL_DAILY_CAP = 10
//     async function capState() { ... return { used, limit: LOCAL_DAILY_CAP } }
//     if (cap.used >= cap.limit) throw ... 'taking a breather'
// 原意是「用户自己付钱，所以要有个护栏」。用自己的 key 时这是多余的限制，
// 这里让 capState 报 limit: 0（UI 里 "N of 10 Coach runs used today" 这行因此不再显示），
// 并把拦截条件改成 limit > 0 时才生效。计数逻辑（bumpDaily）保留，不影响其它功能。
//
// 每个补丁都要求「原文必须命中」，上游改了就构建失败并打印位置，
// 避免静默漏打补丁又发出一个坏包。

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || 'upstream/frontend/src'
const EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs'])

// 测试/故事文件不参与打包（vite 只从入口静态可达的模块开始打），
// 里面的后瞻断言也不影响产物，扫进来只会误报。
const isSkipped = (p) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /[\\/](__tests__|__mocks__|stories)[\\/]/.test(p)

const PATCHES = [
  {
    id: 'regex-lookbehind',
    why: 'iOS 16.3 不支持后瞻断言，模块解析期抛 SyntaxError 导致启动黑屏',
    from: '/^(?!-)[a-z0-9-]{1,63}(?<!-)$/i',
    to: '/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i',
  },
  {
    id: 'cap-report',
    why: 'BYOK 模式解除每日 10 次上限：状态不再报限额（UI 同时隐藏计数）',
    from: 'return { used, limit: LOCAL_DAILY_CAP }',
    to: 'return { used, limit: 0 }',
  },
  {
    id: 'cap-guard',
    why: 'BYOK 模式解除每日 10 次上限：放行拦截',
    from: 'if (cap.used >= cap.limit) throw',
    to: 'if (cap.limit > 0 && cap.used >= cap.limit) throw',
  },
]

function walk(dir, out = []) {
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.has(path.extname(e.name)) && !isSkipped(p)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
if (files.length === 0) {
  console.error(`!! ${ROOT} 下没找到任何源码，路径不对？`)
  process.exit(1)
}
console.log(`==> 源码补丁：扫描 ${files.length} 个文件，共 ${PATCHES.length} 条`)

const hits = Object.fromEntries(PATCHES.map(p => [p.id, []]))
for (const f of files) {
  let src
  try {
    src = fs.readFileSync(f, 'utf8')
  } catch {
    continue
  }
  let dirty = false
  for (const p of PATCHES) {
    if (!src.includes(p.from)) continue
    const n = src.split(p.from).length - 1
    src = src.split(p.from).join(p.to)
    hits[p.id].push(`${path.relative(ROOT, f)} ×${n}`)
    dirty = true
  }
  if (dirty) fs.writeFileSync(f, src)
}

let failed = 0
for (const p of PATCHES) {
  if (hits[p.id].length) {
    console.log(`    ✓ ${p.id}  ${hits[p.id].join(', ')}`)
    console.log(`        ${p.why}`)
  } else {
    console.error(`    ✗ ${p.id} 未命中原文，上游可能改过了：`)
    console.error(`        from: ${p.from}`)
    console.error(`        原因: ${p.why}`)
    failed++
  }
}
if (failed) {
  console.error(`\n!! ${failed} 条补丁没打上，构建中止（宁可不发，也不要发个残包）`)
  process.exit(1)
}

// ---- 门禁：补完还有残留后瞻断言就失败，打出位置和上下文
const leftover = []
for (const f of walk(ROOT)) {
  let src
  try {
    src = fs.readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const re = /\(\?<[=!]/g
  let m
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    const snippet = src.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\n/g, ' ')
    leftover.push(`${path.relative(ROOT, f)}:${line}  …${snippet}…`)
  }
}
if (leftover.length) {
  console.error('\n!! 源码里仍有 RegExp 后瞻断言 (?<= / (?<!)，Safari 要 iOS 16.4+ 才支持，')
  console.error('   在 iOS 16.3 上会抛 SyntaxError 导致启动黑屏。请按下面的位置补成等价写法：')
  for (const l of leftover) console.error('   ' + l)
  process.exit(1)
}

console.log('==> 补丁全部命中，无后瞻断言残留')
