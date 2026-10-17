/**
 * dsh-folder-sessions —— 客户端半（源码，构建后包成 `client.js`）。
 *
 * 这个文件是纯逻辑 + React 组件的 ESM 源码，构建脚本（scripts/build-client.mjs）
 * 去掉 `export ` 前缀后塞进 `window.__ModuleLoader__.load({...factory})` 包装里。
 * 它不 import 任何东西（React 由 bundle 包装通过参数注入），因此可以直接被 Node 单测 import。
 *
 * 它做四件事：
 *  1. 拦截左上角「新会话」/ Cmd+N：不再"选中已有工作区"，而是在配置的根目录下新建一个
 *     会话目录 → 注册为新工作区 → 在其中创建会话并打开。
 *     （工作区行右边的「+」气泡调用的是带 workspaceId 的 startSession，原样放行。）
 *  2. 拦截工作区「重命名」：对自动创建的目录，同一次操作里真实重命名磁盘目录并同步显示名；
 *     非本插件管理的目录/宿主不支持时，落回原生"只改显示名"。
 *  3. 在「设置 → 通用」里加一行「新会话目录」，可以查看/更改根目录。
 *  4. 一个全局 toast 浮层：新建成功/失败、改名失败等反馈。
 *
 * 兼容性说明：DSH 0.2.0-rc.2 没有"新建会话时创建目录"的扩展点，也没有工作区改目录名
 * 的公开 API，所以这里用两处受控的 monkey-patch（见 patchStartSession / patchRename）。
 * 两处都做到了：只改目标入口、其它调用方原样放行、宿主缺服务时静默降级。
 */

/*
 * 插件 id（浏览器模块表键）=== package.json 的 name，由 scripts/build-client.mjs
 * 在构建时注入 __ModuleLoader__.load({ id })；源码里不重复写死，改名时不会失同步。
 */

/** 本地化命名空间。 */
export const NS = 'folderSessions'

/** 客户端路由前缀（必须与宿主 host/http.js 的 API_PREFIX 一致）。 */
export const API_PREFIX = 'folder-sessions/api'

/** 保存新会话根目录的 HTTP 超时。 */
const REQUEST_TIMEOUT_MS = 10000

/** toast 自动消失时间。 */
const TOAST_DURATION_MS = 4500

/** 已打补丁的标记（symbol 不会和宿主属性冲突）。 */
const PATCHED = Symbol.for('dsh-folder-sessions.patched')

/** cordis 里“服务实例原始对象”的约定 symbol（proxy[symbols.original] === target）。 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** 中文文案（键集合的唯一真源）。 */
export const ZH = {
  'settings.title': '新会话目录',
  'settings.description': '点击左上角「新会话」时，会在这个目录下新建一个会话工作区目录（每个会话一个目录）。',
  'settings.hint': '自动创建的目录可以在侧边栏工作区的「⋯ → 重命名」里改名：会同时改显示名和磁盘目录名。',
  'settings.current': '当前目录',
  'settings.loading': '读取中…',
  'settings.choose': '更改…',
  'settings.reset': '恢复默认',
  'settings.saving': '保存中…',
  'settings.saved': '已保存',
  'settings.defaultTag': '默认',
  'toast.created': '已新建会话目录：{name}',
  'toast.createDirFailed': '新建会话目录失败：{message}',
  'toast.workspaceFailed': '注册工作区失败：{message}',
  'toast.openFailed': '打开新会话失败：{message}',
  'toast.serviceMissing': '目录服务未就绪，已退回默认的新建会话行为',
  'toast.renameFailed': '重命名工作区失败：{message}',
  'toast.pickFailed': '选择目录失败：{message}',
}

/** 英文文案。 */
export const EN = {
  'settings.title': 'New session folder',
  'settings.description': 'The New Session button creates a fresh session workspace directory under this folder (one directory per session).',
  'settings.hint': 'Auto-created folders can be renamed from a workspace\'s "⋯ → Rename" menu: both the display name and the on-disk folder are renamed.',
  'settings.current': 'Current folder',
  'settings.loading': 'Loading…',
  'settings.choose': 'Change…',
  'settings.reset': 'Use default',
  'settings.saving': 'Saving…',
  'settings.saved': 'Saved',
  'settings.defaultTag': 'default',
  'toast.created': 'Created session folder: {name}',
  'toast.createDirFailed': 'Could not create the session folder: {message}',
  'toast.workspaceFailed': 'Could not register the workspace: {message}',
  'toast.openFailed': 'Could not open the new session: {message}',
  'toast.serviceMissing': 'Folder service is not available yet; falling back to the default New Session behavior',
  'toast.renameFailed': 'Could not rename the workspace: {message}',
  'toast.pickFailed': 'Could not pick a folder: {message}',
}

