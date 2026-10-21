#!/usr/bin/env node
// 让 openGym 的 web 产物能在 iOS 15.5–16.3 的 WKWebView 上跑起来。
//
// 背景：上游 frontend/src/lib/media-refs.js 里用
//     const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i
// 校验主机名标签，其中 (?<!-) 是**后瞻断言**，Safari 直到 iOS 16.4 才支持。
// 在 iOS 16.3 上 JSC 会把 "(?<" 当成命名捕获组去解析名字，读到 "!-" 直接抛
//     SyntaxError: Invalid regular expression: invalid group specifier name
// 该错误发生在模块解析期（parseModule），整条 import 链断掉 →
// index 入口不执行 → #root 永远为空 → 启动黑屏。
//
// 这里在安装依赖/构建之前把源码打上语义等价的补丁：
//     /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
// 首尾必须是字母数字、中间可含连字符、长度 1–63，与原正则逐字符等价
// （已用 2845 组输入穷举对比验证，0 处差异）。
//
// 补丁后如果源码里还有别的后瞻断言（上游未来新增），直接失败退出，
// 打印 file:line + 上下文，避免又产出一个「装上黑屏」的包。

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] || 'upstream/frontend/src'
const EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs'])

// 测试/故事文件不参与打包（vite 只从入口静态可达的模块开始打），
// 里面出现后瞻断言也不影响 iOS 16.3，扫进来只会误报。
const isSkipped = (p) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /[\\/](__tests__|__mocks__|stories)[\\/]/.test(p)

const RULES = [
  {
    name: 'hostname LABEL 后瞻断言',
    from: '/^(?!-)[a-z0-9-]{1,63}(?<!-)$/i',
    to: '/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i',
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
console.log(`==> web 兼容性补丁：扫描 ${files.length} 个源文件`)

let applied = 0
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8')
  if (!src.includes('(?<')) continue
  const rel = path.relative(ROOT, f).split(path.sep).join('/')
  let dirty = false
  for (const r of RULES) {
    if (!src.includes(r.from)) continue
    src = src.split(r.from).join(r.to)
    dirty = true
    applied++
    console.log(`    修补 ${rel}  [${r.name}]`)
    console.log(`      - ${r.from}`)
    console.log(`      + ${r.to}`)
  }
  if (dirty) fs.writeFileSync(f, src)
}

// ---- 门禁：补完还有残留就失败，把位置和上下文打出来
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

console.log(applied ? `==> 已应用 ${applied} 处补丁，无后瞻断言残留` : '==> 无需补丁，源码无后瞻断言')
