import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'

import { executeGrep } from '../src/tools/grep.js'

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-'))
  await writeFile(path.join(root, '.encoding-rules'), '**/*.txt gbk\n**/*.md utf8\n', 'utf8')
  await mkdir(path.join(root, 'nested'))
  await writeFile(path.join(root, 'a.txt'), iconv.encode('第一行\n错误：连接失败\n第三行', 'gbk'))
  await writeFile(path.join(root, 'nested', 'b.txt'), iconv.encode('正常\n错误：超时', 'gbk'))
  await writeFile(path.join(root, 'note.md'), 'ERROR uppercase', 'utf8')
  return root
}

describe('encoding-aware Grep', () => {
  it('searches GBK files as Unicode', async () => {
    const root = await fixture()
    const result = await executeGrep({ pattern: '错误', path: root, output_mode: 'content' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('错误：连接失败')
    expect(text).toContain('错误：超时')
  })

  it('supports files, count, glob, and case-insensitive modes', async () => {
    const root = await fixture()
    const files = await executeGrep({ pattern: '错误', path: root, glob: '**/*.txt' })
    expect((files.content[0] as { text: string }).text.split('\n')).toHaveLength(2)
    const counts = await executeGrep({ pattern: '错误', path: root, output_mode: 'count' })
    expect((counts.content[0] as { text: string }).text).toContain(':1')
    const insensitive = await executeGrep({ pattern: 'error', path: root, glob: '**/*.md', '-i': true })
    expect((insensitive.content[0] as { text: string }).text).toContain('note.md')
  })

  it('supports context, only matching, and pagination', async () => {
    const root = await fixture()
    const context = await executeGrep({ pattern: '错误', path: path.join(root, 'a.txt'), output_mode: 'content', '-C': 1 })
    expect((context.content[0] as { text: string }).text).toContain('1-第一行')
    const only = await executeGrep({ pattern: '错误', path: root, output_mode: 'content', '-o': true, head_limit: 1 })
    const text = (only.content[0] as { text: string }).text
    expect(text).toContain('错误')
    expect(text).toContain('pagination')
  })
  it('rejects explicit files over the default per-file search limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-large-'))
    await writeFile(path.join(root, '.encoding-rules'), '*.txt utf8\n', 'utf8')
    const file = path.join(root, 'large.txt')
    await writeFile(file, Buffer.alloc(32 * 1024 * 1024 + 1, 'x'))
    await expect(executeGrep({ pattern: 'x', path: file }))
      .rejects.toThrow(/exceeds the 32 MiB search limit/)
  })

  it('uses CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB for the per-file search limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-configured-'))
    await writeFile(path.join(root, '.encoding-rules'), '*.txt utf8\n', 'utf8')
    const file = path.join(root, 'configured.txt')
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 'x'))
    const previous = process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB
    process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB = '1'
    try {
      await expect(executeGrep({ pattern: 'x', path: file }))
        .rejects.toThrow(/exceeds the 1 MiB search limit/)
    } finally {
      if (previous === undefined) delete process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB
      else process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB = previous
    }
  })

  it('reports decoding failures for explicit files instead of returning zero matches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-error-'))
    await writeFile(path.join(root, '.encoding-rules'), '*.txt utf8\n', 'utf8')
    const file = path.join(root, 'broken.txt')
    await writeFile(file, Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(executeGrep({ pattern: 'anything', path: file }))
      .rejects.toThrow(/Failed to search.*Invalid byte sequence/)
  })
})
