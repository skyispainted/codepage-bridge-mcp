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
  it('reads, edits, and writes UTF-8 files without encoding rules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'encoding-mcp-no-rules-'))
    const file = path.join(root, 'plain.txt')
    await writeFile(file, 'before\nline', 'utf8')
    await executeRead({ file_path: file })
    await executeEdit({ file_path: file, old_string: 'before', new_string: 'after' })
    await executeWrite({ file_path: file, content: 'rewritten' })
    expect(await readFile(file, 'utf8')).toBe('rewritten')
  })

  it('reads GBK as Unicode and edits back to GBK bytes', async () => {
    const root = await project()
    const file = path.join(root, 'hello.txt')
    await writeFile(file, iconv.encode('你好，世界\r\n第二行\r\n', 'gbk'))

    const read = await executeRead({ file_path: file })
    expect(read.content[0]).toMatchObject({ type: 'text' })
    expect((read.content[1] as { text: string }).text).toContain('你好，世界')

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

  it('allows a large-file edit after reading only the target line', async () => {
    const root = await project()
    const file = path.join(root, 'target-only.txt')
    const lines = Array.from({ length: 1000 }, (_, index) => index === 749 ? 'UNIQUE_TARGET' : `line-${index + 1}`)
    await writeFile(file, iconv.encode(lines.join('\n'), 'gbk'))
    await executeRead({ file_path: file, offset: 750, limit: 1 })
    await executeEdit({ file_path: file, old_string: 'UNIQUE_TARGET', new_string: 'UPDATED_TARGET' })
    expect(iconv.decode(await readFile(file), 'gbk')).toContain('UPDATED_TARGET')
  })

  it('rejects a large-file edit when the target line was not displayed', async () => {
    const root = await project()
    const file = path.join(root, 'unread-target.txt')
    await writeFile(file, iconv.encode('one\ntwo\nTARGET\nfour', 'gbk'))
    await executeRead({ file_path: file, offset: 1, limit: 2 })
    await expect(executeEdit({ file_path: file, old_string: 'TARGET', new_string: 'updated' }))
      .rejects.toThrow(/Read line range\(s\) 3/)
  })

  it('requires every replace-all target range to be read', async () => {
    const root = await project()
    const file = path.join(root, 'replace-all-ranges.txt')
    await writeFile(file, iconv.encode('MARK\nother\nMARK', 'gbk'))
    await executeRead({ file_path: file, offset: 1, limit: 1 })
    await expect(executeEdit({ file_path: file, old_string: 'MARK', new_string: 'DONE', replace_all: true }))
      .rejects.toThrow(/Read line range\(s\) 3/)
    await executeRead({ file_path: file, offset: 3, limit: 1 })
    await executeEdit({ file_path: file, old_string: 'MARK', new_string: 'DONE', replace_all: true })
    expect(iconv.decode(await readFile(file), 'gbk')).toBe('DONE\nother\nDONE')
  })
  it('allows editing after sequential ranges cover the complete file', async () => {
    const root = await project()
    const file = path.join(root, 'segmented.txt')
    await writeFile(file, iconv.encode('line1\nline2\nline3\nline4\nline5', 'gbk'))
    await executeRead({ file_path: file, offset: 1, limit: 2 })
    await executeRead({ file_path: file, offset: 3, limit: 2 })
    await expect(executeEdit({ file_path: file, old_string: 'line5', new_string: 'updated' }))
      .rejects.toThrow(/Read line range\(s\) 5/)
    await executeRead({ file_path: file, offset: 5, limit: 2 })
    await executeEdit({ file_path: file, old_string: 'line5', new_string: 'updated' })
    expect(iconv.decode(await readFile(file), 'gbk')).toContain('updated')
  })

  it('merges out-of-order and overlapping read ranges', async () => {
    const root = await project()
    const file = path.join(root, 'ranges.txt')
    await writeFile(file, iconv.encode('one\ntwo\nthree\nfour\nfive\nsix', 'gbk'))
    await executeRead({ file_path: file, offset: 5, limit: 2 })
    await executeRead({ file_path: file, offset: 2, limit: 4 })
    await executeRead({ file_path: file, offset: 1, limit: 1 })
    await executeEdit({ file_path: file, old_string: 'six', new_string: 'SIX' })
    expect(iconv.decode(await readFile(file), 'gbk')).toContain('SIX')
  })

  it('merges concurrently completed read ranges in the shared registry', async () => {
    const root = await project()
    const file = path.join(root, 'parallel.txt')
    await writeFile(file, iconv.encode('a\nb\nc\nd\ne\nf', 'gbk'))
    await Promise.all([
      executeRead({ file_path: file, offset: 1, limit: 2 }),
      executeRead({ file_path: file, offset: 3, limit: 2 }),
      executeRead({ file_path: file, offset: 5, limit: 2 }),
    ])
    await executeEdit({ file_path: file, old_string: 'f', new_string: 'F' })
    expect(iconv.decode(await readFile(file), 'gbk')).toContain('F')
  })

  it('invalidates accumulated ranges when the file version changes', async () => {
    const root = await project()
    const file = path.join(root, 'versioned-ranges.txt')
    await writeFile(file, iconv.encode('a\nb\nc\nd', 'gbk'))
    await executeRead({ file_path: file, offset: 1, limit: 2 })
    await writeFile(file, iconv.encode('x\ny\nz\nw', 'gbk'))
    fileStateCache.clear()
    await executeRead({ file_path: file, offset: 3, limit: 2 })
    await expect(executeEdit({ file_path: file, old_string: 'x', new_string: 'X' }))
      .rejects.toThrow(/Read line range\(s\) 1/)
  })
  it('allows editing a target that was included in a partial read', async () => {
    const root = await project()
    const file = path.join(root, 'partial.txt')
    await writeFile(file, iconv.encode('第一行\n第二行\n第三行', 'gbk'))
    await executeRead({ file_path: file, offset: 2, limit: 1 })
    await executeEdit({ file_path: file, old_string: '第二行', new_string: '修改' })
    expect(iconv.decode(await readFile(file), 'gbk')).toContain('修改')
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

  it('rejects a file over the default maximum even when a read limit is provided', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'oversized.txt')
    await writeFile(file, Buffer.alloc(32 * 1024 * 1024 + 1, 'x'))
    await expect(executeRead({ file_path: file, offset: 1, limit: 1 }))
      .rejects.toThrow(/exceeds the absolute maximum/)
  })

  it('uses CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB for the Read limit', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'configured.txt')
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 'x'))
    const previous = process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB
    process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB = '1'
    try {
      await expect(executeRead({ file_path: file, offset: 1, limit: 1 }))
        .rejects.toThrow(/exceeds the absolute maximum/)
    } finally {
      if (previous === undefined) delete process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB
      else process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB = previous
    }
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