/** 注入的 React 兼容最小面。 */

/**
 * 格式化文案里的 `{name}` 占位。
 * @param {string} template
 * @param {Record<string, unknown>} [vars]
 * @returns {string}
 */
export function formatText(template, vars) {
  if (vars === undefined || vars === null) return template
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key) => {
    const value = vars[key]
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * 由一篇字典造一个 t()（无 locale 服务时的兜底）。
 * @param {Record<string, string>} dict
 * @returns {(key: string, vars?: Record<string, unknown>) => string}
 */
export function createTranslator(dict) {
  return (key, vars) => formatText(dict[key] ?? key, vars)
}

/**
 * 判断一次 `uiWorkspace.startSession()` 调用是否来自「新会话」按钮。
 *
 * 0.2.0-rc.2 里该服务有 5 个调用方，靠**实参形态 + 调用者 this** 区分
 * （比调用栈可靠：宿主把多个插件打包进同一个 combo script，栈里 URL 区分不了插件）：
 *
 *  - 侧边栏「新会话」/ 折叠栏按钮 / 顶部 HeaderLeadingControls 按钮：
 *    `injectProps.startSession(workspaceId)` → 服务层收到 **1 个实参（undefined）**；
 *  - 工作区行右侧「+」气泡：服务层收到 **1 个实参（工作区 id）** → 原样放行；
 *  - Cmd+N 快捷键（ui-workspace 的 shortcut 直接调用原始服务实例，`this === rawUi`
 *    且 0 实参）→ 视为「新会话」；
 *  - 计划任务面板 / 智能体预设草稿：经 `ctx.uiWorkspace` 的服务代理调用，`this`
 *    是 cordis 的 shadow context（≠ 原始实例）且 0 实参 → 原样放行（DSH 原生行为）。
 *
 * @param {IArguments | ArrayLike<unknown> | undefined} args
 * @returns {boolean} true = 来自「新会话」按钮，应走“新建目录”流程。
 */
export function isNewSessionButtonCall(args) {
  if (args === undefined || args === null) return false
  if (args.length !== 1) return false
  return args[0] === undefined || args[0] === null
}

/**
 * Cmd+N 走的是 ui-workspace 注册的快捷键：`navigation.startSession()`，
 * 其中 navigation 是 uiWorkspace 原始实例 → 服务方法里的 `this === rawUi`。
 * 其它“0 实参”调用方（计划任务/预设草稿）经由 ctx 服务代理，this 是 shadow context。
 *
 * @param {any} selfCall - 被调用时的 this。
 * @param {any} rawUi - uiWorkspace 原始服务实例。
 * @param {IArguments | ArrayLike<unknown>} args
 * @returns {boolean}
 */
export function isNewSessionShortcutCall(selfCall, rawUi, args) {
  if (args === undefined || args === null || args.length !== 0) return false
  return selfCall === rawUi
}

/**
 * 从一个 cordis 服务访问值里取出原始实例（proxy → target）。
 * @param {any} value
 * @returns {any}
 */
export function rawService(value) {
  if (value === null || typeof value !== 'object') return value
  try {
    const raw = value[CORDIS_ORIGINAL]
    if (raw !== undefined && raw !== null) return raw
  } catch {
    /* ignore */
  }
  return value
}

/**
 * 极简 store（getSnapshot/subscribe/set），可直接喂给 React.useSyncExternalStore。
 * @param {any} initial
 * @returns {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void, set: (patch: any) => void }}
 */
export function createStore(initial) {
  let state = initial
  /** @type {Set<() => void>} */
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (patch) => {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch }
      if (next === state) return
      state = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          /* ignore subscriber errors */
        }
      }
    },
  }
}

/** HTTP 层错误（携带状态码与宿主业务 code，便于降级判断）。 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, transport?: boolean }} [meta]
   */
  constructor(message, meta = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = meta.status ?? 0
    this.code = meta.code ?? 'unknown'
    this.transport = meta.transport === true
  }
}

