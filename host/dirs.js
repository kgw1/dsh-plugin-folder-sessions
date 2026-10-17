/**
 * 会话目录的创建与重命名。
 *
 * 两条能力：
 *  1. `createSessionDirectory()`：在配置的根目录下建一个新的会话工作区目录
 *     （默认名 `YYYYMMDD-HHmmss`，重名自动追加 `-2`、`-3`…）。
 *  2. `renameWorkspaceDirectory()`：把「本插件管理的」工作区目录真实改名，
 *     并把 DSH 的 workspace registry 记录同步改到新路径（显示名 = 用户输入的标题）。
 *
 * 为什么重命名要碰 registry（这是本插件唯一依赖宿主内部结构的地方）：
 *  - DSH 0.2.0-rc.2 的 `workspaceRegistry` 没有公开的“改路径”API（只有 setTitle）；
 *  - 会话的 cwd 是创建时写进会话头的，指向旧路径；如果只 rename 磁盘目录而不改记录，
 *    旧会话的工具会落到不存在的路径，新建会话也会 attach 失败（cwd realpath ≠ record.path）；
 *  - 所以做法是：rename 磁盘目录 → 在旧路径留一个指向新目录的软链接（旧会话 cwd 仍可解析）
 *    → 更新 registry 的 sessionPath 索引与 record.path/title（一次性完成，客户端会收到 upsert 帧）。
 *
 * 兼容性防线：所有内部字段（sessionPaths / mutate / invalidSessionPaths）都先探测再用；
 * 一旦宿主版本不匹配就降级为“只改显示名”（返回 fallback 标记），绝不半途改坏目录。
 */

import { lstat, mkdir, realpath, rename, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 目录名里禁止/不友好的字符（跨平台保守集合）。 */
const UNSAFE_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g

/**
 * 生成默认会话目录名：本地时间 `YYYYMMDD-HHmmss`。
 * @param {Date} [date]
 * @returns {string}
 */
export function formatSessionDirName(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    '-',
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('')
}

/**
 * 把用户输入的标题/名字清洗成合法目录名。
 * @param {unknown} input
 * @returns {string | null} 清洗后的名字；无法得到非空名字时返回 null。
 */
export function sanitizeDirName(input) {
  if (typeof input !== 'string') return null
  let name = input.normalize('NFC').trim()
  if (name === '') return null
  name = name.replace(UNSAFE_NAME_CHARS, '-')
  name = name.replace(/\s+/g, ' ').replace(/-+/g, '-')
  // 去掉首尾的点和横线：`.`/`..` 是保留名，首点会变成隐藏目录。
  name = name.replace(/^[.\-\s]+/, '').replace(/[.\-\s]+$/, '')
  if (name === '') return null
  if (name.length > 120) name = name.slice(0, 120).replace(/[.\-\s]+$/, '')
  return name === '' ? null : name
}

/**
 * 在父目录下挑一个不冲突的子目录绝对路径。
 * @param {string} parent - 已存在的父目录（绝对路径）。
 * @param {string} desired - 期望的单段目录名。
 * @returns {Promise<{ path: string, name: string }>}
 */
export async function uniqueChildPath(parent, desired) {
  let attempt = 0
  for (;;) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const name = `${desired}${suffix}`
    const path = join(parent, name)
    let exists = false
    try {
      await lstat(path)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) return { path, name }
    attempt += 1
    if (attempt > 1000) throw new Error(`无法在 ${parent} 下生成唯一目录名（尝试了 1000 次）`)
  }
}

/**
 * 判断某个路径是否直接位于给定根目录下（按路径层级，不做 realpath）。
 * @param {string} candidate - 工作区目录路径。
 * @param {string} root - 根目录路径。
 * @returns {boolean}
 */
export function isDirectChildOf(candidate, root) {
  if (!isAbsolute(candidate) || !isAbsolute(root)) return false
  return dirname(resolve(candidate)) === resolve(root)
}

/**
 * 建“会话目录 + 重命名”服务。
 *
 * @param {object} options
 * @param {ReturnType<import('./config.js').createConfigStore>} options.configStore
 * @param {(message: string) => void} [options.log]
 * @param {() => unknown} [options.getRegistry] - 软获取 host 的 workspaceRegistry 服务。
 */
