/** 客户端半：行为与 bundle 契约测试。 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  API_PREFIX,
  ApiError,
  createBaseDirController,
  createPlugin,
  isNewSessionButtonCall,
  isNewSessionShortcutCall,
  shouldFallback,
} from '../src/client/index.js'

/** 极简 React 替身（测试只验证 apply/逻辑，不渲染组件）。 */
const fakeReact = {
  createElement: () => null,
  useSyncExternalStore: undefined,
}

/**
 * 建一个假的客户端 ctx（只包含插件真正访问的服务）。
 * @param {object} services
 */
function makeCtx(services) {
  const registered = []
  const injected = []
  const slots = {
    registered,
    injected,
    inject(name, factory) {
      injected.push(name)
      try {
        factory()
      } catch {
        /* ignore */
      }
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  }
  const locale = {
    register: () => () => {},
    bind: () => (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`),
    subscribe: () => () => {},
  }
  return {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return locale
      return services[name]
    },
    effect(fn) {
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    slots,
    locale,
    logger: { info: () => {}, warn: () => {} },
  }
}

/**
 * 造一个可控的 fetch 替身。
 * @param {Record<string, { status?: number, body?: any, throws?: boolean }>} handlers
 */
function makeFetch(handlers) {
  /** @type {Array<{ method: string, path: string, init: any }>} */
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ method, path: parsed.pathname, init })
    const handler = handlers[`${method} ${parsed.pathname}`]
    if (handler === undefined) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, error: 'not mounted' }) }
    }
    if (handler.throws === true) throw new Error('network down')
    const text = JSON.stringify(handler.body ?? { ok: true })
    return { ok: (handler.status ?? 200) < 400, status: handler.status ?? 200, text: async () => text }
  }
  return { fetchImpl, calls }
}

/**
 * 造客户端服务替身（uiWorkspace / workspaces）。
 */
function makeServices() {
  /** @type {Array<any[]>} */
  const originalStartCalls = []
  /** @type {string[]} */
  const opened = []
  /** @type {Array<{ path: string }>} */
  const created = []
  /** @type {Array<[string, string]>} */
  const originalRenameCalls = []
  const uiWorkspace = {
    startSession(...args) {
      originalStartCalls.push(args)
    },
    async openWorkspace(workspaceId) {
      opened.push(workspaceId)
    },
    async pickDirectory() {
      return '/picked/dir'
    },
  }
  const workspaces = {
    async create(input) {
      created.push(input)
      return { workspaceId: 'ws-new', path: input.path, title: 'new' }
    },
    async rename(workspaceId, title) {
      originalRenameCalls.push([workspaceId, title])
      return { workspaceId, title }
    },
  }
  return { uiWorkspace, workspaces, originalStartCalls, opened, created, originalRenameCalls }
}

/**
 * 轮询等待条件成立（异步流程用）。
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * 装配一个已 apply 的插件实例。
 * @param {object} options
 */
function setup(options = {}) {
  const services = makeServices()
  const fetchState = makeFetch(options.handlers ?? {})
  const plugin = createPlugin({
    React: fakeReact,
    env: {
      fetch: fetchState.fetchImpl,
      baseURI: () => 'http://127.0.0.1:19387/',
      setTimer: () => 0,
      clearTimer: () => {},
    },
  })
  const ctx = makeCtx(services)
  plugin.apply(ctx)
  // apply 会预热读取一次 config（GET config），不计入业务流程断言。
  fetchState.calls.length = 0
  return { plugin, ctx, services, fetchState }
}

/** 侧边栏/顶部按钮：injectProps 显式传一个 undefined 实参。 */
function clickNewSessionButton(services) {
  services.uiWorkspace.startSession(undefined)
}

describe('isNewSessionButtonCall', () => {
  it('侧边栏/顶部按钮：1 个 undefined 实参', () => {
    assert.equal(isNewSessionButtonCall({ length: 1, 0: undefined }), true)
    assert.equal(isNewSessionButtonCall([undefined]), true)
  })

  it('「+」气泡 / 0 实参调用：不按按钮处理', () => {
    assert.equal(isNewSessionButtonCall(['ws-1']), false)
    assert.equal(isNewSessionButtonCall([]), false)
    assert.equal(isNewSessionButtonCall({ length: 0 }), false)
    assert.equal(isNewSessionButtonCall(undefined), false)
  })

  it('Cmd+N：只有原始实例上的 0 实参调用才算', () => {
    const raw = { name: 'raw' }
    assert.equal(isNewSessionShortcutCall(raw, raw, []), true)
    assert.equal(isNewSessionShortcutCall({ shadow: true }, raw, []), false)
    assert.equal(isNewSessionShortcutCall(raw, raw, [undefined]), false)
    assert.equal(isNewSessionShortcutCall(raw, raw, undefined), false)
  })
})

describe('shouldFallback', () => {
  it('传输失败 / unmanaged / unsupported 回退', () => {
    assert.equal(shouldFallback(new ApiError('x', { transport: true })), true)
    assert.equal(shouldFallback(new ApiError('x', { code: 'unmanaged', status: 409 })), true)
    assert.equal(shouldFallback(new ApiError('x', { code: 'unsupported', status: 501 })), true)
    assert.equal(shouldFallback(new ApiError('x', { code: 'conflict', status: 409 })), false)
  })
})

describe('startSession patch', () => {
  it('侧边栏「新会话」→ 建目录 → 注册工作区 → 打开新会话', async () => {
    const { services, fetchState } = setup({
      handlers: {
        [`POST /${API_PREFIX}/directories`]: {
          body: {
            ok: true,
            path: '/Users/me/dsh-sessions/20260101-000000',
            name: '20260101-000000',
            baseDir: '/Users/me/dsh-sessions',
          },
        },
      },
    })
    clickNewSessionButton(services)
    await waitFor(() => services.opened.length === 1)

    assert.equal(fetchState.calls.length, 1)
    assert.equal(fetchState.calls[0].method, 'POST')
    assert.equal(fetchState.calls[0].path, `/${API_PREFIX}/directories`)
    assert.deepEqual(services.created, [{ path: '/Users/me/dsh-sessions/20260101-000000' }])
    assert.deepEqual(services.opened, ['ws-new'])
    assert.deepEqual(services.originalStartCalls, [])
  })

  it('侧边栏按钮（显式 undefined）走新目录流程', async () => {
    const { services } = setup({
      handlers: {
        [`POST /${API_PREFIX}/directories`]: { body: { ok: true, path: '/base/x', name: 'x', baseDir: '/base' } },
      },
    })
    clickNewSessionButton(services)
    await waitFor(() => services.opened.length === 1)
    assert.deepEqual(services.opened, ['ws-new'])
  })

  it('工作区行右侧「+」带 workspaceId → 原样放行', () => {
    const { services, fetchState } = setup()
    services.uiWorkspace.startSession('ws-existing')
    assert.deepEqual(services.originalStartCalls, [['ws-existing']])
    assert.equal(fetchState.calls.length, 0)
    assert.equal(services.opened.length, 0)
  })

  it('Cmd+N（原始实例上的 0 实参）→ 也走新目录流程', async () => {
    const { services } = setup({
      handlers: {
        [`POST /${API_PREFIX}/directories`]: { body: { ok: true, path: '/base/shortcut', name: 'shortcut', baseDir: '/base' } },
      },
    })
    services.uiWorkspace.startSession()
    await waitFor(() => services.opened.length === 1)
    assert.deepEqual(services.opened, ['ws-new'])
  })

  it('计划任务 / 预设草稿（经 ctx 代理、0 实参）→ 原样放行', () => {
    const { services, fetchState } = setup()
    // cordis 服务代理调用时 this 是 shadow context，不是原始实例。
    services.uiWorkspace.startSession.apply({ shadow: true }, [])
    assert.deepEqual(services.originalStartCalls, [[]])
    assert.equal(fetchState.calls.length, 0)
  })

  it('宿主服务未挂载（404）→ 回退原行为', async () => {
    const { services } = setup({ handlers: {} })
    clickNewSessionButton(services)
    await waitFor(() => services.originalStartCalls.length === 1)
    assert.deepEqual(services.originalStartCalls, [[undefined]])
    assert.equal(services.opened.length, 0)
  })

  it('建目录业务失败 → 不回退、不打开新会话', async () => {
    const { services } = setup({
      handlers: {
        [`POST /${API_PREFIX}/directories`]: { status: 500, body: { ok: false, code: 'create', error: '磁盘满了' } },
      },
    })
    clickNewSessionButton(services)
    await waitFor(() => true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(services.originalStartCalls, [])
    assert.equal(services.opened.length, 0)
    assert.equal(services.created.length, 0)
  })
})

describe('workspaces.rename patch', () => {
  it('托管工作区：走目录改名接口，不再调用原生 rename', async () => {
    const { services, fetchState } = setup({
      handlers: {
        [`POST /${API_PREFIX}/rename`]: {
          body: {
            ok: true,
            changed: 'directory',
            path: '/base/新名字',
            oldPath: '/base/20260101-000000',
            title: '新名字',
          },
        },
      },
    })
    await services.workspaces.rename('ws-1', '新名字')
    assert.equal(fetchState.calls.length, 1)
    assert.equal(fetchState.calls[0].method, 'POST')
    assert.equal(fetchState.calls[0].path, `/${API_PREFIX}/rename`)
    assert.equal(JSON.parse(fetchState.calls[0].init.body).title, '新名字')
    assert.deepEqual(services.originalRenameCalls, [])
  })

  it('非托管目录（409 unmanaged）→ 回退原生 rename', async () => {
    const { services } = setup({
      handlers: {
        [`POST /${API_PREFIX}/rename`]: { status: 409, body: { ok: false, code: 'unmanaged', error: '不是托管目录' } },
      },
    })
    await services.workspaces.rename('ws-1', '新名字')
    assert.deepEqual(services.originalRenameCalls, [['ws-1', '新名字']])
  })

  it('接口未挂载 → 回退原生 rename', async () => {
    const { services } = setup({ handlers: {} })
    await services.workspaces.rename('ws-1', '新名字')
    assert.deepEqual(services.originalRenameCalls, [['ws-1', '新名字']])
  })

  it('业务冲突（目录已存在）→ 抛错给重命名对话框', async () => {
    const { services } = setup({
      handlers: {
        [`POST /${API_PREFIX}/rename`]: { status: 409, body: { ok: false, code: 'conflict', error: '目录已存在：新名字' } },
      },
    })
    await assert.rejects(services.workspaces.rename('ws-1', '新名字'), /目录已存在/)
    assert.deepEqual(services.originalRenameCalls, [])
  })
})

describe('slot registrations', () => {
  it('注册设置行 + toast 浮层', () => {
    const { ctx } = setup()
    assert.deepEqual(ctx.slots.injected.sort(), ['settings.general.item', 'shell.overlay'].sort())
    const names = ctx.slots.registered.map((entry) => entry.options.name)
    assert.equal(names.includes('settings.general.item'), true)
    assert.equal(names.includes('shell.overlay'), true)
    const row = ctx.slots.registered.find((entry) => entry.options.name === 'settings.general.item')
    assert.equal(row.options.id, 'folder-sessions.base-dir')
    assert.equal(typeof row.component, 'function')
    const injected = row.options.inject()
    assert.equal(typeof injected.choose, 'function')
    assert.equal(typeof injected.reset, 'function')
    assert.equal(typeof injected.hooks.baseDirState.getSnapshot, 'function')
    assert.equal(typeof injected.hooks.baseDirState.subscribe, 'function')
  })
})

describe('createBaseDirController', () => {
  /**
   * @param {Record<string, any>} handlers
   * @param {(() => Promise<string | null>)} [pickDirectory]
   */
  function makeController(handlers, pickDirectory = async () => '/picked') {
    const { fetchImpl } = makeFetch(handlers)
    // 用真实 createApi 的调用面（同源 fetch 语义）。
    const realApi = {
      getConfig: async () => requestJson(fetchImpl, 'GET', `/${API_PREFIX}/config`),
      setConfig: async (baseDir) => requestJson(fetchImpl, 'POST', `/${API_PREFIX}/config`, { baseDir }),
    }
    const toasts = []
    const controller = createBaseDirController({
      api: realApi,
      pickDirectory,
      toast: { show: (message, kind) => toasts.push({ message, kind }) },
      t: (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`),
    })
    return { controller, toasts }
  }

  /**
   * @param {ReturnType<typeof makeFetch>['fetchImpl']} fetchImpl
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function requestJson(fetchImpl, method, path, body) {
    const response = await fetchImpl(`http://127.0.0.1:19387${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const payload = JSON.parse(text)
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
    return payload
  }

  it('load 后进入 ready，choose 会保存新目录', async () => {
    const { controller } = makeController({
      [`GET /${API_PREFIX}/config`]: {
        body: { ok: true, baseDir: '/old', defaultBaseDir: '/default', configPath: '/cfg.json' },
      },
      [`POST /${API_PREFIX}/config`]: {
        body: { ok: true, baseDir: '/picked', defaultBaseDir: '/default', configPath: '/cfg.json' },
      },
    })
    await controller.load()
    assert.equal(controller.store.getSnapshot().status, 'ready')
    assert.equal(controller.store.getSnapshot().baseDir, '/old')
    await controller.choose()
    assert.equal(controller.store.getSnapshot().baseDir, '/picked')
  })

  it('load 失败进入 error，不抛', async () => {
    const { controller } = makeController({})
    await controller.load()
    assert.equal(controller.store.getSnapshot().status, 'error')
    assert.match(controller.store.getSnapshot().error, /404|挂载|not mounted/)
  })

  it('setBaseDir 失败会记录错误并 toast', async () => {
    const { controller, toasts } = makeController({
      [`POST /${API_PREFIX}/config`]: { status: 400, body: { ok: false, code: 'invalid', error: '请输入绝对路径' } },
    })
    await controller.setBaseDir('relative')
    const snapshot = controller.store.getSnapshot()
    assert.equal(snapshot.saving, false)
    assert.match(snapshot.error, /绝对路径/)
    assert.equal(toasts.length > 0, true)
  })
})

/** 从 package.json 读取插件 id（bundle 的模块表键）。 */
const MANIFEST = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const PLUGIN_ID = MANIFEST.name

