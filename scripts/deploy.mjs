#!/usr/bin/env node
/**
 * 开发期部署助手（**不是**发布安装方式）：把本仓库以「绝对路径条目」写进某个
 * DSH profile 的 cordis.patch.yml，便于在本地边改边测（无需 npm 发布/安装）。
 *
 * 正式安装请用 DSH 的插件安装界面（npm 包名 / GitHub 地址 / 本地 tgz 绝对路径），
 * 插件管理器会负责 pnpm 安装与 `dsh.profile.bundles` 选择；本脚本只用于开发者。
 *
 * 为什么改 patch 后要重启：DSH 启动时读取 profile 的 cordis.patch.yml 并持有 inode，
 * 手工替换文件不会被重放。本脚本统一做「备份 + 幂等追加」。
 *
 * 用法：
 *   node scripts/deploy.mjs                # 构建 client.js 并写入 desktop profile
 *   node scripts/deploy.mjs --dry-run      # 只打印将要做什么
 *   node scripts/deploy.mjs --no-patch     # 只构建 + 复制，不改 profile
 *   node scripts/deploy.mjs --target <dir> # 复制到指定运行路径（默认本仓库目录）
 *   node scripts/deploy.mjs --profile <n>  # 换 profile 名（默认 desktop）
 *
 * 退出码 0 = 成功（含“已经装好、无需改动”）；非 0 = 有步骤失败。
 */

import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildBundle, readPluginId } from './build-client.mjs'

/** 插件在 profile 里的条目 id。 */
export const ENTRY_ID = 'folder-sessions'

/** 本仓库目录：默认运行路径（path 条目直接指向源码目录）。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 插件运行路径（目录）。 */
export const DEFAULT_TARGET = ROOT

/** 需要复制到运行路径的条目（--target 与仓库目录不同时）。 */
const RUNTIME_ENTRIES = [
  'index.js',
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'client.js',
  'host',
  'assets',
]

/**
 * 解析命令行参数。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = {
    dryRun: argv.includes('--dry-run'),
    noPatch: argv.includes('--no-patch'),
    target: DEFAULT_TARGET,
    profile: 'desktop',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--target') args.target = resolve(argv[index + 1] ?? args.target)
    if (value === '--profile') args.profile = argv[index + 1] ?? args.profile
  }
  return args
}

/**
 * 把插件 insert 块写进 profile patch 文本（幂等：已存在同 id 条目时不动）。
 * @param {string} source
 * @param {{ entryId: string, entryPath: string }} options
 * @returns {{ text: string, changed: boolean }}
 */
export function upsertPatchEntry(source, options) {
  const marker = `id: ${options.entryId}\n`
  const entryLines = [
    '- insert:',
    `    - id: ${options.entryId}`,
    `      name: '${options.entryPath}'`,
    '',
  ].join('\n')
  if (source.includes(marker)) {
    return { text: source, changed: false }
  }
  const trimmed = source.replace(/\s*$/, '')
  const text = trimmed === '' ? entryLines : `${trimmed}\n\n${entryLines}`
  return { text, changed: trimmed !== source || true }
}

/**
 * 递归复制（跳过 node_modules / tests / scripts / .staging）。
 * @param {string} from
 * @param {string} to
 */
async function copyTree(from, to) {
  const info = await stat(from)
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from)) {
      if (entry === 'node_modules' || entry === 'tests' || entry === 'scripts' || entry.startsWith('.')) continue
      await copyTree(join(from, entry), join(to, entry))
    }
    await chmod(to, 0o755)
    return
  }
  await copyFile(from, to)
  await chmod(to, 0o644)
}

/**
 * 构建 client.js 并写入仓库根（返回 rev 哈希）。
 * @returns {Promise<string>}
 */
async function buildClient() {
  const source = await readFile(join(ROOT, 'src', 'client', 'index.js'), 'utf8')
  const bundle = buildBundle(source, readPluginId())
  const marker = `/* rev: ${Date.now().toString(16)} */\n`
  await writeFile(join(ROOT, 'client.js'), marker + bundle, 'utf8')
  return marker.trim()
}

/**
 * 主流程。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(`deploy: target=${args.target} profile=${args.profile} dryRun=${String(args.dryRun)}`)

  if (!args.dryRun) {
    const rev = await buildClient()
    console.log(`deploy: client.js 已构建（${rev}）`)
  }

  if (resolve(args.target) !== ROOT) {
    if (args.dryRun) {
      console.log(`deploy: [dry-run] 将复制 ${RUNTIME_ENTRIES.join(', ')} → ${args.target}`)
    } else {
      for (const entry of RUNTIME_ENTRIES) {
        const from = join(ROOT, entry)
        if (!existsSync(from)) continue
        await copyTree(from, join(args.target, entry))
      }
      console.log(`deploy: 已复制运行文件 → ${args.target}`)
    }
  } else {
    console.log('deploy: 运行路径就是仓库目录，跳过复制')
  }

  const entryPath = join(args.target, 'index.js')
  if (!existsSync(entryPath) && !args.dryRun) {
    console.error(`deploy: 找不到 ${entryPath}`)
    process.exitCode = 1
    return
  }

  if (args.noPatch) {
    console.log('deploy: --no-patch，未修改 profile')
    return
  }

  const profilePatch = join(homedir(), '.dsh', 'profiles', args.profile, 'cordis.patch.yml')
  if (!existsSync(profilePatch)) {
    console.error(`deploy: 找不到 profile patch：${profilePatch}`)
    process.exitCode = 1
    return
  }
  const source = await readFile(profilePatch, 'utf8')
  const { text, changed } = upsertPatchEntry(source, { entryId: ENTRY_ID, entryPath })
  if (!changed) {
    console.log(`deploy: profile 里已有 id=${ENTRY_ID} 的条目，无需修改`)
  } else if (args.dryRun) {
    console.log('deploy: [dry-run] 将追加：\n' + text.slice(source.replace(/\s*$/, '').length))
  } else {
    const backup = `${profilePatch}.bak.dsh-folder-sessions-${timestamp()}`
    await writeFile(backup, source, 'utf8')
    const tmp = `${profilePatch}.tmp-${process.pid}`
    await writeFile(tmp, text, 'utf8')
    await chmod(tmp, 0o600)
    await rename(tmp, profilePatch)
    console.log(`deploy: 已写入 profile patch（备份：${backup}）`)
  }

  console.log('')
  console.log('注意：这是开发期「绝对路径条目」安装。以后若改用 DSH 插件页安装 npm/GitHub/tgz 包，')
  console.log('      请先删掉 profile patch 里 name 为绝对路径的这条 insert（避免同 id 两条条目）。')
  console.log('下一步：完全退出 DSH（⌘Q，确认进程退出）并重新打开。')
  console.log('重启后验证：node scripts/verify.mjs')
}

/**
 * 生成 `YYYYMMDD-HHmmss` 时间戳。
 * @returns {string}
 */
function timestamp() {
  const date = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
