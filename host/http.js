/**
 * HTTP 路由层：把「新会话目录 + 工作区改名」能力挂到宿主 webServer 的命名路由上。
 *
 * 路由表（客户端与测试共同契约）：
 *   GET  /folder-sessions/api/config      → { ok, baseDir, defaultBaseDir, configPath }
 *   POST /folder-sessions/api/config      { baseDir }            → { ok, baseDir }
 *   POST /folder-sessions/api/directories { name? }              → { ok, path, name, baseDir }
 *   POST /folder-sessions/api/rename      { workspaceId, title } → { ok, changed, path, oldPath, title }
 *   GET  /folder-sessions/api/health                             → 诊断信息
 *
 * 纪律：
 *  - 命名路由在宿主 auth fallback 之前被匹配（与 DSH 内置插件的命名路由做法一致），同源 fetch 不需要 token；
 *    POST 只影响本机目录与工作区名字，不暴露任意文件读写。
 *  - handler 永不挂进程：所有异常都变成 JSON 响应。
 *  - 挂载失败只降级并记日志，绝不把异常抛回 apply（profile 永远要能加载）。
 */

/** 路由前缀（与客户端约定；不随包名变化）。 */
export const API_PREFIX = '/folder-sessions/api'

/** 请求体上限（这些接口只需要一个短字符串）。 */
export const BODY_LIMIT_BYTES = 256 * 1024

/**
 * 读 JSON 请求体。
 * @param {any} req
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: string }>}
 */
export async function readJsonBody(req) {
  return await new Promise((resolvePromise) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > BODY_LIMIT_BYTES) {
        finish({ ok: false, error: '请求体过大' })
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(buffer)
    })
    req.on('error', (error) => {
      finish({ ok: false, error: `读取请求体失败：${String(error)}` })
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return finish({ ok: true, value: {} })
      try {
        finish({ ok: true, value: JSON.parse(text) })
      } catch {
        finish({ ok: false, error: '请求体不是合法 JSON' })
      }
    })
  })
}

/**
 * 写一个 JSON 响应。
 * @param {any} res
 * @param {number} status
 * @param {unknown} payload
 * @param {string} [method]
 */