export function createWorkspaceDirs(options) {
  const { configStore } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getRegistry = typeof options.getRegistry === 'function' ? options.getRegistry : () => undefined

  /**
   * 在根目录下创建一个新会话目录。
   * @param {{ name?: unknown, now?: Date }} [input]
   * @returns {Promise<
   *   { ok: true, path: string, name: string, baseDir: string }
   *   | { ok: false, code: 'config' | 'create', error: string }
   * >}
   */
  async function createSessionDirectory(input = {}) {
    const ensured = await configStore.ensureBaseDir()
    if (!ensured.ok) return { ok: false, code: 'config', error: ensured.error }
    const baseDir = ensured.baseDir
    const desired = sanitizeDirName(input.name) ?? formatSessionDirName(input.now ?? new Date())
    try {
      const target = await uniqueChildPath(baseDir, desired)
      await mkdir(target.path, { recursive: true })
      log(`[folder-sessions] 新会话目录：${target.path}`)
      return { ok: true, path: target.path, name: target.name, baseDir }
    } catch (error) {
      return { ok: false, code: 'create', error: `无法创建会话目录：${errorMessage(error)}` }
    }
  }

  /**
   * 把本插件管理的工作区目录改名（同时更新工作区显示名）。
   *
   * @param {{ workspaceId?: unknown, title?: unknown }} input
   * @returns {Promise<
   *   | { ok: true, changed: 'directory' | 'title' | 'none', path: string, oldPath: string, title: string }
   *   | { ok: false, code: 'invalid' | 'unmanaged' | 'not-found' | 'conflict' | 'unsupported' | 'rename', error: string, workspaceId?: string }
   * >}
   */
  async function renameWorkspaceDirectory(input = {}) {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (workspaceId === '') return { ok: false, code: 'invalid', error: '缺少工作区 id' }
    if (title === '') return { ok: false, code: 'invalid', error: '名字不能为空' }

    const registry = getRegistry()
    if (registry === undefined || registry === null || typeof registry.get !== 'function') {
      return { ok: false, code: 'unsupported', error: '宿主没有 workspaceRegistry 服务' }
    }
    const workspace = registry.get(workspaceId)
    if (workspace === undefined || workspace === null) {
      return { ok: false, code: 'not-found', workspaceId, error: '找不到这个工作区' }
    }
    const registryPath = String(workspace.path ?? '')
    if (registryPath === '') return { ok: false, code: 'invalid', error: '工作区没有路径' }

    const roots = await configStore.managedRoots()
    /** 旧路径可能已经是上一轮改名留下的软链接，统一按真实路径判断所属根目录。 */
    let realPath
    try {
      realPath = await realpath(registryPath)
    } catch {
      return { ok: false, code: 'invalid', error: `工作区目录不存在：${registryPath}` }
    }
    const root = await findOwningRoot(roots, realPath)
    if (root === undefined) {
      return {
        ok: false,
        code: 'unmanaged',
        workspaceId,
        error: '该工作区不是「新会话自动创建的目录」，目录名不会被修改',
      }
    }

    const desired = sanitizeDirName(title)
    if (desired === null) return { ok: false, code: 'invalid', error: '名字里没有可用字符' }
    const target = join(dirname(realPath), desired)
    const sameDirectory = target === realPath

    const capability = probeRegistryCapability(registry, workspace)
    if (!sameDirectory && !capability.ok) {
      // 宿主结构不匹配：降级为只改显示名（交给调用方的原 rename 流程）。
      return {
        ok: false,
        code: 'unsupported',
        workspaceId,
        error: `无法安全重命名目录（${capability.reason}）；已忽略目录改名`,
      }
    }

    if (sameDirectory) {
      const applied = await applyTitleOnly(registry, workspace, title)
      if (!applied) {
        return { ok: false, code: 'unsupported', workspaceId, error: '无法更新工作区显示名' }
      }
      return { ok: true, changed: 'title', path: registryPath, oldPath: registryPath, title }
    }

    // 目标已存在（且不是自己）→ 冲突，交给用户换名字。
    try {
      const info = await stat(target)
      if (info.isDirectory() || info.isFile()) {
        return { ok: false, code: 'conflict', workspaceId, error: `目录已存在：${desired}` }
      }
    } catch {
      /* 不存在 = 可以改 */
    }

    const sessionIds = Array.isArray(workspace.sessionIds) ? [...workspace.sessionIds] : []
    let renamed = false
    try {
      await rename(realPath, target)
      renamed = true
    } catch (error) {
      return { ok: false, code: 'rename', workspaceId, error: `重命名目录失败：${errorMessage(error)}` }
    }

    // 旧路径留一个指向新目录的软链接：已创建会话的 cwd 指向旧路径，这样它们的工具调用不会落空。
    const link = await ensureCompatSymlink(registryPath, target)
    if (!link.ok) {
      // 软链接失败 → 回滚目录名，保持一致性。
      try {
        await rename(target, realPath)
      } catch (rollbackError) {
        log(`[folder-sessions] 回滚目录名失败：${errorMessage(rollbackError)}（${target} → ${realPath}）`)
      }
      return { ok: false, code: 'rename', workspaceId, error: `创建兼容软链接失败：${link.error}` }
    }

    const updated = await updateRegistryPath(registry, workspace, target, title, sessionIds, registryPath)
    if (!updated.ok) {
      // registry 更新失败 → 回滚目录与兼容软链接，保持“要么全成、要么全不动”。
      log(`[folder-sessions] registry 更新失败，回滚目录改名：${updated.error}`)
      const rolledBack = await rollbackDirectory(registryPath, realPath, target)
      if (!rolledBack.ok) {
        log(`[folder-sessions] 回滚目录失败（保留软链接兜底）：${rolledBack.error}`)
      }
      return {
        ok: false,
        code: 'rename',
        workspaceId,
        error: `工作区记录更新失败${rolledBack.ok ? '（目录已回滚）' : '（目录回滚失败）'}：${updated.error}`,
      }
    }

    log(`[folder-sessions] 工作区目录改名：${registryPath} → ${target}（标题：${title}）`)
    return { ok: true, changed: 'directory', path: target, oldPath: registryPath, title }
  }

  return {
    createSessionDirectory,
    renameWorkspaceDirectory,
  }
}