describe('client bundle contract', () => {
  it('client.js 能被 __ModuleLoader__ 加载并返回 { inject, apply }', async () => {
    const code = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
    let handoff
    const fakeWindow = {
      __ModuleLoader__: {
        load(value) {
          handoff = value
        },
      },
    }
    // eslint-disable-next-line no-new-func
    const run = new Function('window', 'require', code)
    run(fakeWindow, (name) => {
      if (name === 'react') return fakeReact
      throw new Error(`unexpected require(${JSON.stringify(name)})`)
    })
    assert.ok(handoff !== undefined)
    assert.equal(handoff.id, PLUGIN_ID)
    const module = handoff.factory((name) => {
      if (name === 'react') return fakeReact
      throw new Error(`unexpected require(${JSON.stringify(name)})`)
    })
    assert.equal(typeof module.apply, 'function')
    assert.deepEqual(module.inject, ['slots', 'locale', 'uiWorkspace', 'workspaces'])
  })

  it('package.json 的 name 与 bundle id 一致（浏览器模块表按 name 键控）', () => {
    assert.equal(MANIFEST.name, PLUGIN_ID)
    assert.equal(MANIFEST.name, 'dsh-plugin-folder-sessions')
    assert.equal(MANIFEST.dsh.client.platform, 'web')
    assert.equal(MANIFEST.exports['./client'], './client.js')
    assert.equal(MANIFEST.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(MANIFEST.peerDependencies['@deepseek-ai/dsh'], '>=0.2.0-rc.2 <0.3.0')
  })
})
