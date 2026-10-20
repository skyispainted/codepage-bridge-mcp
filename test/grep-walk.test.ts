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

const CANDIDATE_FILES = 6

/**
 * Rules live in the parent of the searched directory, so the search reaches
 * them the moment it starts and nothing outside the fixture can be consulted.
 * Returns the directory to search.
 */
async function depthFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-walk-'))
  await writeFile(path.join(root, '.encoding-rules'), '**/*.go utf8\n', 'utf8')
  const searched = path.join(root, 'one')
  const deep = path.join(searched, 'two', 'three')
  await mkdir(deep, { recursive: true })
  for (const name of ['a', 'b', 'c']) {
    await writeFile(path.join(searched, `${name}.go`), `package one\n// needle ${name}\n`)
  }
  for (const name of ['d', 'e']) {
    await writeFile(path.join(deep, `${name}.go`), `package three\n// needle ${name}\n`)
  }
  await writeFile(path.join(deep, 'f.go'), 'package three\n// needle f\n')
  await writeFile(path.join(deep, 'ignored.txt'), 'needle')
  return searched
}

beforeEach(() => {
  resetCounts()
})

describe('grep walk cost', () => {
  it('validates the caller target once instead of resolving every walked entry', async () => {
    const root = await depthFixture()
    await executeGrep({ pattern: 'needle', path: root, type: 'go', output_mode: 'files_with_matches' })

    // Only the path the caller named is symbol-link checked. Everything else
    // comes from a directory listing, which reports regular files and
    // directories and never a symbol link, so the walk root bounds them all.
    expect(syscalls.lstat).toBe(1)
    expect(syscalls.realpath).toBeLessThanOrEqual(3)
  })

  it('stats only the files it scans, reusing directory types from the listing', async () => {
    const root = await depthFixture()
    await executeGrep({ pattern: 'needle', path: root, type: 'go', output_mode: 'files_with_matches' })

    // One stat for the caller's target, then one size check per candidate.
    // Directories need none: the directory listing already classified them.
    expect(syscalls.stat).toBe(1 + CANDIDATE_FILES)
  })

  it('resolves encoding rules once for the whole search', async () => {
    const searched = await depthFixture()
    await executeGrep({ pattern: 'needle', path: searched, type: 'go', output_mode: 'files_with_matches' })

    // Two probes: the searched directory's parent, which already holds the
    // rules, and the searched directory itself, which does not. What matters is
    // that the nested two/three contribute nothing, however deep they go.
    expect(syscalls.access).toBe(2)
    expect(syscalls.readFile).toBe(1)
  })

  it('does not re-probe for rules as the walk descends', async () => {
    const shallow = await depthFixture()
    resetCounts()
    await executeGrep({ pattern: 'needle', path: shallow, type: 'go', output_mode: 'files_with_matches' })
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

  it('reports the same result as an unfiltered scan of the same tree', async () => {
    const root = await depthFixture()
    const result = await executeGrep({ pattern: 'needle', path: root, type: 'go', output_mode: 'files_with_matches' })
    const entries = (result.structuredContent as { entries: string[] }).entries
    expect(entries).toHaveLength(CANDIDATE_FILES)
    expect(entries).toEqual([...entries].sort())
    expect(result.structuredContent).toMatchObject({ scanComplete: true, countsExact: true })
  })
})
