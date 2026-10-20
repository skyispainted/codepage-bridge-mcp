import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const syscalls = {
  readFile: 0,
  access: 0,
  realpath: 0,
  lstat: 0,
  stat: 0,
  readdir: 0,
  readlink: 0,
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const counted = <T extends keyof typeof syscalls>(name: T) => {
    const original = actual[name]
    return (...args: never[]) => {
      syscalls[name] += 1
      return (original as (...rest: never[]) => unknown)(...args)
    }
  }
  return {
    ...actual,
    default: actual,
    readFile: counted('readFile'),
    access: counted('access'),
    realpath: counted('realpath'),
    lstat: counted('lstat'),
    stat: counted('stat'),
    readdir: counted('readdir'),
    readlink: counted('readlink'),
  }
})

const { executeGrep } = await import('../src/tools/grep.js')

function resetCounts(): void {
  for (const key of Object.keys(syscalls) as Array<keyof typeof syscalls>) syscalls[key] = 0
}

/**
 * Rules live in the parent of the searched directory, so the search reaches
 * them as soon as it starts and nothing outside the fixture can be consulted.
 * Candidates sit in two directories at different depths. Returns the directory
 * to search and how many candidate .go files it holds.
 */
async function fixture(leafFiles = 2): Promise<{ searched: string; candidates: number }> {
  const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-walk-'))
  await writeFile(path.join(root, '.encoding-rules'), '**/*.go utf8\n', 'utf8')
  const searched = path.join(root, 'one')
  const deep = path.join(searched, 'two', 'three')
  await mkdir(deep, { recursive: true })
  for (let index = 0; index < leafFiles; index += 1) {
    const name = `f${index}`
    await writeFile(path.join(searched, `${name}.go`), `package one\n// needle ${name}\n`)
    await writeFile(path.join(deep, `${name}.go`), `package three\n// needle ${name}\n`)
  }
  await writeFile(path.join(deep, 'ignored.txt'), 'needle')
  return { searched, candidates: leafFiles * 2 }
}

beforeEach(() => {
  resetCounts()
})

describe('grep walk cost', () => {
  it('validates the caller target once instead of resolving every walked entry', async () => {
    const { searched } = await fixture()
    await executeGrep({ pattern: 'needle', path: searched, type: 'go', output_mode: 'files_with_matches' })

    // Only the path the caller named is symbol-link checked. Everything else
    // comes from a directory listing, which reports regular files and
    // directories and never a symbol link, so the walk root that was resolved
    // once before the walk bounds every path reached from here.
    expect(syscalls.lstat).toBe(1)
    expect(syscalls.realpath).toBeLessThanOrEqual(3)
  })

  it('stats only the files it scans, reusing directory types from the listing', async () => {
    const { searched, candidates } = await fixture()
    await executeGrep({ pattern: 'needle', path: searched, type: 'go', output_mode: 'files_with_matches' })

    // One stat for the caller's target, then one size check per candidate.
    // Directories need none: the directory listing already classified them.
    expect(syscalls.stat).toBe(1 + candidates)
  })

  it('resolves encoding rules the same amount however many files it scans', async () => {
    const few = await fixture(1)
    await executeGrep({ pattern: 'needle', path: few.searched, type: 'go', output_mode: 'files_with_matches' })
    const fewProbes = syscalls.access

    const many = await fixture(40)
    resetCounts()
    await executeGrep({ pattern: 'needle', path: many.searched, type: 'go', output_mode: 'files_with_matches' })

    // Comparing two runs on one platform keeps this independent of whether the
    // temporary directory is itself reached through a symbol link, which can
    // add one probe for the canonical form of the same directory.
    expect(syscalls.access).toBe(fewProbes)
  })

  it('does not re-probe for rules as the walk descends', async () => {
    const shallow = await fixture(1)
    await executeGrep({ pattern: 'needle', path: shallow.searched, type: 'go', output_mode: 'files_with_matches' })
    const shallowProbes = syscalls.access

    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-deep-'))
    await writeFile(path.join(root, '.encoding-rules'), '**/*.go utf8\n', 'utf8')
    const deep = path.join(root, 'a', 'b', 'c', 'd', 'e')
    await mkdir(deep, { recursive: true })
    await writeFile(path.join(deep, 'g.go'), 'package deep\n// needle\n')

    resetCounts()
    await executeGrep({ pattern: 'needle', path: path.join(root, 'a'), type: 'go', output_mode: 'files_with_matches' })

    expect(syscalls.access).toBe(shallowProbes)
  })

  it('reports every candidate with exact counts', async () => {
    const { searched, candidates } = await fixture()
    const result = await executeGrep({ pattern: 'needle', path: searched, type: 'go', output_mode: 'files_with_matches' })
    const entries = (result.structuredContent as { entries: string[] }).entries
    expect(entries).toHaveLength(candidates)
    expect(entries).toEqual([...entries].sort())
    expect(result.structuredContent).toMatchObject({ scanComplete: true, countsExact: true })
  })
})
