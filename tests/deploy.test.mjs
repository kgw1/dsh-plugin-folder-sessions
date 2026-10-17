/** 部署助手：profile patch 写入的幂等性测试。 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ENTRY_ID, parseArgs, upsertPatchEntry } from '../scripts/deploy.mjs'

describe('parseArgs', () => {
  it('默认值', () => {
    const args = parseArgs([])
    assert.equal(args.profile, 'desktop')
    assert.equal(args.dryRun, false)
    assert.equal(args.noPatch, false)
    assert.match(args.target, /dsh-folder-sessions$/)
  })

  it('覆盖 target/profile 与开关', () => {
    const args = parseArgs(['--dry-run', '--no-patch', '--target', '/tmp/x', '--profile', 'web'])
    assert.equal(args.dryRun, true)
    assert.equal(args.noPatch, true)
    assert.equal(args.target, '/tmp/x')
    assert.equal(args.profile, 'web')
  })
})

describe('upsertPatchEntry', () => {
  it('向已有 patch 末尾追加 insert 块', () => {
    const source = `# patch\n- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n`
    const { text, changed } = upsertPatchEntry(source, {
      entryId: ENTRY_ID,
      entryPath: '/Users/me/dsh-folder-sessions/index.js',
    })
    assert.equal(changed, true)
    assert.match(text, /^# patch/m)
    assert.match(text, /- insert:\n {4}- id: folder-sessions\n {6}name: '\/Users\/me\/dsh-folder-sessions\/index\.js'\n$/)
    // 原有内容保持不动
    assert.equal(text.startsWith(source.replace(/\s*$/, '')), true)
    assert.equal(text.includes('\n\n- insert:'), true)
  })

  it('重复部署是幂等的（不重复追加）', () => {
    const source = `- insert:\n    - id: folder-sessions\n      name: '/old/path/index.js'\n`
    const { text, changed } = upsertPatchEntry(source, {
      entryId: ENTRY_ID,
      entryPath: '/new/path/index.js',
    })
    assert.equal(changed, false)
    assert.equal(text, source)
  })

  it('空 patch 也能写', () => {
    const { text, changed } = upsertPatchEntry('', {
      entryId: ENTRY_ID,
      entryPath: '/x/index.js',
    })
    assert.equal(changed, true)
    assert.match(text, /^- insert:/)
  })
})
