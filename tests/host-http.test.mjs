/** 宿主半：HTTP 路由 + 插件入口测试。 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createConfigStore } from '../host/config.js'
import { createWorkspaceDirs } from '../host/dirs.js'
import { API_PREFIX, createRouter } from '../host/http.js'
import { apply as pluginApply, inject as pluginInject, name as pluginName } from '../index.js'

/** @type {string} */
let root
/** @type {Record<string, string | undefined>} */
let env
/** @type {http.Server[]} */
let servers = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dfs-http-')))
  env = { HOME: root }
})

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  servers = []
  await rm(root, { recursive: true, force: true })
})

/**
 * 起一个只由 router.handle 驱动的 HTTP server。
 * @param {ReturnType<typeof createRouter>} router
 * @returns {Promise<string>} base url
 */
async function listen(router) {
  const server = http.createServer((req, res) => {
    void router.handle(req, res)
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

/**
 * 造一个假 registry。
 * @param {{ path: string, title?: string, sessionIds?: string[], internals?: boolean, getMissingProbe?: boolean }} seed
 */
function fakeRegistry(seed) {
  const internals = seed.internals !== false
  const registry = {
    sessionPaths: internals ? new Map() : undefined,
    invalidSessionPaths: internals ? new Map() : undefined,
    record: { path: seed.path, title: seed.title ?? 'ws', sessionIds: seed.sessionIds ?? [] },
    get(id) {
      if (id === '__health-probe__') return undefined
      return id === 'ws-1' ? workspace : undefined
    },
  }
  const workspace = {
    id: 'ws-1',
    get path() {
      return registry.record.path
    },
    get sessionIds() {
      return registry.record.sessionIds.filter((id) => registry.sessionPaths?.get(id) === registry.record.path)
    },
    async setTitle(title) {
      await this.mutate((record) => ({ ...record, title }))
    },
    async mutate(fn) {
      const next = fn(registry.record)
      registry.record = {
        ...next,
        sessionIds: next.sessionIds.filter((id) => registry.sessionPaths?.get(id) === next.path),
      }
      return registry.record
    },
  }
  for (const id of seed.sessionIds ?? []) registry.sessionPaths?.set(id, seed.path)
  return registry
}

/**
 * @param {{ registry?: any }} [options]
 */
function makeRouter(options = {}) {
  const configStore = createConfigStore({ env, log: () => {} })
  const dirs = createWorkspaceDirs({ configStore, log: () => {}, getRegistry: () => options.registry })
  return {
    configStore,
    dirs,
    router: createRouter({
      configStore,
      dirs,
      getWorkspaceRegistry: () => options.registry,
      log: () => {},
      version: 'test',
    }),
  }
}

describe('host HTTP routes', () => {
  it('GET config 返回默认值', async () => {
    const { router } = makeRouter()
    const base = await listen(router)
    const response = await fetch(`${base}${API_PREFIX}/config`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.baseDir, join(root, 'dsh-sessions'))
    assert.equal(body.defaultBaseDir, join(root, 'dsh-sessions'))
  })

  it('POST config 保存并创建目录', async () => {
    const { router } = makeRouter()
    const base = await listen(router)
    const target = join(root, 'custom-root')
    const response = await fetch(`${base}${API_PREFIX}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseDir: target }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.baseDir, target)

    const again = await (await fetch(`${base}${API_PREFIX}/config`)).json()
    assert.equal(again.baseDir, target)
  })

  it('POST config 非法输入 → 400', async () => {
    const { router } = makeRouter()
    const base = await listen(router)
    const response = await fetch(`${base}${API_PREFIX}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseDir: 'relative' }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.ok, false)
  })

  it('POST directories 建出目录并返回名字', async () => {
    const { router } = makeRouter()
    const base = await listen(router)
    const response = await fetch(`${base}${API_PREFIX}/directories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.match(body.name, /^\d{8}-\d{6}$/)
    assert.equal(body.path, join(root, 'dsh-sessions', body.name))
  })

  it('POST rename 托管目录 → 200 且目录改名', async () => {
    const configStore = createConfigStore({ env, log: () => {} })
    await configStore.setBaseDir('~/sessions')
    const oldPath = join(root, 'sessions', '20260101-000000')
    await mkdir(oldPath, { recursive: true })
    const registry = fakeRegistry({ path: oldPath, sessionIds: ['session-1'], internals: true })
    const dirs = createWorkspaceDirs({ configStore, log: () => {}, getRegistry: () => registry })
    const router = createRouter({
      configStore,
      dirs,
      getWorkspaceRegistry: () => registry,
      log: () => {},
      version: 'test',
    })
    const base = await listen(router)
    const response = await fetch(`${base}${API_PREFIX}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', title: '新项目' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.changed, 'directory')
    assert.equal(body.path, join(root, 'sessions', '新项目'))
  })

  it('POST rename 非托管目录 → 409 unmanaged', async () => {
    const configStore = createConfigStore({ env, log: () => {} })
    await configStore.setBaseDir('~/sessions')
    const outside = join(root, 'elsewhere')
    await mkdir(outside, { recursive: true })
    const registry = fakeRegistry({ path: outside })
    const dirs = createWorkspaceDirs({ configStore, log: () => {}, getRegistry: () => registry })
    const router = createRouter({
      configStore,
      dirs,
      getWorkspaceRegistry: () => registry,
      log: () => {},
      version: 'test',
    })
    const base = await listen(router)
    const response = await fetch(`${base}${API_PREFIX}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', title: '新名字' }),
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, 'unmanaged')
  })

  it('未知路径 404、方法不支持 405、坏 JSON 400', async () => {
    const { router } = makeRouter()
    const base = await listen(router)
    assert.equal((await fetch(`${base}${API_PREFIX}/nope`)).status, 404)
    assert.equal((await fetch(`${base}${API_PREFIX}/directories`)).status, 405)
    const bad = await fetch(`${base}${API_PREFIX}/directories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    assert.equal(bad.status, 400)
  })

  it('health 端点带诊断信息', async () => {
    const registry = fakeRegistry({ path: join(root, 'x') })
    const { router } = makeRouter({ registry })
    const base = await listen(router)
    const body = await (await fetch(`${base}${API_PREFIX}/health`)).json()
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-folder-sessions')
    assert.equal(body.workspaceRegistry, 'ok')
    assert.equal(body.routes.length, 4)
  })

  it('health 在没有 registry 时降级但仍 200', async () => {
    const { router } = makeRouter()
    const base = await listen(router)
    const response = await fetch(`${base}${API_PREFIX}/health`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.workspaceRegistry, 'unavailable')
    assert.equal(body.notes.length > 0, true)
  })
})

describe('plugin host entry', () => {
  it('具名导出符合 loader 契约', () => {
    assert.equal(pluginName, 'folder-sessions')
    assert.deepEqual(pluginInject, ['webServer'])
    assert.equal(typeof pluginApply, 'function')
  })

  it('apply 会挂载 4 条路由（幂等清理）', () => {
    const registered = []
    const disposed = []
    const ctx = {
      logger: { info: () => {} },
      get(name) {
        if (name === 'webServer') {
          return {
            register(route) {
              registered.push(route)
              return () => disposed.push(route.path)
            },
          }
        }
        return undefined
      },
      effect(fn) {
        const cleanup = fn()
        return () => {
          if (typeof cleanup === 'function') cleanup()
        }
      },
    }
    pluginApply(ctx, {})
    assert.deepEqual(
      registered.map((route) => route.path).sort(),
      [
        `${API_PREFIX}/config`,
        `${API_PREFIX}/directories`,
        `${API_PREFIX}/health`,
        `${API_PREFIX}/rename`,
      ].sort(),
    )
    assert.equal(registered.every((route) => route.kind === 'exact'), true)
  })

  it('apply 在没有 webServer 时不抛错', () => {
    const ctx = {
      logger: { info: () => {} },
      get: () => undefined,
      effect: (fn) => {
        fn()
      },
    }
    assert.doesNotThrow(() => pluginApply(ctx, {}))
  })

  it('apply 在 ctx 极简（无 logger/effect）时不抛错', () => {
    assert.doesNotThrow(() => pluginApply({}, undefined))
    assert.doesNotThrow(() => pluginApply({ get: () => undefined }, {}))
  })
})
