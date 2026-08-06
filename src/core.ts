import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import {
  decodeText,
  encodeText,
  findEncodingRules,
  resolveEncoding,
  type DecodedText,
  type EncodingRules,
} from './encoding/index.js'
import { fileStateCache, resolveProjectPath } from './filesystem/index.js'

export interface ProjectFileContext {
  absolutePath: string
  root: string
  rules: EncodingRules
  encoding: string
}

export interface ReadSnapshot {
  absolutePath: string
  root: string
  encoding: string
  text: string
  bom: DecodedText['bom']
  newline: DecodedText['newline']
  mtimeMs: number
  size: number
  hash: string
  complete: boolean
  offset?: number
  limit?: number
}

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function getProjectFileContext(filePath: string): Promise<ProjectFileContext> {
  if (filePath.includes('\0')) throw new Error('file_path must not contain NUL bytes')
  if (/^[/\\]{2}/.test(filePath) || /^\\\\[?.]\\/.test(filePath)) {
    throw new Error('UNC and device paths are not allowed')
  }
  if (!path.isAbsolute(filePath)) throw new Error('file_path must be an absolute path')
  const absolutePath = path.resolve(filePath)
  const foundRules = await findEncodingRules(path.dirname(absolutePath))
  const rules = foundRules.file === null
    ? { ...foundRules, root: path.dirname(absolutePath) }
    : foundRules
  resolveProjectPath(rules.root, absolutePath)
  return {
    absolutePath,
    root: rules.root,
    rules,
    encoding: resolveEncoding(absolutePath, rules),
  }
}

export async function readDecodedFile(context: ProjectFileContext): Promise<ReadSnapshot> {
  const state = await fileStateCache.read(context.root, context.absolutePath)
  const decoded = decodeText(state.buffer, context.encoding)
  return {
    absolutePath: context.absolutePath,
    root: context.root,
    encoding: decoded.encoding,
    text: decoded.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
    bom: decoded.bom,
    newline: decoded.newline,
    mtimeMs: state.mtimeMs,
    size: state.size,
    hash: state.hash,
    complete: true,
  }
}

export function encodeSnapshotText(snapshot: ReadSnapshot, text: string, preserveNewline = true): Buffer {
  return encodeText(text, snapshot.encoding, {
    bom: snapshot.bom,
    newline: preserveNewline ? snapshot.newline : null,
  })
}

interface ReadCoverage {
  hash: string
  mtimeMs: number
  totalLines: number
  intervals: Array<{ start: number; end: number }>
}

const MAX_REGISTRY_ENTRIES = 128

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
  next: { start: number; end: number },
): Array<{ start: number; end: number }> {
  if (next.end < next.start) return intervals
  const merged: Array<{ start: number; end: number }> = []
  let current = next
  for (const interval of [...intervals, next].sort((left, right) => left.start - right.start)) {
    if (interval === next) continue
    if (interval.end + 1 < current.start) merged.push(interval)
    else if (current.end + 1 < interval.start) {
      merged.push(current)
      current = interval
    } else {
      current = {
        start: Math.min(current.start, interval.start),
        end: Math.max(current.end, interval.end),
      }
    }
  }
  merged.push(current)
  return merged.sort((left, right) => left.start - right.start)
}

export class ReadRegistry {
  private readonly snapshots = new Map<string, Pick<ReadSnapshot, 'mtimeMs' | 'hash'>>()
  private readonly coverage = new Map<string, ReadCoverage>()
  private readonly ranges = new Map<string, { mtimeMs: number; hash: string; offset?: number; limit?: number }>()

  private evictIfNeeded(): void {
    while (this.coverage.size >= MAX_REGISTRY_ENTRIES) {
      const oldest = this.coverage.keys().next().value
      if (oldest === undefined) return
      this.clear(oldest)
    }
  }

  private touch(filePath: string): void {
    const coverage = this.coverage.get(filePath)
    const range = this.ranges.get(filePath)
    const snapshot = this.snapshots.get(filePath)
    if (coverage !== undefined) {
      this.coverage.delete(filePath)
      this.coverage.set(filePath, coverage)
    }
    if (range !== undefined) {
      this.ranges.delete(filePath)
      this.ranges.set(filePath, range)
    }
    if (snapshot !== undefined) {
      this.snapshots.delete(filePath)
      this.snapshots.set(filePath, snapshot)
    }
  }

