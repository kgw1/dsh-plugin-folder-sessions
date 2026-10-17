/**
 * 配置存储：新会话目录的根目录（baseDir）。
 *
 * 落盘位置：`$DSH_HOME/folder-sessions.json`（DSH_HOME 缺省 `~/.dsh`）。
 * 形态：
 *   {
 *     "version": 1,
 *     "baseDir": "/Users/me/dsh-sessions",      // 当前根目录（绝对路径）
 *     "knownRoots": ["/Users/me/dsh-sessions"]  // 历史上用过的根目录（用于识别“本插件管理的目录”）
 *   }
 *
 * 设计纪律：
 *  - 读失败 / 文件缺失 / 字段非法一律回退默认值，绝不抛错（profile 永远要能加载）。
 *  - 写盘用「临时文件 + rename」原子替换；失败只记日志、返回错误对象，不抛。
 *  - 用户输入允许 `~/xxx` 形式；其余必须是绝对路径。
 */

import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 配置文件版本号（目前只有 v1）。 */
export const CONFIG_VERSION = 1

/**
 * 解析 DSH 主目录：优先 `DSH_HOME` 环境变量，其次 `~/.dsh`。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return expandHome(fromEnv, env)
  return join(resolveHomeDir(env), '.dsh')
}

/**
 * 解析用户主目录（测试可注入 env.HOME）。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveHomeDir(env = process.env) {
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : ''
  if (home !== '') return home
  return homedir()
}

/**
 * 展开路径开头的 `~`。
 * @param {string} input - 用户输入的路径。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function expandHome(input, env = process.env) {
  const text = String(input ?? '').trim()
  if (text === '~') return resolveHomeDir(env)
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return join(resolveHomeDir(env), text.slice(2))
  }
  return text
}

/**
 * 把用户输入规整成绝对路径；不合法时返回 null。
 * @param {unknown} input
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function normalizeBaseDirInput(input, env = process.env) {
  if (typeof input !== 'string') return null
  const expanded = expandHome(input, env)
  if (expanded === '') return null
  if (!isAbsolute(expanded)) return null
  return resolve(expanded)
}

/**
 * 读取 JSON 文件；缺失或损坏返回 undefined（不抛错）。
 * @param {string} file
 * @returns {Promise<unknown | undefined>}
 */
async function readJsonSafe(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 原子写 JSON：先写 `<file>.tmp-<pid>`，再 rename 覆盖。
 * @param {string} file
 * @param {unknown} value
 */
async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  await rename(tmp, file)
}

/**
 * 归一化落盘配置：只保留认识的字段，非法值丢弃。
 * @param {unknown} raw
 * @param {{ defaultBaseDir: string }} defaults
 * @returns {{ version: number, baseDir: string, knownRoots: string[] }}
 */
export function normalizeStoredConfig(raw, defaults) {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const baseDir = typeof source.baseDir === 'string' && isAbsolute(source.baseDir.trim())
    ? resolve(source.baseDir.trim())
    : defaults.defaultBaseDir
  const knownRoots = []
  if (Array.isArray(source.knownRoots)) {
    for (const item of source.knownRoots) {
      if (typeof item !== 'string') continue
      const value = item.trim()
      if (value === '' || !isAbsolute(value)) continue
      const canonical = resolve(value)
      if (!knownRoots.includes(canonical)) knownRoots.push(canonical)
    }
  }
  if (!knownRoots.includes(baseDir)) knownRoots.push(baseDir)
  return { version: CONFIG_VERSION, baseDir, knownRoots }
}

/**
 * 建配置存储。
 *
 * @param {object} options
 * @param {Record<string, unknown>} [options.rawConfig] - profile 插件行里的 config（可含 baseDir）。
 * @param {Record<string, string | undefined>} [options.env] - 环境变量（测试注入）。
 * @param {string} [options.file] - 直接指定配置文件路径（测试注入）。
 * @param {(message: string) => void} [options.log]
 * @param {() => string} [options.defaultBaseDir] - 覆盖默认根目录（测试注入）。
 * @returns {object} 配置存储 API。
 */
