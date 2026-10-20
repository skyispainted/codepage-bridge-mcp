import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = {
  readFile: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  streamOpen: 0,
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    readFile: async (file: string, ...rest: never[]) => {
      io.readFile.push(String(file))
      io.inFlight += 1
      io.maxInFlight = Math.max(io.maxInFlight, io.inFlight)
      try {
        return await (actual.readFile as (target: string, ...extra: never[]) => Promise<Buffer>)(file, ...rest)
      } finally {
        io.inFlight -= 1
      }
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    createReadStream: (...args: never[]) => {
      io.streamOpen += 1
      return (actual.createReadStream as (...rest: never[]) => unknown)(...args)
    },
  }
})

const { executeGrep } = await import('../src/tools/grep.js')

/** Only reads of the fixture's own files; rules files are read separately. */
function candidateReads(): string[] {
  return io.readFile.filter(file => !path.basename(file).startsWith('.encoding-rules'))
}

function resetIo(): void {
  io.readFile = []
  io.inFlight = 0
  io.maxInFlight = 0
  io.streamOpen = 0
}

/** A tree wide and deep enough that a serial reader cannot overlap two reads. */
async function wideTree(filesPerDirectory = 12, directories = 6): Promise<{ root: string; candidates: number }> {
  const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-parallel-'))
  await writeFile(path.join(root, '.encoding-rules'), '**/*.go utf8\n', 'utf8')
  for (let d = 0; d < directories; d += 1) {
    const directory = path.join(root, `pkg${d}`)
    await mkdir(directory)
    for (let f = 0; f < filesPerDirectory; f += 1) {
      await writeFile(path.join(directory, `f${f}.go`), `package pkg${d}\n// needle ${d}-${f}\n`)
    }
  }
  return { root, candidates: filesPerDirectory * directories }
}

beforeEach(() => {
  resetIo()
})

describe('grep candidate reading', () => {
  it('reads candidate files concurrently rather than one at a time', async () => {
    const { root } = await wideTree()
    await executeGrep({ pattern: 'needle', path: root, type: 'go', output_mode: 'files_with_matches' })

    // A serial reader touches one file at a time, so overlap can only come from
    // reading ahead. This is the property that makes a large scan fast.
    expect(io.maxInFlight).toBeGreaterThan(1)
  })

  it('bounds how many candidate files it holds open at once', async () => {
    const { root } = await wideTree(40, 8)
    await executeGrep({ pattern: 'needle', path: root, type: 'go', output_mode: 'files_with_matches' })

    // Reading ahead must not turn into unbounded concurrency: file descriptors
    // and decoded text both cost memory that grows with the window.
    expect(io.maxInFlight).toBeLessThanOrEqual(64)
  })

  it('still reads every candidate exactly once', async () => {
    const { root, candidates } = await wideTree()
    await executeGrep({ pattern: 'needle', path: root, type: 'go', output_mode: 'files_with_matches' })

    const reads = candidateReads()
    expect(reads).toHaveLength(candidates)
    expect(new Set(reads).size).toBe(candidates)
  })

  it('streams the caller-named file instead of reading it whole', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepage-grep-explicit-'))
    await writeFile(path.join(root, '.encoding-rules'), '*.txt utf8\n', 'utf8')
    const file = path.join(root, 'one.txt')
    await writeFile(file, 'needle\nother\n')

    await executeGrep({ pattern: 'needle', path: file })

    // An explicit target can be arbitrarily large and is outside any scan
    // window, so it stays on the streaming path rather than being loaded whole.
    expect(io.streamOpen).toBeGreaterThan(0)
    expect(candidateReads()).toHaveLength(0)
  })
})