describe('token-frugal tool results', () => {
  it('returns a one-line confirmation from Edit instead of echoing the file', async () => {
    const root = await project()
    const file = path.join(root, 'quiet-edit.txt')
    const body = Array.from({ length: 200 }, (_, index) => `line-${index + 1} filler text`).join('\n')
    await writeFile(file, body, 'utf8')
    await executeRead({ file_path: file })

    const result = await executeEdit({ file_path: file, old_string: 'line-50 filler', new_string: 'CHANGED' })

    expect(result.structuredContent).toBeUndefined()
    expect(result.content).toHaveLength(1)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('updated successfully')
    expect(text).not.toContain('filler text')
    expect(text.length).toBeLessThan(300)
  })

  it('returns a one-line confirmation from Edit when it creates the file', async () => {
    const root = await project()
    const file = path.join(root, 'quiet-create.txt')

    const result = await executeEdit({ file_path: file, old_string: '', new_string: 'created body' })

    expect(result.structuredContent).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('created successfully')
    expect(text).not.toContain('created body')
  })

  it('returns a one-line confirmation from Write instead of echoing both versions', async () => {
    const root = await project()
    const file = path.join(root, 'quiet-write.txt')
    const before = Array.from({ length: 100 }, (_, index) => `old-${index}`).join('\n')
    const after = Array.from({ length: 100 }, (_, index) => `new-${index}`).join('\n')
    await writeFile(file, before, 'utf8')
    await executeRead({ file_path: file })

    const result = await executeWrite({ file_path: file, content: after })

    expect(result.structuredContent).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('updated successfully')
    expect(text).not.toContain('old-0')
    expect(text).not.toContain('new-0')
  })

  it('returns a one-line confirmation from Write when it creates the file', async () => {
    const root = await project()
    const file = path.join(root, 'quiet-write-create.txt')

    const result = await executeWrite({ file_path: file, content: 'fresh body' })

    expect(result.structuredContent).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('created successfully')
    expect(text).not.toContain('fresh body')
  })

  it('returns line-numbered text from Read without duplicating it in structuredContent', async () => {
    const root = await project()
    const file = path.join(root, 'numbered.txt')
    await writeFile(file, 'alpha\nbeta\ngamma', 'utf8')

    const result = await executeRead({ file_path: file })

    expect(result.structuredContent).toBeUndefined()
    expect(result.content[1]).toEqual({ type: 'text', text: '     1\talpha\n     2\tbeta\n     3\tgamma' })
  })

  it('keeps line numbers aligned to the offset for a partial Read', async () => {
    const root = await project()
    const file = path.join(root, 'numbered-offset.txt')
    await writeFile(file, 'one\ntwo\nthree\nfour', 'utf8')

    const result = await executeRead({ file_path: file, offset: 3, limit: 2 })

    expect(result.structuredContent).toBeUndefined()
    expect(result.content[1]).toEqual({ type: 'text', text: '     3\tthree\n     4\tfour' })
  })

  it('keeps the unchanged-file notice as plain text', async () => {
    const root = await project()
    const file = path.join(root, 'unchanged.txt')
    await writeFile(file, 'stable', 'utf8')
    await executeRead({ file_path: file })

    const result = await executeRead({ file_path: file })

    expect(result.structuredContent).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain('File unchanged since last read')
  })
})