/**
 * 建 HTTP 客户端（同源 fetch）。
 *
 * @param {object} options
 * @param {(input: any, init?: any) => Promise<any>} options.fetchImpl
 * @param {() => string} options.baseURI
 * @param {(handler: () => void, ms: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 * @returns {object} API 客户端。
 */
export function createApi(options) {
  const fetchImpl = options.fetchImpl
  const baseURI = options.baseURI
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout

  /**
   * @param {string} path
   * @returns {string}
   */
  function urlFor(path) {
    const relative = `${API_PREFIX}/${path}`
    try {
      return new URL(relative, baseURI()).toString()
    } catch {
      return relative
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function request(method, path, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller === undefined
      ? undefined
      : setTimer(() => {
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
      }, REQUEST_TIMEOUT_MS)
    /** @type {any} */
    const init = {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    if (controller !== undefined) init.signal = controller.signal
    let response
    try {
      response = await fetchImpl(urlFor(path), init)
    } catch (error) {
      throw new ApiError(
        `无法连接目录服务：${error instanceof Error ? error.message : String(error)}`,
        { code: 'transport', transport: true },
      )
    } finally {
      if (timer !== undefined) clearTimer(timer)
    }
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let payload
    try {
      payload = text === '' ? null : JSON.parse(text)
    } catch {
      payload = null
    }
    const status = Number(response.status ?? 0)
    if (status === 404 || status === 405) {
      throw new ApiError('目录服务未挂载（HTTP 404）', { status, code: 'transport', transport: true })
    }
    if (!response.ok) {
      const message = payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${status}`
      throw new ApiError(message, {
        status,
        code: payload !== null && typeof payload === 'object' && typeof payload.code === 'string' ? payload.code : 'http',
      })
    }
    if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
      throw new ApiError('目录服务响应不是合法 JSON', { status, code: 'transport', transport: true })
    }
    return payload
  }

  return {
    baseURI,
    getConfig: () => request('GET', 'config'),
    setConfig: (baseDir) => request('POST', 'config', { baseDir }),
    createDirectory: () => request('POST', 'directories', {}),
    renameWorkspace: (workspaceId, title) => request('POST', 'rename', { workspaceId, title }),
  }
}

/**
 * 建 toast 控制器。
 *
 * @param {object} [options]
 * @param {number} [options.durationMs]
 * @param {(handler: () => void, ms: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 */
export function createToaster(options = {}) {
  const durationMs = options.durationMs ?? TOAST_DURATION_MS
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout
  const store = createStore({ message: '', kind: 'info', seq: 0 })
  /** @type {any} */
  let timer
  return {
    store,
    /**
     * @param {string} message
     * @param {'info' | 'error'} [kind]
     */
    show(message, kind = 'info') {
      if (typeof message !== 'string' || message === '') return
      if (timer !== undefined) {
        clearTimer(timer)
        timer = undefined
      }
      store.set((state) => ({ message, kind, seq: state.seq + 1 }))
      timer = setTimer(() => {
        timer = undefined
        store.set((state) => ({ message: '', kind: 'info', seq: state.seq }))
      }, durationMs)
    },
    dispose() {
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
    },
  }
}

/**
 * 建「新会话目录」设置行的状态控制器。
 *
 * @param {object} options
 * @param {ReturnType<typeof createApi>} options.api
 * @param {() => Promise<string | null>} options.pickDirectory
 * @param {ReturnType<typeof createToaster>} options.toast
 * @param {(key: string, vars?: Record<string, unknown>) => string} options.t
 */
export function createBaseDirController(options) {
  const { api, pickDirectory, toast, t } = options
  const store = createStore({
    status: 'loading',
    baseDir: '',
    defaultBaseDir: '',
    configPath: '',
    saving: false,
    error: '',
    savedAt: 0,
  })
  /** @param {any} snapshot */
  const applyConfig = (snapshot) => {
    store.set({
      status: 'ready',
      baseDir: typeof snapshot.baseDir === 'string' ? snapshot.baseDir : '',
      defaultBaseDir: typeof snapshot.defaultBaseDir === 'string' ? snapshot.defaultBaseDir : '',
      configPath: typeof snapshot.configPath === 'string' ? snapshot.configPath : '',
      saving: false,
      error: '',
    })
  }
  return {
    store,
    /** 从宿主读取当前配置。 */
    async load() {
      store.set({ status: 'loading', error: '' })
      try {
        applyConfig(await api.getConfig())
      } catch (error) {
        store.set({
          status: 'error',
          saving: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    /** 打开原生目录选择器并保存选择。 */
    async choose() {
      if (store.getSnapshot().saving) return
      let picked
      try {
        picked = await pickDirectory()
      } catch (error) {
        toast.show(t('toast.pickFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
        return
      }
      if (typeof picked !== 'string' || picked === '') return
      await this.setBaseDir(picked)
    },
    /**
     * 保存一个根目录。
     * @param {string} baseDir
     */
    async setBaseDir(baseDir) {
      store.set({ saving: true, error: '' })
      try {
        applyConfig(await api.setConfig(baseDir))
        store.set((state) => ({ ...state, savedAt: Date.now() }))
      } catch (error) {
        store.set({
          saving: false,
          error: error instanceof Error ? error.message : String(error),
        })
        toast.show(t('toast.createDirFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
      }
    },
    /** 恢复默认根目录。 */
    async reset() {
      const snapshot = store.getSnapshot()
      if (snapshot.defaultBaseDir === '') {
        await this.setBaseDir('')
        return
      }
      await this.setBaseDir(snapshot.defaultBaseDir)
    },
  }
}

/**
 * 判断一个错误是否应该降级为宿主原生行为。
 * @param {unknown} error
 * @returns {boolean}
 */
export function shouldFallback(error) {
  if (!(error instanceof ApiError)) return false
  if (error.transport === true) return true
  if (error.code === 'unmanaged' || error.code === 'unsupported') return true
  return false
}

/**
 * 插件工厂：返回 `{ inject, apply }`（bundle 包装里直接返回这个对象）。
 *
 * @param {object} deps
 * @param {any} deps.React - React 运行时（react 平台种子模块）。
 * @param {object} [deps.env] - 可注入环境（测试用）：fetch/baseURI/setTimer/clearTimer。
 * @returns {{ inject: string[], apply: (ctx: any) => void }}
 */
export function createPlugin(deps) {
  const React = deps?.React
  const env = deps?.env ?? {}
  const h = typeof React?.createElement === 'function'
    ? React.createElement
    : () => null
  const fetchImpl = env.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const baseURI = env.baseURI ?? (() => {
    try {
      return (typeof document !== 'undefined' && document !== null && document.baseURI) || 'http://127.0.0.1/'
    } catch {
      return 'http://127.0.0.1/'
    }
  })
  const setTimer = env.setTimer
  const clearTimer = env.clearTimer

  const api = createApi({ fetchImpl, baseURI, setTimer, clearTimer })
  const toast = createToaster({ setTimer, clearTimer })

  /** 硬依赖：slots（UI 座位）、locale（文案）、uiWorkspace（导航）、workspaces（建工作区/改名）。 */
  const inject = ['slots', 'locale', 'uiWorkspace', 'workspaces']

  /**
   * @param {any} ctx
   */
  function apply(ctx) {
    const t = bindLocale(ctx)
    injectStyle(typeof document !== 'undefined' ? document : undefined)

    const rawUiWorkspace = rawService(safeGet(ctx, 'uiWorkspace'))
    const rawWorkspaces = rawService(safeGet(ctx, 'workspaces'))

    // ── 1) 「新会话」按钮 / Cmd+N：在根目录下新建会话目录 ───────────────────
    if (rawUiWorkspace !== undefined && rawUiWorkspace !== null && typeof rawUiWorkspace.startSession === 'function') {
      patchStartSession(ctx, rawUiWorkspace, t)
    }

    // ── 2) 工作区「重命名」：目录 + 显示名一起改 ──────────────────────────
    if (rawWorkspaces !== undefined && rawWorkspaces !== null && typeof rawWorkspaces.rename === 'function') {
      patchRename(ctx, rawWorkspaces, t)
    }

    // ── 3) 设置页「新会话目录」一行 ───────────────────────────────────────
    const controller = createBaseDirController({
      api,
      pickDirectory: async () => {
        const raw = rawService(safeGet(ctx, 'uiWorkspace'))
        if (raw === undefined || raw === null || typeof raw.pickDirectory !== 'function') return null
        return await raw.pickDirectory()
      },
      toast,
      t,
    })
    safeEffect(ctx, () => {
      void controller.load()
      return () => {}
    })
    registerSettingsRow(ctx, controller, t)

    // ── 4) toast 浮层 ─────────────────────────────────────────────────────
    registerToastOverlay(ctx)

    safeEffect(ctx, () => () => {
      toast.dispose()
    })
  }

  /**
   * 给 uiWorkspace 服务实例打 startSession 补丁。
   * @param {any} ctx
   * @param {any} rawUi - uiWorkspace 原始服务实例。
   * @param {(key: string, vars?: Record<string, unknown>) => string} t
   */
  function patchStartSession(ctx, rawUi, t) {
    if (rawUi[PATCHED] === true) return
    const original = rawUi.startSession
    /** 防止连点/并发重复建目录。 */
    let creating = false

    /**
     * 新建目录 → 注册工作区 → 在其中创建会话并打开。
     * @returns {Promise<boolean>} 是否已自行处理（false = 调用方应回退原行为）。
     */
    async function createSessionInNewDirectory() {
      if (creating) return true
      creating = true
      try {
        let directory
        try {
          directory = await api.createDirectory()
        } catch (error) {
          if (shouldFallback(error)) {
            toast.show(t('toast.serviceMissing'), 'error')
            return false
          }
          toast.show(t('toast.createDirFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
          return true
        }
        const name = typeof directory.name === 'string' ? directory.name : ''
        let workspace
        try {
          const workspaceService = safeGet(ctx, 'workspaces') ?? rawService(safeGet(ctx, 'workspaces'))
          workspace = await workspaceService.create({ path: directory.path })
        } catch (error) {
          toast.show(t('toast.workspaceFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
          return true
        }
        toast.show(t('toast.created', { name }), 'info')
        if (typeof rawUi.openWorkspace === 'function' && workspace !== undefined && workspace !== null) {
          try {
            await rawUi.openWorkspace(workspace.workspaceId)
          } catch (error) {
            toast.show(t('toast.openFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
          }
        }
        return true
      } finally {
        creating = false
      }
    }

    rawUi.startSession = function folderSessionsStartSession(workspaceId) {
      const fromButton = isNewSessionButtonCall(arguments)
      const fromShortcut = isNewSessionShortcutCall(this, rawUi, arguments)
      if (!fromButton && !fromShortcut) {
        // 「+」气泡（显式 workspaceId）、计划任务、预设草稿、未知插件：
        // 一律沿用 DSH 原生行为。
        return original.apply(rawUi, arguments)
      }
      void createSessionInNewDirectory().then((handled) => {
        if (handled === false) original.apply(rawUi, arguments)
      })
      return undefined
    }
    Object.defineProperty(rawUi, PATCHED, { value: true, enumerable: false, configurable: true })
    safeEffect(ctx, () => () => {
      // 卸载时还原（delete 后原型方法自然恢复）。
      try {
        delete rawUi.startSession
      } catch {
        /* ignore */
      }
      try {
        delete rawUi[PATCHED]
      } catch {
        /* ignore */
      }
    })
  }

  /**
   * 给 workspaces 服务的 rename 打补丁：本插件管理的目录 → 目录 + 显示名一起改；
   * 其它工作区 / 宿主不支持 → 回退原生实现（只改显示名）。
   * @param {any} ctx
   * @param {any} rawWorkspaces
   * @param {(key: string, vars?: Record<string, unknown>) => string} t
   */
  function patchRename(ctx, rawWorkspaces, t) {
    if (rawWorkspaces[PATCHED] === true) return
    const original = rawWorkspaces.rename
    rawWorkspaces.rename = async function folderSessionsRename(workspaceId, title) {
      try {
        return await api.renameWorkspace(workspaceId, title)
      } catch (error) {
        if (shouldFallback(error)) return await original.call(rawWorkspaces, workspaceId, title)
        toast.show(t('toast.renameFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
        throw error
      }
    }
    Object.defineProperty(rawWorkspaces, PATCHED, { value: true, enumerable: false, configurable: true })
    safeEffect(ctx, () => () => {
      try {
        delete rawWorkspaces.rename
      } catch {
        /* ignore */
      }
      try {
        delete rawWorkspaces[PATCHED]
      } catch {
        /* ignore */
      }
    })
  }

  /**
   * 在「设置 → 通用」注册一行「新会话目录」。
   * @param {any} ctx
   * @param {ReturnType<typeof createBaseDirController>} controller
   * @param {(key: string, vars?: Record<string, unknown>) => string} t
   */
  function registerSettingsRow(ctx, controller, t) {
    const slots = safeGet(ctx, 'slots')
    if (slots === undefined || slots === null || typeof slots.inject !== 'function') return
    const register = () => {
      try {
        return slots.register({
          name: 'settings.general.item',
          id: 'folder-sessions.base-dir',
          order: 20,
          locale: NS,
          inject: () => ({
            // `hooks` 里放 BARE observable（getSnapshot/subscribe）：框架据此合成
            // `useBaseDirState(selector)` Hook，不要求 zustand/defineStore 句柄。
            hooks: { baseDirState: controller.store },
            choose: () => {
              void controller.choose()
            },
            reset: () => {
              void controller.reset()
            },
            reload: () => {
              void controller.load()
            },
          }),
        }, makeBaseDirRow(React, h, controller, t))
      } catch {
        return () => {}
      }
    }
    try {
      slots.inject('settings.general.item', register)
    } catch {
      /* 槽位未声明（旧宿主）→ 这一行不出现，其余功能不受影响 */
    }
  }

  /**
   * 注册全局 toast 浮层。
   * @param {any} ctx
   */
  function registerToastOverlay(ctx) {
    const slots = safeGet(ctx, 'slots')
    if (slots === undefined || slots === null || typeof slots.inject !== 'function') return
    const register = () => {
      try {
        return slots.register({
          name: 'shell.overlay',
          id: 'folder-sessions-toast',
          order: 100,
        }, makeToastOverlay(React, h, toast))
      } catch {
        return () => {}
      }
    }
    try {
      slots.inject('shell.overlay', register)
    } catch {
      /* ignore */
    }
  }

  /**
   * 绑定本地化：优先用 locale 服务，失败用内置中文。
   * @param {any} ctx
   * @returns {(key: string, vars?: Record<string, unknown>) => string}
   */
  function bindLocale(ctx) {
    try {
      const locale = safeGet(ctx, 'locale')
      if (locale === undefined || locale === null) return createTranslator(ZH)
      if (typeof ctx.effect === 'function' && typeof locale.register === 'function') {
        ctx.effect(() => {
          const dispose = locale.register(NS, { zh: ZH, en: EN })
          return typeof dispose === 'function' ? dispose : () => {}
        }, 'dsh-folder-sessions: dictionaries')
      }
      if (typeof locale.bind === 'function') {
        const bound = locale.bind(NS)
        if (typeof bound === 'function') return bound
      }
    } catch {
      /* ignore */
    }
    return createTranslator(ZH)
  }

  return { inject, apply }

  // 说明：下面这些函数只被 apply 内部的闭包引用；放在 createPlugin 里是为了让
  // build-client 生成的 bundle 完全自包含（不需要额外 require）。
  /* eslint-disable-next-line no-inner-declarations */
  function safeEffect(ctx, initializer) {
    try {
      if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
        return ctx.effect(initializer, 'dsh-folder-sessions: effect')
      }
      if (typeof initializer === 'function') return initializer()
    } catch {
      return undefined
    }
    return undefined
  }
}

/**
 * 从 ctx 上软取服务（ctx.get 可能不存在于测试替身）。
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
export function safeGet(ctx, name) {
  try {
    if (ctx !== undefined && ctx !== null && typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * 组装「新会话目录」设置行组件。
 * @param {any} React
 * @param {(type: any, props?: any, ...children: any[]) => any} h
 * @param {ReturnType<typeof createBaseDirController>} controller
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 * @returns {(props: any) => any}
 */
export function makeBaseDirRow(React, h, controller, t) {
  return function BaseDirRow(props) {
    const useBaseDirState = props?.useBaseDirState
    let snapshot = controller.store.getSnapshot()
    if (typeof useBaseDirState === 'function') {
      try {
        snapshot = useBaseDirState((state) => state)
      } catch {
        snapshot = controller.store.getSnapshot()
      }
    } else if (typeof React?.useSyncExternalStore === 'function') {
      snapshot = React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
    }
    const tr = typeof props?.t === 'function' ? props.t : t
    const loading = snapshot.status === 'loading'
    const saving = snapshot.saving === true
    const current = snapshot.baseDir !== '' ? snapshot.baseDir : snapshot.defaultBaseDir
    const isDefault = snapshot.baseDir !== '' && snapshot.defaultBaseDir !== '' && snapshot.baseDir === snapshot.defaultBaseDir
    return h('div', { className: 'dfs-row', 'data-folder-sessions-row': 'base-dir' },
      h('div', { className: 'dfs-main' },
        h('div', { className: 'dfs-title' }, tr('settings.title')),
        h('div', { className: 'dfs-description' }, tr('settings.description')),
        h('div', { className: 'dfs-path-line' },
          h('span', { className: 'dfs-path-label' }, tr('settings.current')),
          h('code', { className: 'dfs-path', title: current }, loading ? tr('settings.loading') : current),
          isDefault && h('span', { className: 'dfs-tag' }, tr('settings.defaultTag')),
        ),
        snapshot.error !== '' && h('div', { className: 'dfs-error' }, String(snapshot.error)),
        h('div', { className: 'dfs-hint' }, tr('settings.hint')),
      ),
      h('div', { className: 'dfs-actions' },
        saving && h('span', { className: 'dfs-saving' }, tr('settings.saving')),
        h('button', {
          type: 'button',
          className: 'dfs-button',
          disabled: saving,
          onClick: () => props?.choose?.(),
        }, tr('settings.choose')),
        h('button', {
          type: 'button',
          className: 'dfs-button dfs-button-ghost',
          disabled: saving || loading,
          onClick: () => props?.reset?.(),
        }, tr('settings.reset')),
      ),
    )
  }
}

/**
 * 组装 toast 浮层组件。
 * @param {any} React
 * @param {(type: any, props?: any, ...children: any[]) => any} h
 * @param {ReturnType<typeof createToaster>} toast
 * @returns {() => any}
 */
export function makeToastOverlay(React, h, toast) {
  return function FolderSessionsToast() {
    let snapshot = toast.store.getSnapshot()
    if (typeof React?.useSyncExternalStore === 'function') {
      snapshot = React.useSyncExternalStore(toast.store.subscribe, toast.store.getSnapshot)
    }
    if (snapshot.message === '') return null
    return h('div', { className: 'dfs-toast-root', style: { pointerEvents: 'none' } },
      h('div', { className: snapshot.kind === 'error' ? 'dfs-toast dfs-toast-error' : 'dfs-toast', role: 'status' }, snapshot.message),
    )
  }
}

/** 设置行/浮层用到的样式（主题变量，跟随深浅色）。 */
export const STYLE_TEXT = `
.dfs-row{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dfs-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}
.dfs-title{font-size:14px;line-height:20px}
.dfs-description{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dfs-path-line{display:flex;align-items:center;gap:8px;margin-top:2px;font-size:12px;line-height:18px;min-width:0}
.dfs-path-label{color:var(--dsw-alias-label-secondary);flex:none}
.dfs-path{font-family:var(--ds-font-family-code,monospace);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dfs-tag{flex:none;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px}
.dfs-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:2px}
.dfs-error{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dfs-actions{display:flex;align-items:center;gap:8px;flex:none;padding-top:2px}
.dfs-saving{color:var(--dsw-alias-label-secondary);font-size:12px}
.dfs-button{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:22px;padding:4px 12px}
.dfs-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dfs-button:disabled{opacity:.5;cursor:default}
.dfs-button-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dfs-toast-root{pointer-events:none;position:absolute;left:50%;bottom:32px;transform:translateX(-50%);z-index:30;display:flex;justify-content:center;max-width:min(560px,80vw)}
.dfs-toast{pointer-events:auto;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));font-size:13px;line-height:20px;padding:10px 14px;overflow-wrap:anywhere}
.dfs-toast-error{color:var(--dsw-alias-state-error-primary,#d33)}
`

/**
 * 注入样式（幂等）。
 * @param {Document | undefined} doc
 */
export function injectStyle(doc) {
  if (doc === undefined || doc === null || typeof doc.createElement !== 'function') return
  try {
    const selector = 'style[data-plugin="dsh-folder-sessions"]'
    if (typeof doc.querySelector === 'function' && doc.querySelector(selector) !== null) return
    const tag = doc.createElement('style')
    tag.setAttribute('data-plugin', 'dsh-folder-sessions')
    tag.textContent = STYLE_TEXT
    doc.head.appendChild(tag)
  } catch {
    /* ignore */
  }
}
