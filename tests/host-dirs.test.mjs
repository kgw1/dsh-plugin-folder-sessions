/** 宿主半：会话目录创建 + 工作区目录改名测试。 */

import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createConfigStore } from '../host/config.js'
import {
  createWorkspaceDirs,
  formatSessionDirName,
  isDirectChildOf,
  sanitizeDirName,
  uniqueChildPath,
} from '../host/dirs.js'

/** @type {string} */
let root
/** @type {Record<string, string | undefined>} */
let env

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dfs-dirs-')))
  env = { HOME: root }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * 造一个假的 workspace registry：只用插件真正依赖到的字段。
 * @param {{ path: string, title?: string, sessionIds?: string[] }} seed
 * @param {{ withInternals?: boolean }} [options]
 */
function makeFakeRegistry(seed, options = {}) {
  const withInternals = options.withInternals !== false
  const registry = {
    sessionPaths: withInternals ? new Map() : undefined,
    invalidSessionPaths: withInternals ? new Map() : undefined,
    store: { record: null },
    /** @param {string} id */
    get(id) {
      return id === 'ws-1' ? workspace : undefined
    },
  }
  const workspace = {
    id: 'ws-1',
    setTitleCalls: [],
    get path() {
      return registry.store.record?.path ?? seed.path
    },
    get title() {
      return registry.store.record?.title ?? seed.title ?? basename(seed.path)
    },
    get sessionIds() {
      const record = registry.store.record
      const ids = record?.sessionIds ?? seed.sessionIds ?? []
      if (!withInternals) return ids
      return ids.filter((id) => registry.sessionPaths.get(id) === this.path)
    },
    async setTitle(title) {
      this.setTitleCalls.push(title)
      await this.mutate((record) => ({ ...record, title }))
    },
    async mutate(fn) {
      const current = registry.store.record ?? {
        path: seed.path,
        title: seed.title ?? basename(seed.path),
        sessionIds: seed.sessionIds ?? [],
      }
      const next = fn(current)
      const sessionIds = next.sessionIds.filter((id) => registry.sessionPaths.get(id) === next.path)
      registry.store.record = { ...next, sessionIds }
      return registry.store.record
    },
  }
  registry.store.record = {
    path: seed.path,
    title: seed.title ?? basename(seed.path),
    sessionIds: seed.sessionIds ?? [],
  }
  for (const id of seed.sessionIds ?? []) registry.sessionPaths?.set(id, seed.path)
  return registry
}

describe('formatSessionDirName / sanitizeDirName / uniqueChildPath', () => {
  it('默认目录名是本地时间戳', () => {
    const name = formatSessionDirName(new Date(2026, 9, 17, 9, 5, 3))
    assert.equal(name, '20261017-090503')
  })

  it('清洗标题里的非法字符', () => {
    assert.equal(sanitizeDirName('  hello/world  '), 'hello-world')
    assert.equal(sanitizeDirName('a:b*c?d'), 'a-b-c-d')
    assert.equal(sanitizeDirName('...hidden'), 'hidden')
    assert.equal(sanitizeDirName('名字 带 空格'), '名字 带 空格')
    assert.equal(sanitizeDirName(''), null)
    assert.equal(sanitizeDirName('///'), null)
    assert.equal(sanitizeDirName('a/b'), 'a-b')
  })

  it('uniqueChildPath 自动加后缀', async () => {
    const parent = join(root, 'parent')
    await mkdir(parent)
    assert.deepEqual(await uniqueChildPath(parent, 'x'), { path: join(parent, 'x'), name: 'x' })
    await mkdir(join(parent, 'x'))
    assert.deepEqual(await uniqueChildPath(parent, 'x'), { path: join(parent, 'x-2'), name: 'x-2' })
    await mkdir(join(parent, 'x-2'))
    assert.deepEqual(await uniqueChildPath(parent, 'x'), { path: join(parent, 'x-3'), name: 'x-3' })
  })

  it('isDirectChildOf 只认直接子目录', () => {
    assert.equal(isDirectChildOf('/a/b', '/a'), true)
    assert.equal(isDirectChildOf('/a/b/c', '/a'), false)
    assert.equal(isDirectChildOf('relative', '/a'), false)
  })
})

describe('createWorkspaceDirs.createSessionDirectory', () => {
  it('在根目录下建唯一目录（重名自动加后缀）', async () => {
    const configStore = createConfigStore({ env, log: () => {} })
    const dirs = createWorkspaceDirs({ configStore, log: () => {} })
    const fixed = new Date(2026, 0, 2, 3, 4, 5)
    const first = await dirs.createSessionDirectory({ now: fixed })
    assert.equal(first.ok, true)
    assert.equal(first.name, '20260102-030405')
    assert.equal(first.baseDir, join(root, 'dsh-sessions'))
    assert.equal((await stat(first.path)).isDirectory(), true)

    const second = await dirs.createSessionDirectory({ now: fixed })
    assert.equal(second.ok, true)
    assert.equal(second.name, '20260102-030405-2')
    assert.notEqual(second.path, first.path)
  })

  it('可以指定目录名（会清洗）', async () => {
    const configStore = createConfigStore({ env, log: () => {} })
    const dirs = createWorkspaceDirs({ configStore, log: () => {} })
    const result = await dirs.createSessionDirectory({ name: 'my/session' })
    assert.equal(result.ok, true)
    assert.equal(result.name, 'my-session')
  })

  it('自定义根目录生效', async () => {
    const configStore = createConfigStore({ env, log: () => {} })
    await configStore.setBaseDir('~/custom-root')
    const dirs = createWorkspaceDirs({ configStore, log: () => {} })
    const result = await dirs.createSessionDirectory({ name: 'one' })
    assert.equal(result.ok, true)
    assert.equal(result.path, join(root, 'custom-root', 'one'))
  })
})