/**
 * 找出 realPath 的直接父目录属于哪个受管根目录。
 * @param {string[]} roots
 * @param {string} realPath
 * @returns {Promise<string | undefined>}
 */
async function findOwningRoot(roots, realPath) {
  const parent = dirname(realPath)
  for (const root of roots) {
    let canonical
    try {
      canonical = await realpath(root)
    } catch {
      continue
    }
    if (parent === canonical) return canonical
  }
  return undefined
}

/**
 * 探测宿主 registry 内部结构是否支持“改路径”。
 * @param {any} registry
 * @param {any} workspace
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function probeRegistryCapability(registry, workspace) {
  if (typeof workspace.mutate !== 'function') return { ok: false, reason: 'workspace.mutate 不存在' }
  if (!(registry.sessionPaths instanceof Map)) return { ok: false, reason: 'sessionPaths 索引不存在' }
  return { ok: true }
}

/**
 * 只更新显示名（不碰磁盘）。
 * @param {any} registry
 * @param {any} workspace
 * @param {string} title
 * @returns {Promise<boolean>}
 */
async function applyTitleOnly(registry, workspace, title) {
  try {
    if (typeof workspace.setTitle === 'function') {
      await workspace.setTitle(title)
      return true
    }
    if (typeof workspace.mutate === 'function') {
      await workspace.mutate((record) => ({ ...record, title }))
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 在旧路径放一个指向新目录的兼容软链接（幂等：已有软链接先删）。
 * @param {string} linkPath
 * @param {string} targetPath
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function ensureCompatSymlink(linkPath, targetPath) {
  try {
    let existing
    try {
      existing = await lstat(linkPath)
    } catch {
      existing = undefined
    }
    if (existing !== undefined) {
      if (!existing.isSymbolicLink()) {
        // 旧路径是一个真实文件/目录（不该出现）：绝不覆盖。
        return { ok: false, error: `旧路径不是软链接，拒绝覆盖：${linkPath}` }
      }
      // 上一轮改名留下的软链接：先摘掉再重建。
      await unlink(linkPath)
    }
    await symlink(targetPath, linkPath, 'dir')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * 更新 registry：sessionPath 索引 + record.path/title。
 * @param {any} registry
 * @param {any} workspace
 * @param {string} newPath
 * @param {string} title
 * @param {string[]} sessionIds
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function updateRegistryPath(registry, workspace, newPath, title, sessionIds, previousPath) {
  const sessionPaths = registry.sessionPaths
  const invalid = registry.invalidSessionPaths
  /** @type {Map<string, string | undefined>} */
  const previousPaths = new Map()
  /** @type {Map<string, boolean>} */
  const previousValidity = new Map()
  try {
    // 1) sessionPath 索引先指到新路径：mutate 会按 `sessionPath(id) === record.path` 过滤成员。
    for (const sessionId of sessionIds) {
      previousPaths.set(sessionId, sessionPaths.get(sessionId))
      sessionPaths.set(sessionId, newPath)
      if (invalid instanceof Map) {
        previousValidity.set(sessionId, invalid.has(sessionId))
        invalid.delete(sessionId)
      }
    }
    // 2) 写入新 record：path + title 一次完成（domain 变更会推 upsert 给客户端）。
    await workspace.mutate((record) => ({ ...record, path: newPath, title }))
    return { ok: true }
  } catch (error) {
    // 索引回滚（record 本身没写成，不需要动）。
    for (const [sessionId, value] of previousPaths) {
      if (value === undefined) sessionPaths.delete(sessionId)
      else sessionPaths.set(sessionId, value)
    }
    if (invalid instanceof Map) {
      for (const [sessionId, wasInvalid] of previousValidity) {
        if (wasInvalid) invalid.set(sessionId, previousPath ?? newPath)
        else invalid.delete(sessionId)
      }
    }
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * 回滚一次目录改名：先摘掉兼容软链接，再把新目录改回旧真实路径。
 * @param {string} registryPath - registry 记录里的路径（可能是旧的兼容软链接）。
 * @param {string} realPath - 改名前的真实路径。
 * @param {string} target - 改名后的真实路径。
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function rollbackDirectory(registryPath, realPath, target) {
  try {
    if (registryPath !== realPath) {
      try {
        const linkInfo = await lstat(registryPath)
        if (linkInfo.isSymbolicLink()) await unlink(registryPath)
      } catch {
        /* 已经没有软链接（或本来就不是链接）→ 继续回滚目录 */
      }
    } else {
      try {
        const linkInfo = await lstat(registryPath)
        if (linkInfo.isSymbolicLink()) await unlink(registryPath)
      } catch {
        /* ignore */
      }
    }
    await rename(target, realPath)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * 把一个错误压成可读字符串。
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
