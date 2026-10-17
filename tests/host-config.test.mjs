/** 宿主半：配置存储测试。 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  createConfigStore,
  expandHome,
  normalizeBaseDirInput,
  normalizeStoredConfig,
} from '../host/config.js'

/** @type {string} */
let root
/** @type {Record<string, string | undefined>} */
let env

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dfs-config-')))
  env = { HOME: root }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('expandHome / normalizeBaseDirInput', () => {
  it('展开 ~ 与 ~/xxx', () => {
    assert.equal(expandHome('~', env), root)
    assert.equal(expandHome('~/abc', env), join(root, 'abc'))
    assert.equal(expandHome('/abs/path', env), '/abs/path')
  })

  it('拒绝相对路径与空值', () => {
    assert.equal(normalizeBaseDirInput('relative/dir', env), null)
    assert.equal(normalizeBaseDirInput('', env), null)
    assert.equal(normalizeBaseDirInput(undefined, env), null)
    assert.equal(normalizeBaseDirInput('~/x', env), join(root, 'x'))
    assert.equal(normalizeBaseDirInput('/abs/x', env), '/abs/x')
  })
})

describe('normalizeStoredConfig', () => {
  it('非法字段回退默认值并补齐 knownRoots', () => {
    const normalized = normalizeStoredConfig(
      { version: 99, baseDir: 123, knownRoots: ['/a', 'relative', '/a', null] },
      { defaultBaseDir: '/default' },
    )
    assert.equal(normalized.baseDir, '/default')
    assert.deepEqual(normalized.knownRoots, ['/a', '/default'])
    assert.equal(normalized.version, 1)
  })
})

describe('createConfigStore', () => {
  it('文件缺失时使用默认根目录，不创建任何东西', async () => {
    const store = createConfigStore({ env, log: () => {} })
    const view = await store.view()
    assert.equal(view.baseDir, join(root, 'dsh-sessions'))
    assert.equal(view.defaultBaseDir, join(root, 'dsh-sessions'))
    assert.equal(view.configPath, join(root, '.dsh', 'folder-sessions.json'))
    // 默认目录此时还不存在
    await assert.rejects(readFile(view.baseDir, 'utf8'))
  })

  it('profile 行里的 baseDir 作为初始值（文件优先）', async () => {
    const seeded = createConfigStore({ env, rawConfig: { baseDir: '~/from-profile' }, log: () => {} })
    assert.equal((await seeded.view()).baseDir, join(root, 'from-profile'))

    const store = createConfigStore({ env, rawConfig: { baseDir: '~/from-profile' }, log: () => {} })
    const result = await store.setBaseDir('~/from-ui')
    assert.deepEqual(result, { ok: true, baseDir: join(root, 'from-ui') })

    const reopened = createConfigStore({ env, rawConfig: { baseDir: '~/from-profile' }, log: () => {} })
    assert.equal((await reopened.view()).baseDir, join(root, 'from-ui'))
  })

  it('setBaseDir 会创建目录、展开 ~、持久化 realpath，并累积 knownRoots', async () => {
    const store = createConfigStore({ env, log: () => {} })
    const first = await store.setBaseDir('~/sessions-a')
    assert.equal(first.ok, true)
    const second = await store.setBaseDir(join(root, 'sessions-b', 'nested'))
    assert.equal(second.ok, true)

    const persisted = JSON.parse(await readFile(store.configFile, 'utf8'))
    assert.equal(persisted.baseDir, join(root, 'sessions-b', 'nested'))
    // 默认根目录本身也是一个「受管根目录」，因此会出现在 knownRoots 里。
    assert.deepEqual(
      persisted.knownRoots,
      [join(root, 'dsh-sessions'), join(root, 'sessions-a'), join(root, 'sessions-b', 'nested')],
    )
    assert.deepEqual(await store.managedRoots(), persisted.knownRoots)
  })

  it('setBaseDir 拒绝非法输入', async () => {
    const store = createConfigStore({ env, log: () => {} })
    const result = await store.setBaseDir('relative/path')
    assert.equal(result.ok, false)
    assert.match(result.error, /绝对路径/)
    assert.equal((await store.view()).baseDir, join(root, 'dsh-sessions'))
  })

  it('ensureBaseDir 创建缺失的根目录并返回 realpath', async () => {
    const store = createConfigStore({ env, log: () => {} })
    const result = await store.ensureBaseDir()
    assert.deepEqual(result, { ok: true, baseDir: join(root, 'dsh-sessions') })
    assert.equal((await stat(join(root, 'dsh-sessions'))).isDirectory(), true)
    // 默认目录与 realpath 一致时不写盘：首次使用时目录本身即默认值。
    assert.equal((await store.managedRoots()).includes(join(root, 'dsh-sessions')), true)
  })

  it('配置文件损坏时回退默认值，不抛错', async () => {
    await mkdir(join(root, '.dsh'), { recursive: true })
    await writeFile(join(root, '.dsh', 'folder-sessions.json'), '{ not json', 'utf8')
    const store = createConfigStore({ env, log: () => {} })
    const view = await store.view()
    assert.equal(view.baseDir, join(root, 'dsh-sessions'))
  })

  it('重名 setBaseDir（同一目录）幂等', async () => {
    const store = createConfigStore({ env, log: () => {} })
    await store.setBaseDir('~/same')
    await store.setBaseDir('~/same')
    const persisted = JSON.parse(await readFile(store.configFile, 'utf8'))
    assert.equal(persisted.knownRoots.filter((p) => p === join(root, 'same')).length, 1)
  })
})
