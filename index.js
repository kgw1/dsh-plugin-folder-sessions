/**
 * dsh-folder-sessions —— DSH 宿主半。
 *
 * 职责（只做两件事，其余都是给客户端 UI 的支撑）：
 *  1. 提供一个「新会话目录」HTTP API：`POST /folder-sessions/api/directories`
 *     在配置的根目录下建一个新的会话工作区目录。
 *  2. 提供「工作区目录改名」HTTP API：`POST /folder-sessions/api/rename`
 *     真实重命名磁盘目录 + 同步 DSH workspace registry 的路径/标题。
 *
 * 契约纪律（沿用 DSH 0.2.0-rc.2 上实测的结论）：
 *  - 只有具名导出，绝不写 `export default`（loader 取 exports.default ?? exports，
 *    两者同时存在会让 name/inject/apply 被静默丢弃）。
 *  - 零裸导入：宿主按文件 URL 加载本插件，只允许 `node:` 内置与相对路径。
 *  - `apply` 内不抛错：任何一步失败只降级并记日志，profile 永远要能加载。
 *  - 硬依赖只声明 `webServer`；workspaceRegistry 等一律 `ctx.get()` 软访问。
 */

import { createConfigStore } from './host/config.js'
import { createWorkspaceDirs } from './host/dirs.js'
import { createRouter, mountRouter } from './host/http.js'

/** 插件名（profile 条目 id 之外的稳定标识）。 */
export const name = 'folder-sessions'

/** 插件版本（health 端点会回显）。 */
export const version = '0.1.0'

/** 硬依赖：路由要挂到 webServer 上。 */
export const inject = ['webServer']

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文。
 * @param {unknown} rawConfig profile 行里传入的 config（目前只认识 baseDir）。
 */
export function apply(ctx, rawConfig) {
  const log = makeLogger(ctx)

  /** 所有注册动作都包一层：单点失败只降级，不抛回 Cordis。 */
  const safe = (label, fn) => {
    try {
      return fn()
    } catch (error) {
      log(`[folder-sessions] ${label} 失败（已跳过）：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  try {
    const configStore = createConfigStore({ rawConfig, log })
    const getRegistry = () => safe('读取 workspaceRegistry', () => ctx.get('workspaceRegistry'))
    const dirs = createWorkspaceDirs({ configStore, log, getRegistry })
    const getWorkspaceRegistry = () => safe('读取 workspaceRegistry', () => ctx.get('workspaceRegistry'))
    const router = createRouter({
      configStore,
      dirs,
      getWorkspaceRegistry,
      log,
      version,
    })

    const mounted = safe('挂载 HTTP 路由', () => mountRouter({
      webServer: ctx.get('webServer'),
      router,
      log,
    }))
    if (mounted !== undefined && !mounted.mounted) {
      log(`[folder-sessions] 路由未挂载：${mounted.errors.join('；') || '未知原因'}`)
    }
    if (mounted !== undefined) {
      safe('注册卸载清理', () => {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => mounted.dispose(), 'dsh-folder-sessions: routes')
        }
      })
    }

    // 启动时把配置读一遍（失败不影响加载，只是热身缓存 + 诊断日志）。
    void configStore.load().then(
      (config) => {
        log(`[folder-sessions] 已加载（baseDir=${config.baseDir}）`)
      },
      (error) => {
        log(`[folder-sessions] 配置预热失败（不影响使用）：${error instanceof Error ? error.message : String(error)}`)
      },
    )
  } catch (error) {
    log(`[folder-sessions] 初始化失败（插件已静默降级）：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

/**
 * 构造一个只写日志、永不抛错的 logger。
 * @param {any} ctx
 * @returns {(message: string) => void}
 */
function makeLogger(ctx) {
  const seen = new Set()
  return (message) => {
    if (typeof message !== 'string' || message === '') return
    if (seen.has(message)) return
    if (seen.size > 200) seen.clear()
    seen.add(message)
    try {
      const logger = ctx?.logger
      // cordis 的 logger 既可能是带 info/warn 的对象，也可能是可调用的 service。
      if (logger !== undefined && logger !== null) {
        if (typeof logger.info === 'function') {
          logger.info(message)
          return
        }
        if (typeof logger === 'function') {
          const named = logger('folder-sessions')
          if (named !== undefined && named !== null) {
            if (typeof named.info === 'function') {
              named.info(message)
              return
            }
            if (typeof named.warn === 'function') {
              named.warn(message)
              return
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      // eslint-disable-next-line no-console
      console.log(message)
    } catch {
      /* ignore */
    }
  }
}
