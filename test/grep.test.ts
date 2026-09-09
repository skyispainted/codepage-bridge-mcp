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
  it('searches UTF-8 directories without encoding rules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-no-rules-'))
    const file = path.join(root, 'plain.txt')
    await writeFile(file, 'needle', 'utf8')
    const result = await executeGrep({ pattern: 'needle', path: root })
    expect((result.content[0] as { text: string }).text).toBe(file)
  })

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
  it('scans every matching file after output pagination truncates entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-complete-scan-'))
    await Promise.all(Array.from({ length: 300 }, async (_, index) => {
      await writeFile(path.join(root, `source-${index.toString().padStart(3, '0')}.ts`), `const marker = ${index}\n`, 'utf8')
    }))
    const result = await executeGrep({ pattern: 'marker', path: root, head_limit: 1 })
    expect(result.structuredContent).toMatchObject({
      numFiles: 300,
      numMatches: 300,
      scanComplete: true,
      countsExact: true,
      outputTruncated: true,
    })
    expect((result.content[0] as { text: string }).text).toContain('pagination')
  })

  it('searches matches spanning stream chunks without materializing the file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-streaming-'))
    const file = path.join(root, 'streamed.txt')
    await writeFile(file, `${'x'.repeat(64 * 1024 - 3)}needle\n${'y'.repeat(8 * 1024 * 1024)}`, 'utf8')
    const result = await executeGrep({ pattern: 'needle', path: file, output_mode: 'content' })
    expect((result.content[0] as { text: string }).text).toBe(`1:${'x'.repeat(64 * 1024 - 3)}needle`)
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

  it('streams dense only-matching results without collecting every match', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-dense-only-'))
    const file = path.join(root, 'dense.txt')
    await writeFile(file, 'x'.repeat(250_000), 'utf8')
    const result = await executeGrep({ pattern: 'x', path: file, output_mode: 'content', '-o': true, head_limit: 1 })
    expect((result.content[0] as { text: string }).text).toContain('1:x')
    expect((result.content[0] as { text: string }).text).toContain('pagination')
    expect(result.structuredContent).toMatchObject({ numFiles: 1, numMatches: 1 })
  })

  it('reports decoding failures for explicit files instead of returning zero matches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-error-'))
    await writeFile(path.join(root, '.encoding-rules'), '*.txt utf8\n', 'utf8')
    const file = path.join(root, 'broken.txt')
    await writeFile(file, Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(executeGrep({ pattern: 'anything', path: file }))
      .rejects.toThrow(/Failed to search.*Invalid byte sequence/)
  })

  it('marks a directory scan incomplete when the shared file budget truncates it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-file-budget-'))
    await writeFile(path.join(root, 'a.txt'), 'needle', 'utf8')
    await writeFile(path.join(root, 'b.txt'), 'needle', 'utf8')
    await withEnvironment('CODEPAGE_BRIDGE_MAX_GREP_FILES', '1', async () => {
      const result = await executeGrep({ pattern: 'needle', path: root })
      expect(result.structuredContent).toMatchObject({
        scanComplete: false,
        countsExact: false,
        truncationReason: 'max_files',
        scannedFiles: 1,
        skippedFiles: 1,
      })
    })
  })

  it('rejects an explicit file when its shared scan-byte budget cannot admit it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-byte-budget-'))
    const file = path.join(root, 'target.txt')
    await writeFile(file, 'needle', 'utf8')
    await withEnvironment('CODEPAGE_BRIDGE_MAX_GREP_SCAN_BYTES', '1', async () => {
      await expect(executeGrep({ pattern: 'needle', path: file }))
        .rejects.toThrow(/Grep search budget exceeded: max_scan_bytes/)
    })
  })

  it('keeps exact counts by default and labels first-match fast scans as inexact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-scan-mode-'))
    const file = path.join(root, 'target.txt')
    await writeFile(file, 'needle\nneedle', 'utf8')
    const exact = await executeGrep({ pattern: 'needle', path: file })
    const fast = await executeGrep({ pattern: 'needle', path: file, scan_mode: 'fast' })
    expect(exact.structuredContent).toMatchObject({ numFiles: 1, numMatches: 2, scanComplete: true, countsExact: true })
    expect(fast.structuredContent).toMatchObject({ numFiles: 1, numMatches: 1, scanComplete: true, countsExact: false })
    await expect(executeGrep({ pattern: 'needle', path: file, scan_mode: 'fast', output_mode: 'count' }))
      .rejects.toThrow(/only supported with output_mode=files_with_matches/)
  })

  it('bounds context storage and lazy only-match enumeration with diagnostic limits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-output-budget-'))
    const file = path.join(root, 'target.txt')
    await writeFile(file, 'xxxxxx', 'utf8')
    await withEnvironment('CODEPAGE_BRIDGE_MAX_GREP_CONTEXT_LINES', '1', async () => {
      await expect(executeGrep({ pattern: 'x', path: file, output_mode: 'content', '-C': 1 }))
        .rejects.toThrow(/Requested context exceeds/)
    })
    await withEnvironment('CODEPAGE_BRIDGE_MAX_GREP_ONLY_MATCHES', '2', async () => {
      const result = await executeGrep({ pattern: 'x', path: file, output_mode: 'content', '-o': true })
      expect(result.structuredContent).toMatchObject({
        scanComplete: false,
        countsExact: false,
        truncationReason: 'max_only_matches',
      })
      expect((result.structuredContent as Record<string, unknown>).entries).toHaveLength(2)
      expect((result.content[0] as { text: string }).text).toContain('Search incomplete: scanComplete=false')
    })
    await withEnvironment('CODEPAGE_BRIDGE_MAX_GREP_LINE_CHARS', '3', async () => {
      await expect(executeGrep({ pattern: 'x', path: file }))
        .rejects.toThrow(/Grep search budget exceeded: max_line_chars/)
    })
  })

  it('rejects before-context retention that would exceed the response-sized memory bound', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-context-memory-'))
    const file = path.join(root, 'target.txt')
    await writeFile(file, `${'a'.repeat(600_000)}\n${'b'.repeat(600_000)}\nneedle`, 'utf8')
    await expect(executeGrep({ pattern: 'needle', path: file, output_mode: 'content', '-B': 2 }))
      .rejects.toThrow(/Grep search budget exceeded: max_context_chars/)
  })

  it('performs exact cross-line multiline matching and rejects multiline files over its stricter limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-multiline-'))
    const small = path.join(root, 'small.txt')
    await writeFile(small, 'prefix first\nsecond suffix', 'utf8')
    const exact = await executeGrep({ pattern: 'first\\nsecond', path: small, multiline: true })
    expect(exact.structuredContent).toMatchObject({ numFiles: 1, numMatches: 1, scanComplete: true, countsExact: true })
    const large = path.join(root, 'large.txt')
    await writeFile(large, Buffer.alloc(1024 * 1024 + 1, 'x'))
    await expect(executeGrep({ pattern: 'x', path: large, multiline: true }))
      .rejects.toThrow(/Multiline search is limited to 1 MiB/)
  })

  it('rejects malformed Grep budget environment values instead of silently accepting them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-invalid-budget-'))
    await writeFile(path.join(root, 'target.txt'), 'needle', 'utf8')
    await withEnvironment('CODEPAGE_BRIDGE_MAX_GREP_FILES', 'not-a-number', async () => {
      await expect(executeGrep({ pattern: 'needle', path: root }))
        .rejects.toThrow(/CODEPAGE_BRIDGE_MAX_GREP_FILES must be a positive safe integer/)
    })
  })
})

async function withEnvironment<T>(name: string, value: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await action()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}