describe('createWorkspaceDirs.renameWorkspaceDirectory', () => {
  /**
   * @param {{ withInternals?: boolean }} [options]
   */
  async function setup(options = {}) {
    const configStore = createConfigStore({ env, log: () => {} })
    await configStore.setBaseDir('~/sessions')
    const oldPath = join(root, 'sessions', '20260101-000000')
    await mkdir(oldPath, { recursive: true })
    await writeFile(join(oldPath, 'note.txt'), 'hi', 'utf8')
    const registry = makeFakeRegistry(
      { path: oldPath, sessionIds: ['session-1', 'session-2'] },
      options,
    )
    const dirs = createWorkspaceDirs({
      configStore,
      log: () => {},
      getRegistry: () => registry,
    })
    return { configStore, dirs, oldPath, registry }
  }

  it('托管目录：真实改名 + 旧路径软链接 + registry 路径/标题/索引同步', async () => {
    const { dirs, oldPath, registry } = await setup()
    const result = await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '我的项目' })
    assert.equal(result.ok, true)
    assert.equal(result.changed, 'directory')
    assert.equal(result.title, '我的项目')
    const newPath = join(root, 'sessions', '我的项目')
    assert.equal(result.path, newPath)

    // 新目录存在且内容搬过去了
    assert.equal((await stat(join(newPath, 'note.txt'))).isDirectory(), false)
    assert.equal(await readFile(join(newPath, 'note.txt'), 'utf8'), 'hi')

    // 旧路径变成指向新目录的软链接
    const linkInfo = await lstat(oldPath)
    assert.equal(linkInfo.isSymbolicLink(), true)
    assert.equal(await readlink(oldPath), newPath)

    // registry 记录与 sessionPath 索引同步
    assert.equal(registry.store.record.path, newPath)
    assert.equal(registry.store.record.title, '我的项目')
    assert.deepEqual(registry.store.record.sessionIds, ['session-1', 'session-2'])
    assert.equal(registry.sessionPaths.get('session-1'), newPath)
    assert.equal(registry.sessionPaths.get('session-2'), newPath)
    assert.deepEqual(registry.get('ws-1').sessionIds, ['session-1', 'session-2'])
  })

  it('再次改名：软链接保持指向最新目录', async () => {
    const { dirs, oldPath, registry } = await setup()
    assert.equal((await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '第一版' })).ok, true)
    // 此时 workspace.path 已经是新路径，旧路径是软链接
    assert.equal(registry.store.record.path, join(root, 'sessions', '第一版'))
    const second = await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '第二版' })
    assert.equal(second.ok, true)
    assert.equal(registry.store.record.path, join(root, 'sessions', '第二版'))

    // 最初的旧路径软链接仍能解析到最新目录（链式：oldPath → 第一版 → 第二版）
    assert.equal((await stat(oldPath)).isDirectory(), true)
    assert.equal(await readlink(oldPath), join(root, 'sessions', '第一版'))
  })

  it('非托管目录 → unmanaged（调用方回退只改显示名）', async () => {
    const configStore = createConfigStore({ env, log: () => {} })
    await configStore.setBaseDir('~/sessions')
    const outside = join(root, 'elsewhere', 'proj')
    await mkdir(outside, { recursive: true })
    const registry = makeFakeRegistry({ path: outside })
    const dirs = createWorkspaceDirs({ configStore, log: () => {}, getRegistry: () => registry })
    const result = await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unmanaged')
    assert.equal(registry.store.record.path, outside)
  })

  it('目标目录已存在 → conflict', async () => {
    const { dirs } = await setup()
    await mkdir(join(root, 'sessions', '占用了'), { recursive: true })
    const result = await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '占用了' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'conflict')
  })

  it('名字没变 → 只改显示名（不动磁盘）', async () => {
    const { dirs, oldPath, registry } = await setup()
    const result = await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '20260101-000000' })
    assert.equal(result.ok, true)
    assert.equal(result.changed, 'title')
    assert.equal((await lstat(oldPath)).isSymbolicLink(), false)
    assert.equal(registry.store.record.path, oldPath)
    assert.equal(registry.store.record.title, '20260101-000000')
  })

  it('宿主 registry 结构不匹配 → unsupported 且不动目录', async () => {
    const { dirs, oldPath, registry } = await setup({ withInternals: false })
    const result = await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '新名字' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unsupported')
    assert.equal(registry.store.record.path, oldPath)
    assert.equal((await stat(oldPath)).isDirectory(), true)
  })

  it('未知工作区 → not-found；空标题 → invalid', async () => {
    const { dirs } = await setup()
    assert.equal((await dirs.renameWorkspaceDirectory({ workspaceId: 'missing', title: 'x' })).code, 'not-found')
    assert.equal((await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '   ' })).code, 'invalid')
    assert.equal((await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: '///' })).code, 'invalid')
  })

  it('没有 registry 服务 → unsupported', async () => {
    const configStore = createConfigStore({ env, log: () => {} })
    const dirs = createWorkspaceDirs({ configStore, log: () => {} })
    const result = await dirs.renameWorkspaceDirectory({ workspaceId: 'ws-1', title: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unsupported')
  })
})