export function sendJson(res, status, payload, method = 'POST') {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/**
 * 业务失败 → HTTP 状态码。
 * @param {string} code
 * @returns {number}
 */
export function statusForCode(code) {
  switch (code) {
    case 'invalid':
      return 400
    case 'not-found':
      return 404
    case 'unmanaged':
    case 'conflict':
      return 409
    case 'unsupported':
      return 501
    default:
      return 500
  }
}

/**
 * 建路由器。
 *
 * @param {object} options
 * @param {ReturnType<import('./config.js').createConfigStore>} options.configStore
 * @param {ReturnType<import('./dirs.js').createWorkspaceDirs>} options.dirs
 * @param {() => unknown} [options.getWorkspaceRegistry]
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.version]
 * @returns {{ handle: (req: any, res: any) => Promise<void>, routes: ReadonlyArray<{kind: string, path: string}> }}
 */
export function createRouter(options) {
  const { configStore, dirs } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getWorkspaceRegistry = typeof options.getWorkspaceRegistry === 'function'
    ? options.getWorkspaceRegistry
    : () => undefined
  const version = typeof options.version === 'string' ? options.version : '0.0.0'

  /** @param {any} req */
  async function handleConfigGet(req, res, method) {
    const view = await configStore.view()
    sendJson(res, 200, { ok: true, ...view }, method)
  }

  /** @param {any} req */
  async function handleConfigPost(req, res, method) {
    const body = await readJsonBody(req)
    if (!body.ok) return sendJson(res, 400, { ok: false, code: 'invalid', error: body.error }, method)
    const value = body.value !== null && typeof body.value === 'object' ? body.value : {}
    const result = await configStore.setBaseDir(value.baseDir)
    if (!result.ok) return sendJson(res, 400, { ok: false, code: 'invalid', error: result.error }, method)
    const view = await configStore.view()
    sendJson(res, 200, { ok: true, ...view }, method)
  }

  /** @param {any} req */
  async function handleDirectoriesPost(req, res, method) {
    const body = await readJsonBody(req)
    if (!body.ok) return sendJson(res, 400, { ok: false, code: 'invalid', error: body.error }, method)
    const value = body.value !== null && typeof body.value === 'object' ? body.value : {}
    const result = await dirs.createSessionDirectory({ name: value.name })
    if (!result.ok) return sendJson(res, statusForCode(result.code), result, method)
    sendJson(res, 200, result, method)
  }

  /** @param {any} req */
  async function handleRenamePost(req, res, method) {
    const body = await readJsonBody(req)
    if (!body.ok) return sendJson(res, 400, { ok: false, code: 'invalid', error: body.error }, method)
    const value = body.value !== null && typeof body.value === 'object' ? body.value : {}
    const result = await dirs.renameWorkspaceDirectory({
      workspaceId: value.workspaceId,
      title: value.title,
    })
    if (!result.ok) return sendJson(res, statusForCode(result.code), result, method)
    sendJson(res, 200, result, method)
  }

  /** @param {any} req */
  async function handleHealthGet(req, res, method) {
    /** @type {string[]} */
    const notes = []
    let config
    try {
      config = await configStore.view()
    } catch (error) {
      notes.push(`config 读取失败：${String(error)}`)
      config = { baseDir: '', defaultBaseDir: '', configPath: '' }
    }
    const registry = getWorkspaceRegistry()
    let registryOk = false
    if (registry !== undefined && registry !== null && typeof registry.get === 'function') {
      try {
        registryOk = registry.get('__health-probe__') === undefined
      } catch {
        registryOk = false
      }
    } else {
      notes.push('workspaceRegistry 不可用')
    }
    let roots = []
    try {
      roots = await configStore.managedRoots()
    } catch (error) {
      notes.push(`managedRoots 读取失败：${String(error)}`)
    }
    sendJson(res, 200, {
      ok: true,
      plugin: 'dsh-folder-sessions',
      version,
      routes: ROUTE_TABLE.map((route) => `${route.kind} ${route.path}`),
      baseDir: config.baseDir,
      defaultBaseDir: config.defaultBaseDir,
      configPath: config.configPath,
      managedRoots: roots,
      workspaceRegistry: registryOk ? 'ok' : 'unavailable',
      notes,
    }, method)
  }

  /** 冻结的路由表：path → handler。 */
  const ROUTE_TABLE = /** @type {const} */ ([
    { kind: 'exact', path: `${API_PREFIX}/config`, methods: { GET: handleConfigGet, POST: handleConfigPost } },
    { kind: 'exact', path: `${API_PREFIX}/directories`, methods: { POST: handleDirectoriesPost } },
    { kind: 'exact', path: `${API_PREFIX}/rename`, methods: { POST: handleRenamePost } },
    { kind: 'exact', path: `${API_PREFIX}/health`, methods: { GET: handleHealthGet } },
  ])

  const byPath = new Map(ROUTE_TABLE.map((route) => [route.path, route]))

  /**
   * 处理一个请求；永不抛错。
   * @param {any} req
   * @param {any} res
   */
  async function handle(req, res) {
    const method = String(req?.method ?? 'GET').toUpperCase()
    let pathname
    try {
      pathname = new URL(req?.url ?? '/', 'http://dsh.invalid').pathname
    } catch {
      sendJson(res, 400, { ok: false, code: 'invalid', error: '无法解析请求 URL' }, method)
      return
    }
    const route = byPath.get(pathname)
    if (route === undefined) {
      sendJson(res, 404, { ok: false, code: 'invalid', error: '未知端点', path: pathname }, method)
      return
    }
    const handler = route.methods[method] ?? route.methods[method === 'HEAD' ? 'GET' : undefined]
    if (handler === undefined) {
      sendJson(res, 405, { ok: false, code: 'invalid', error: `不支持 ${method}` }, method)
      return
    }
    try {
      await handler(req, res, method)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[folder-sessions] 端点 ${pathname} 内部错误：${message}`)
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', error: message }, method)
      } catch {
        /* response already gone */
      }
    }
  }

  return {
    handle,
    routes: ROUTE_TABLE.map(({ kind, path }) => ({ kind, path })),
  }
}

/**
 * 把路由挂到宿主 webServer 上（尽力而为：失败只记日志）。
 *
 * @param {object} options
 * @param {any} options.webServer - 宿主 webServer 服务。
 * @param {ReturnType<typeof createRouter>} options.router
 * @param {(message: string) => void} [options.log]
 * @returns {{ mounted: boolean, errors: string[], dispose: () => void }}
 */
export function mountRouter(options) {
  const webServer = options.webServer
  const router = options.router
  const log = typeof options.log === 'function' ? options.log : () => {}
  /** @type {Array<() => void>} */
  const disposers = []
  /** @type {string[]} */
  const errors = []
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    errors.push('webServer 不可用（没有 register 方法）')
    return { mounted: false, errors, dispose: () => {} }
  }
  try {
    for (const route of router.routes) {
      const disposer = webServer.register({
        kind: route.kind,
        path: route.path,
        handler: (req, res) => router.handle(req, res),
      })
      if (typeof disposer === 'function') disposers.push(disposer)
    }
    log(`[folder-sessions] 已挂载 ${router.routes.map((route) => route.path).join(' / ')}`)
    return {
      mounted: true,
      errors,
      dispose: () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
        disposers.length = 0
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`route mount failed: ${message}`)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    disposers.length = 0
    return { mounted: false, errors, dispose: () => {} }
  }
}
