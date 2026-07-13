import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import iconv from 'iconv-lite'
import { beforeEach, describe, expect, it } from 'vitest'

import { fileStateCache } from '../src/filesystem/index.js'
import { readRegistry } from '../src/core.js'
import { executeEdit } from '../src/tools/edit.js'
import { executeRead } from '../src/tools/read.js'
import { executeWrite } from '../src/tools/write.js'

async function project(rules = '**/*.txt gbk\n**/*.ipynb gbk\n'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'encoding-mcp-tools-'))
  await writeFile(path.join(root, '.encoding-rules'), rules, 'utf8')
  return root
}

beforeEach(() => {
  fileStateCache.clear()
})

describe('encoding-transparent text tools', () => {
  it('reads GBK as Unicode and edits back to GBK bytes', async () => {
    const root = await project()
    const file = path.join(root, 'hello.txt')
    await writeFile(file, iconv.encode('你好，世界\r\n第二行\r\n', 'gbk'))

    const read = await executeRead({ file_path: file })
    expect(read.content[0]).toMatchObject({ type: 'text' })
    expect((read.content[0] as { text: string }).text).toContain('你好，世界')

    await executeEdit({ file_path: file, old_string: '世界', new_string: '朋友' })
    const bytes = await readFile(file)
    expect(iconv.decode(bytes, 'gbk')).toBe('你好，朋友\r\n第二行\r\n')
    expect(bytes.equals(Buffer.from('你好，朋友\r\n第二行\r\n', 'utf8'))).toBe(false)
  })

  it('writes an existing GBK file back in GBK', async () => {
    const root = await project()
    const file = path.join(root, 'rewrite.txt')
    await writeFile(file, iconv.encode('原内容', 'gbk'))
    await executeRead({ file_path: file })
    await executeWrite({ file_path: file, content: '完整重写' })
    expect(iconv.decode(await readFile(file), 'gbk')).toBe('完整重写')
  })

  it('creates new matched files in the configured encoding', async () => {
    const root = await project()
    const file = path.join(root, 'new.txt')
    await executeWrite({ file_path: file, content: '新文件' })
    expect(iconv.decode(await readFile(file), 'gbk')).toBe('新文件')
  })

  it('rejects edits after a partial read', async () => {
    const root = await project()
    const file = path.join(root, 'partial.txt')
    await writeFile(file, iconv.encode('第一行\n第二行\n第三行', 'gbk'))
    await executeRead({ file_path: file, offset: 2, limit: 1 })
    await expect(executeEdit({ file_path: file, old_string: '第二行', new_string: '修改' }))
      .rejects.toThrow(/has not been read/)
  })

  it('rejects stale writes after an external modification', async () => {
    const root = await project()
    const file = path.join(root, 'stale.txt')
    await writeFile(file, iconv.encode('初始', 'gbk'))
    await executeRead({ file_path: file })
    await writeFile(file, iconv.encode('外部修改', 'gbk'))
    fileStateCache.clear()
    await expect(executeWrite({ file_path: file, content: '覆盖' }))
      .rejects.toThrow(/unexpectedly modified/)
  })

  it('rejects Notebook ranges and Notebook editing', async () => {
    const root = await project()
    const file = path.join(root, 'BOOK.IPYNB')
    await writeFile(file, iconv.encode(JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }), 'gbk'))
    await expect(executeRead({ file_path: file, offset: 1, limit: 1 }))
      .rejects.toThrow(/not supported for Jupyter notebooks/)
    await executeRead({ file_path: file })
    await expect(executeEdit({ file_path: file, old_string: 'cells', new_string: 'items' }))
      .rejects.toThrow(/not supported/)
  })

  it('rejects UNC paths before project discovery', async () => {
    await expect(executeRead({ file_path: '\\\\attacker.invalid\\share\\file.txt' }))
      .rejects.toThrow(/UNC and device paths are not allowed/)
  })

  it('detects external changes even when size and mtime are restored', async () => {
    const root = await project()
    const file = path.join(root, 'same-version.txt')
    await writeFile(file, Buffer.from('AAAA'))
    await executeRead({ file_path: file })
    const original = await stat(file)
    await writeFile(file, Buffer.from('BBBB'))
    const { utimes } = await import('node:fs/promises')
    await utimes(file, original.atime, original.mtime)
    await expect(executeWrite({ file_path: file, content: 'CCCC' }))
      .rejects.toThrow(/unexpectedly modified/)
    expect(await readFile(file, 'utf8')).toBe('BBBB')
  })

  it('rejects ambiguous normalized quote matches and replaces all variants', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'quotes.txt')
    await writeFile(file, '‘x’ / ’x‘', 'utf8')
    await executeRead({ file_path: file })
    await expect(executeEdit({ file_path: file, old_string: "'x'", new_string: 'Y' }))
      .rejects.toThrow(/Found 2 matches/)
    await executeEdit({ file_path: file, old_string: "'x'", new_string: 'Y', replace_all: true })
    expect(await readFile(file, 'utf8')).toBe('Y / Y')
  })

  it('rejects characters not representable in the configured encoding', async () => {
    const root = await project('**/*.txt windows-1252\n')
    const file = path.join(root, 'legacy.txt')
    await writeFile(file, iconv.encode('café', 'windows-1252'))
    await executeRead({ file_path: file })
    await expect(executeEdit({ file_path: file, old_string: 'café', new_string: '汉字' }))
      .rejects.toThrow(/not representable/)
    expect(iconv.decode(await readFile(file), 'windows-1252')).toBe('café')
  })
})