describe('line-ending transparency', () => {
  it('reports the file line ending so the model never has to guess', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'windows.txt')
    await writeFile(file, 'a\r\nb\r\nc\r\n', 'utf8')

    const result = await executeRead({ file_path: file })

    expect((result.content[0] as { text: string }).text).toContain('CRLF')
    expect((result.content[1] as { text: string }).text).not.toContain('\r')
  })

  it('reports LF for a Unix file', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'unix.txt')
    await writeFile(file, 'a\nb\n', 'utf8')

    const result = await executeRead({ file_path: file })

    expect((result.content[0] as { text: string }).text).toContain('LF line endings')
    expect((result.content[0] as { text: string }).text).not.toContain('CRLF')
  })

  it('reports the line range and total so the model need not re-read for it', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'range-info.txt')
    await writeFile(file, 'a\nb\nc\nd\n', 'utf8')

    const result = await executeRead({ file_path: file, offset: 2, limit: 2 })

    expect((result.content[0] as { text: string }).text).toContain('lines 2-3 of 4')
  })

  it('does not present the final newline as an extra empty line', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'trailing-newline.txt')
    await writeFile(file, 'a\nb\nc\n', 'utf8')

    const result = await executeRead({ file_path: file })

    expect((result.content[0] as { text: string }).text).toContain('lines 1-3 of 3')
    expect((result.content[1] as { text: string }).text).toBe('     1\ta\n     2\tb\n     3\tc')
  })

  it('accepts CRLF old_string against an LF-normalized file', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'mixed-crlf.txt')
    await writeFile(file, 'one\r\ntwo\r\nthree\r\n', 'utf8')
    await executeRead({ file_path: file })

    const result = await executeEdit({ file_path: file, old_string: 'one\r\ntwo', new_string: 'ONE\r\nTWO' })

    expect((result.content[0] as { text: string }).text).toContain('updated successfully')
    expect(await readFile(file, 'utf8')).toBe('ONE\r\nTWO\r\nthree\r\n')
  })

  it('edits an LF file when the model supplies CRLF line endings', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'mixed-lf.txt')
    await writeFile(file, 'alpha\nbeta\n', 'utf8')
    await executeRead({ file_path: file })

    await executeEdit({ file_path: file, old_string: 'alpha\nbeta', new_string: 'first\r\nsecond' })

    expect(await readFile(file, 'utf8')).toBe('first\nsecond\n')
  })

  it('keeps the file CRLF when Write rewrites it', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'crlf-rewrite.txt')
    await writeFile(file, 'old\r\nbody\r\n', 'utf8')
    await executeRead({ file_path: file })

    await executeWrite({ file_path: file, content: 'new\r\nbody\r\n' })

    expect(await readFile(file, 'utf8')).toBe('new\r\nbody\r\n')
  })

  it('keeps the file CRLF when the model sends LF to Write', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'crlf-write-lf.txt')
    await writeFile(file, 'old\r\nbody\r\n', 'utf8')
    await executeRead({ file_path: file })

    await executeWrite({ file_path: file, content: 'new\nbody\n' })

    expect(await readFile(file, 'utf8')).toBe('new\r\nbody\r\n')
  })

  it('honours the requested line ending when Write creates a new file', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'created-crlf.txt')

    const result = await executeWrite({ file_path: file, content: 'a\r\nb\r\n' })

    expect((result.content[0] as { text: string }).text).toContain('CRLF')
    expect(await readFile(file, 'utf8')).toBe('a\r\nb\r\n')
  })

  it('honours the requested line ending when Edit creates a new file', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'created-crlf-edit.txt')

    const result = await executeEdit({ file_path: file, old_string: '', new_string: 'a\r\nb\r\n' })

    expect((result.content[0] as { text: string }).text).toContain('CRLF')
    expect(await readFile(file, 'utf8')).toBe('a\r\nb\r\n')
  })

  it('describes the line ending in the success message', async () => {
    const root = await project('**/*.txt utf8\n')
    const file = path.join(root, 'announced.txt')
    await writeFile(file, 'old\r\nbody\r\n', 'utf8')
    await executeRead({ file_path: file })

    const result = await executeEdit({ file_path: file, old_string: 'old', new_string: 'new' })

    expect((result.content[0] as { text: string }).text).toContain('CRLF')
  })
})