export function createConfigStore(options = {}) {
  const env = options.env ?? process.env
  const log = typeof options.log === 'function' ? options.log : () => {}
  const configFile = options.file ?? join(resolveDshHome(env), 'folder-sessions.json')
  const defaultBaseDir = options.defaultBaseDir
    ?? join(resolveHomeDir(env), 'dsh-sessions')
  /** profile 行里配置的初始根目录（文件里没有 baseDir 时兜底）。 */
  const rawConfig = typeof options.rawConfig === 'object' && options.rawConfig !== null
    ? options.rawConfig
    : {}
  const seedBaseDir = normalizeBaseDirInput(rawConfig.baseDir, env) ?? defaultBaseDir

  /** @type {{ version: number, baseDir: string, knownRoots: string[] } | undefined} */
  let cached

  /**
   * 读当前配置（带缓存）。
   * @returns {Promise<{ version: number, baseDir: string, knownRoots: string[] }>}
   */
  async function load() {
    if (cached !== undefined) return cached
    const raw = await readJsonSafe(configFile)
    cached = normalizeStoredConfig(raw, { defaultBaseDir: seedBaseDir })
    return cached
  }

  /**
   * 当前配置快照（还没 load 过时用内存默认值）。
   * @returns {{ version: number, baseDir: string, knownRoots: string[] }}
   */
  function snapshot() {
    return cached ?? normalizeStoredConfig(undefined, { defaultBaseDir: seedBaseDir })
  }

  /**
   * 对外投影：附带默认值与配置文件路径，供设置行渲染。
   * @returns {Promise<{ baseDir: string, defaultBaseDir: string, configPath: string }>}
   */
  async function view() {
    const current = await load()
    return {
      baseDir: current.baseDir,
      defaultBaseDir: resolve(seedBaseDir),
      configPath: configFile,
    }
  }

  /**
   * “本插件管理”的根目录集合（历史 + 当前）。
   * @returns {Promise<string[]>}
   */
  async function managedRoots() {
    const current = await load()
    return [...current.knownRoots]
  }

  /**
   * 设置根目录：展开 ~、要求绝对路径、确保目录存在、写入 realpath。
   * @param {unknown} input
   * @returns {Promise<{ ok: true, baseDir: string } | { ok: false, error: string }>}
   */
  async function setBaseDir(input) {
    const normalized = normalizeBaseDirInput(input, env)
    if (normalized === null) {
      return { ok: false, error: '请输入绝对路径（或以 ~/ 开头的路径）' }
    }
    try {
      await mkdir(normalized, { recursive: true })
      const info = await stat(normalized)
      if (!info.isDirectory()) return { ok: false, error: '该路径不是目录' }
      const canonical = await realpath(normalized)
      const previous = await load()
      const next = normalizeStoredConfig(
        { ...previous, baseDir: canonical, knownRoots: [...previous.knownRoots, canonical] },
        { defaultBaseDir: seedBaseDir },
      )
      await writeJsonAtomic(configFile, next)
      cached = next
      log(`[folder-sessions] baseDir 已更新：${canonical}`)
      return { ok: true, baseDir: canonical }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `创建或写入目录失败：${message}` }
    }
  }

  /**
   * 确保当前根目录存在并返回其 realpath。
   * @returns {Promise<{ ok: true, baseDir: string } | { ok: false, error: string }>}
   */
  async function ensureBaseDir() {
    const current = await load()
    try {
      await mkdir(current.baseDir, { recursive: true })
      const canonical = await realpath(current.baseDir)
      if (canonical !== current.baseDir) {
        const next = normalizeStoredConfig(
          { ...current, baseDir: canonical, knownRoots: [...current.knownRoots, canonical] },
          { defaultBaseDir: seedBaseDir },
        )
        await writeJsonAtomic(configFile, next)
        cached = next
      }
      return { ok: true, baseDir: cached === undefined ? canonical : cached.baseDir }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `无法创建根目录 ${current.baseDir}：${message}` }
    }
  }

  return {
    configFile,
    defaultBaseDir: resolve(seedBaseDir),
    load,
    snapshot,
    view,
    managedRoots,
    setBaseDir,
    ensureBaseDir,
  }
}
