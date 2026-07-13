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
  const rules = await findEncodingRules(path.dirname(absolutePath))
  if (rules.file === null) {
    throw new Error(`No .encoding-rules found for ${filePath}`)
  }
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

export class ReadRegistry {
  private readonly snapshots = new Map<string, ReadSnapshot>()
  private readonly ranges = new Map<string, { mtimeMs: number; hash: string; offset?: number; limit?: number }>()

  get(filePath: string): ReadSnapshot | undefined {
    return this.snapshots.get(path.resolve(filePath))
  }

  remember(snapshot: ReadSnapshot): void {
    if (snapshot.complete) this.snapshots.set(snapshot.absolutePath, snapshot)
    this.ranges.set(snapshot.absolutePath, {
      mtimeMs: snapshot.mtimeMs,
      hash: snapshot.hash,
      ...(snapshot.offset === undefined ? {} : { offset: snapshot.offset }),
      ...(snapshot.limit === undefined ? {} : { limit: snapshot.limit }),
    })
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
    const { offset: _offset, limit: _limit, ...base } = snapshot
    const next: ReadSnapshot = {
      ...base,
      text,
      size: buffer.length,
      hash: digest(buffer),
      mtimeMs,
      complete: true,
    }
    this.snapshots.set(snapshot.absolutePath, next)
    this.ranges.set(snapshot.absolutePath, { mtimeMs, hash: digest(buffer) })
  }
}

export const readRegistry = new ReadRegistry()