  get(filePath: string): Pick<ReadSnapshot, 'mtimeMs' | 'hash'> | undefined {
    const absolutePath = path.resolve(filePath)
    const snapshot = this.snapshots.get(absolutePath)
    if (snapshot !== undefined) this.touch(absolutePath)
    return snapshot
  }

  clear(filePath?: string): void {
    if (filePath === undefined) {
      this.snapshots.clear()
      this.coverage.clear()
      this.ranges.clear()
      return
    }
    const absolutePath = path.resolve(filePath)
    this.snapshots.delete(absolutePath)
    this.coverage.delete(absolutePath)
    this.ranges.delete(absolutePath)
  }

  remember(
    snapshot: ReadSnapshot,
    range: { startLine: number; endLine: number; totalLines: number },
  ): void {
    const key = snapshot.absolutePath
    const existing = this.coverage.get(key)
    if (existing === undefined) this.evictIfNeeded()
    else this.touch(key)
    const sameVersion = existing?.hash === snapshot.hash
      && existing.mtimeMs === snapshot.mtimeMs
    const intervals = sameVersion ? existing.intervals : []
    const merged = mergeIntervals(intervals, {
      start: Math.max(1, range.startLine),
      end: Math.min(range.totalLines, range.endLine),
    })
    const complete = merged.length === 1
      && merged[0]?.start === 1
      && merged[0].end >= range.totalLines
    const remembered: ReadSnapshot = { ...snapshot, complete }
    this.coverage.set(key, {
      hash: remembered.hash,
      mtimeMs: remembered.mtimeMs,
      totalLines: range.totalLines,
      intervals: merged,
    })
    if (complete) this.snapshots.set(key, { mtimeMs: remembered.mtimeMs, hash: remembered.hash })
    else this.snapshots.delete(key)
    this.ranges.set(key, {
      mtimeMs: snapshot.mtimeMs,
      hash: snapshot.hash,
      ...(snapshot.offset === undefined ? {} : { offset: snapshot.offset }),
      ...(snapshot.limit === undefined ? {} : { limit: snapshot.limit }),
    })
  }

  authorizeEdit(
    filePath: string,
    currentHash: string,
    requiredRanges: Array<{ startLine: number; endLine: number }>,
  ):
    | { status: 'authorized' }
    | { status: 'unread' }
    | { status: 'changed' }
    | { status: 'uncovered'; missing: Array<{ startLine: number; endLine: number }> } {
    const entry = this.coverage.get(path.resolve(filePath))
    if (!entry) return { status: 'unread' }
    if (entry.hash !== currentHash) return { status: 'changed' }
    const missing = requiredRanges.filter(required => !entry.intervals.some(
      interval => interval.start <= required.startLine && interval.end >= required.endLine,
    ))
    if (missing.length > 0) return { status: 'uncovered', missing }
    return { status: 'authorized' }
  }
  async isUnchanged(filePath: string, offset?: number, limit?: number): Promise<boolean> {
    const absolutePath = path.resolve(filePath)
    const previous = this.ranges.get(absolutePath)
    if (!previous || previous.offset !== offset || previous.limit !== limit) return false
    const context = await getProjectFileContext(absolutePath)
    const current = await fileStateCache.read(context.root, absolutePath)
    return current.mtimeMs === previous.mtimeMs && current.hash === previous.hash
  }

  updateAfterWrite(snapshot: ReadSnapshot, text: string, buffer: Buffer, mtimeMs: number): void {
    const hash = digest(buffer)
    const totalLines = text.split('\n').length
    this.evictIfNeeded()
    this.snapshots.set(snapshot.absolutePath, { mtimeMs, hash })
    this.coverage.set(snapshot.absolutePath, {
      hash,
      mtimeMs,
      totalLines,
      intervals: [{ start: 1, end: totalLines }],
    })
    this.ranges.set(snapshot.absolutePath, { mtimeMs, hash })
  }
}
export const readRegistry = new ReadRegistry()
