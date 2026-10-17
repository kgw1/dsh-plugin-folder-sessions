#!/usr/bin/env node
/**
 * 重启后的端到端验证（不需要 token：命名路由在 DSH 的 auth fallback 之前命中）。
 *
 *  1. GET  /folder-sessions/api/health    → 插件/路由/registry 状态
 *  2. GET  /folder-sessions/api/config    → 当前根目录
 *  3. POST /folder-sessions/api/directories → 真实建一个目录，再删掉（验证创建链路）
 *
 * 用法：node scripts/verify.mjs [--base-url http://127.0.0.1:19387]
 */

import { rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认 GUI 地址（desktop app 的 dsh web）。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:19387'

/** 路由前缀。 */
const API_PREFIX = '/folder-sessions/api'

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 */
async function request(url, init = {}, timeoutMs = 5000) {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined
    ? undefined
    : setTimeout(() => {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }, timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      ...controller === undefined ? {} : { signal: controller.signal },
    })
    const text = await response.text()
    let body = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    return { status: response.status, body, text }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * @param {string} baseUrl
 */
async function main() {
  const baseArgIndex = process.argv.indexOf('--base-url')
  const baseUrl = baseArgIndex >= 0 ? process.argv[baseArgIndex + 1] : DEFAULT_BASE_URL
  let failures = 0

  const healthUrl = `${baseUrl}${API_PREFIX}/health`
  const health = await request(healthUrl)
  if (health.status !== 200 || health.body === null || health.body.ok !== true) {
    console.error(`✖ health 失败：HTTP ${health.status} ${health.text.slice(0, 300)}`)
    console.error('  可能原因：profile patch 未生效（需要完全退出 DSH 再打开），或插件加载失败。')
    process.exitCode = 1
    return
  }
  console.log('✔ health')
  console.log(`  plugin=${health.body.plugin} version=${health.body.version}`)
  console.log(`  baseDir=${health.body.baseDir}`)
  console.log(`  workspaceRegistry=${health.body.workspaceRegistry}`)
  console.log(`  routes=${health.body.routes.join(' | ')}`)
  if (Array.isArray(health.body.notes) && health.body.notes.length > 0) {
    console.log(`  notes=${health.body.notes.join('；')}`)
  }

  const configUrl = `${baseUrl}${API_PREFIX}/config`
  const config = await request(configUrl)
  if (config.status !== 200 || config.body === null || config.body.ok !== true) {
    failures += 1
    console.error(`✖ config 失败：HTTP ${config.status}`)
  } else {
    console.log(`✔ config（当前根目录：${config.body.baseDir}）`)
  }

  const createUrl = `${baseUrl}${API_PREFIX}/directories`
  const created = await request(createUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  let createdPath
  if (created.status !== 200 || created.body === null || created.body.ok !== true) {
    failures += 1
    console.error(`✖ directories 失败：HTTP ${created.status} ${created.text.slice(0, 300)}`)
  } else {
    createdPath = created.body.path
    console.log(`✔ directories（新建：${createdPath}）`)
    const baseDir = String(health.body.baseDir)
    const homeShort = join(homedir())
    const insideBase = typeof createdPath === 'string'
      && (createdPath.startsWith(`${baseDir}/`) || createdPath.startsWith(`${baseDir}/`.replace(homeShort, '~')))
    if (!insideBase) {
      failures += 1
      console.error(`✖ 新建目录不在根目录内：${createdPath}（baseDir=${baseDir}）`)
    } else {
      try {
        const info = await stat(createdPath)
        if (!info.isDirectory()) {
          failures += 1
          console.error('✖ 新建路径不是目录')
        }
        await rm(createdPath, { recursive: true, force: true })
        console.log('✔ 已清理测试目录')
      } catch (error) {
        failures += 1
        console.error(`✖ 检查/清理测试目录失败：${String(error)}`)
      }
    }
  }

  console.log('')
  if (failures > 0) {
    console.error(`verify: ${failures} 项失败`)
    process.exitCode = 1
    return
  }
  console.log('verify: 全部通过。GUI 侧行为请手动检查：')
  console.log('  1. 点左上角「新会话」→ 侧边栏出现新的时间戳工作区，会话在其中打开；')
  console.log('  2. 点某个工作区右侧「+」→ 仍在该工作区下新建会话（不建新目录）；')
  console.log('  3. 设置 → 通用 → 新会话目录 → 能显示/更改根目录；')
  console.log('  4. 工作区「⋯ → 重命名」改自动创建的目录 → 显示名+磁盘目录名都变。')
}

await main()
