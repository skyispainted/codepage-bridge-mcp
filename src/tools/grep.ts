import { createReadStream, type Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import picomatch from 'picomatch'

import { decodeText, normalizeEncoding, resolveEncoding } from '../encoding/index.js'
import { inspectProjectPath } from '../filesystem/index.js'
import { formatMebibytes, grepLimits, maxTextFileBytes, type GrepLimits } from '../limits.js'
import { getProjectFileContext, type ProjectFileContext } from '../core.js'
import type { ToolResponse } from '../toolTypes.js'
import {
  assertObject,
  optionalBoolean,
  optionalInteger,
  optionalString,
  rejectUnknown,
  requiredString,
} from '../validation.js'

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count'
export type GrepScanMode = 'exact' | 'fast'

export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: GrepOutputMode
  scan_mode?: GrepScanMode
  '-i'?: boolean
  '-n'?: boolean
  '-o'?: boolean
  '-A'?: number
  '-B'?: number
  '-C'?: number
  context?: number
  multiline?: boolean
  head_limit?: number
  offset?: number
}

const MAX_GREP_MATCHES_PER_FILE = 10_000
const MAX_GREP_ENTRIES = 10_000
const MAX_GREP_RESPONSE_CHARS = 1024 * 1024
// Retaining context must not use more text than the bounded response it can produce.
const MAX_GREP_CONTEXT_CHARS = MAX_GREP_RESPONSE_CHARS
// Multiline matching is deliberately exact, so its bounded whole-file buffer is stricter than normal streaming search.
const MAX_MULTILINE_FILE_BYTES = 1024 * 1024

type TruncationReason =
  | 'max_scan_bytes'
  | 'max_files'
  | 'max_duration_ms'
  | 'max_line_chars'
  | 'max_context_lines'
  | 'max_context_chars'
  | 'max_only_matches'
  | 'max_text_file_bytes'
  | 'max_multiline_file_bytes'
  | 'max_matches_per_file'
  | 'decode_error'
  | 'file_error'

const TYPE_GLOBS: Readonly<Record<string, string[]>> = {
  js: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  ts: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
  py: ['**/*.py', '**/*.pyi'],
  rust: ['**/*.rs'],
  go: ['**/*.go'],
  java: ['**/*.java'],
  c: ['**/*.c', '**/*.h'],
  cpp: ['**/*.cc', '**/*.cpp', '**/*.cxx', '**/*.hpp', '**/*.hh'],
  cs: ['**/*.cs'],
  json: ['**/*.json'],
  yaml: ['**/*.yaml', '**/*.yml'],
  toml: ['**/*.toml'],
  markdown: ['**/*.md', '**/*.markdown'],
  html: ['**/*.html', '**/*.htm'],
  css: ['**/*.css'],
  xml: ['**/*.xml'],
  sh: ['**/*.sh', '**/*.bash'],
}

export function parseGrepInput(value: unknown): GrepInput {
  assertObject(value)
  const allowed = ['pattern', 'path', 'glob', 'type', 'output_mode', 'scan_mode', '-i', '-n', '-o', '-A', '-B', '-C', 'context', 'multiline', 'head_limit', 'offset']
  rejectUnknown(value, allowed)
  const outputMode = optionalString(value, 'output_mode')
  if (outputMode !== undefined && !['content', 'files_with_matches', 'count'].includes(outputMode)) {
    throw new Error('output_mode must be content, files_with_matches, or count')
  }
  const scanMode = optionalString(value, 'scan_mode')
  if (scanMode !== undefined && !['exact', 'fast'].includes(scanMode)) {
    throw new Error('scan_mode must be exact or fast')
  }
  if (scanMode === 'fast' && outputMode !== undefined && outputMode !== 'files_with_matches') {
    throw new Error('scan_mode=fast is only supported with output_mode=files_with_matches')
  }
  const result: GrepInput = { pattern: requiredString(value, 'pattern') }
  for (const key of ['path', 'glob', 'type'] as const) {
    const item = optionalString(value, key)
    if (item !== undefined) result[key] = item
  }
  if (outputMode !== undefined) result.output_mode = outputMode as GrepOutputMode
  if (scanMode !== undefined) result.scan_mode = scanMode as GrepScanMode
  for (const key of ['-i', '-n', '-o', 'multiline'] as const) {
    const item = optionalBoolean(value, key)
    if (item !== undefined) result[key] = item
  }
  for (const [key, minimum] of [['-A', 0], ['-B', 0], ['-C', 0], ['context', 0], ['head_limit', 0], ['offset', 0]] as const) {
    const item = optionalInteger(value, key, minimum)
    if (item !== undefined) result[key] = item
  }
  return result
}

interface SearchFile {
  file: string
  context: ProjectFileContext
  size: number
}

class GrepBudget {
  readonly startedAt = Date.now()
  scannedFiles = 0
  scannedBytes = 0
  skippedFiles = 0
  private reason: TruncationReason | undefined
  private remainingOnlyMatches: number

  constructor(readonly limits: GrepLimits) {
    this.remainingOnlyMatches = limits.maxOnlyMatches
  }

  get truncationReason(): TruncationReason | undefined {
    return this.reason
  }

  get scanComplete(): boolean {
    return this.reason === undefined
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  stop(reason: TruncationReason): void {
    if (this.reason === undefined) this.reason = reason
  }

  checkTime(): boolean {
    if (this.reason !== undefined) return false
    if (this.elapsedMs > this.limits.maxDurationMs) {
      this.stop('max_duration_ms')
      return false
    }
    return true
  }

  startFile(size: number): boolean {
    if (!this.checkTime()) return false
    if (this.scannedFiles >= this.limits.maxFiles) {
      this.stop('max_files')
      return false
    }
    // Admit complete files only, so stream chunking cannot make byte accounting exceed the request budget.
    if (size > this.limits.maxScanBytes - this.scannedBytes) {
      this.stop('max_scan_bytes')
      return false
    }
    this.scannedFiles += 1
    return true
  }

  addBytes(bytes: number): boolean {
    if (!this.checkTime()) return false
    if (bytes > this.limits.maxScanBytes - this.scannedBytes) {
      this.stop('max_scan_bytes')
      return false
    }
    this.scannedBytes += bytes
    return true
  }

  consumeOnlyMatch(): boolean {
    if (!this.checkTime()) return false
    if (this.remainingOnlyMatches <= 0) {
      this.stop('max_only_matches')
      return false
    }
    this.remainingOnlyMatches -= 1
    return true
  }

  skip(reason: TruncationReason): void {
    this.skippedFiles += 1
    this.stop(reason)
  }
}

function contextForFile(context: ProjectFileContext, file: string): ProjectFileContext {
  return {
    ...context,
    absolutePath: file,
    encoding: resolveEncoding(file, context.rules),
  }
}

function createPathFilter(glob: string | undefined, type: string | undefined): (relative: string) => boolean {
  const globMatcher = glob === undefined ? undefined : picomatch(glob, { dot: true })
  const typePatterns = type === undefined ? undefined : TYPE_GLOBS[type]
  if (type !== undefined && typePatterns === undefined) throw new Error(`Unsupported file type: ${type}`)
  const typeMatchers = typePatterns?.map(pattern => picomatch(pattern, { dot: true }))
  return relative => (globMatcher === undefined || globMatcher(relative))
    && (typeMatchers === undefined || typeMatchers.some(matcher => matcher(relative)))
}

async function* iterateFiles(
  root: string,
  target: string,
  targetInfo: Stats,
  context: ProjectFileContext,
  matchesPath: (relative: string) => boolean,
): AsyncGenerator<SearchFile> {
  if (targetInfo.isFile()) {
    yield { file: target, context: contextForFile(context, target), size: targetInfo.size }
    return
  }
  if (!targetInfo.isDirectory()) throw new Error(`Path is not a file or directory: ${target}`)

  const visit = async function* (
    directory: string,
    relativeDirectory: string,
    activeContext: ProjectFileContext,
  ): AsyncGenerator<SearchFile> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    const directoryContext = entries.some(entry => entry.name === '.encoding-rules' && entry.isFile())
      && path.resolve(directory) !== activeContext.root
      ? await getProjectFileContext(path.join(directory, '.codepage-bridge-search-probe'))
      : activeContext
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      const absolute = path.join(directory, entry.name)
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const safe = await inspectProjectPath(directoryContext.root, absolute)
        const info = await stat(safe.target)
        if (info.isDirectory()) yield* visit(safe.target, relative, directoryContext)
      } else if (entry.isFile() && matchesPath(relative)) {
        const safe = await inspectProjectPath(directoryContext.root, absolute)
        const info = await stat(safe.target)
        if (info.isFile()) yield { file: safe.target, context: contextForFile(directoryContext, safe.target), size: info.size }
      }
    }
  }

  yield* visit(target, path.relative(root, target).split(path.sep).join('/'), context)
}

interface ResultState {
  entries: string[]
  count: number
  characters: number
  truncated: boolean
}

function responseState(): ResultState {
  return { entries: [], count: 0, characters: 0, truncated: false }
}

function appendEntry(state: ResultState, entry: string, offset: number, limit: number): boolean {
  return appendEntryParts(state, [entry], offset, limit)
}

function appendEntryParts(state: ResultState, parts: readonly string[], offset: number, limit: number): boolean {
  if (state.truncated) return false
  if (state.count >= offset && state.entries.length < limit) {
    const length = parts.reduce((total, part) => total + part.length, 0)
    if (state.characters + length > MAX_GREP_RESPONSE_CHARS) {
      state.truncated = true
      return false
    }
    state.entries.push(parts.join(''))
    state.characters += length + 1
  }
  state.count += 1
  return true
}

function* onlyMatches(line: string, expression: RegExp): IterableIterator<string> {
  const global = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`)
  for (const match of line.matchAll(global)) {
    if (match[0]) yield match[0]
  }
}

function testLine(line: string, expression: RegExp): boolean {
  expression.lastIndex = 0
  return expression.test(line)
}

function ensureLineLimit(line: string, budget: GrepBudget): void {
  if (line.length > budget.limits.maxLineChars) {
    budget.stop('max_line_chars')
    throw new Error('Grep line length limit exceeded')
  }
}

async function* readSearchableLines(file: SearchFile, budget: GrepBudget): AsyncGenerator<string> {
  const encoding = normalizeEncoding(file.context.encoding)
  const decoder = new TextDecoder(encoding, { fatal: true })
  let pending = ''
  let trailingCarriageReturn = false
  const joinPending = (line: string): string => {
    const complete = pending + line
    pending = ''
    ensureLineLimit(complete, budget)
    return complete
  }
  const consume = function* (decoded: string): Generator<string, string> {
    const lines = decoded.split('\n')
    const remainder = lines.pop() ?? ''
    for (const line of lines) yield joinPending(line)
    return remainder
  }
  try {
    for await (const chunk of createReadStream(file.file, { highWaterMark: 64 * 1024 })) {
      if (!budget.addBytes(chunk.length)) return
      let decoded = decoder.decode(chunk, { stream: true })
      if (trailingCarriageReturn && !decoded.startsWith('\n')) decoded = `\n${decoded}`
      trailingCarriageReturn = false
      if (decoded.endsWith('\r')) {
        decoded = decoded.slice(0, -1)
        trailingCarriageReturn = true
      }
      decoded = decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      const consumed = consume(decoded)
      let next = consumed.next()
      while (!next.done) {
        if (!budget.checkTime()) return
        yield next.value
        next = consumed.next()
      }
      pending += next.value
      ensureLineLimit(pending, budget)
    }
    let decoded = decoder.decode()
    if (trailingCarriageReturn && !decoded.startsWith('\n')) decoded = `\n${decoded}`
    decoded = decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    const consumed = consume(decoded)
    let next = consumed.next()
    while (!next.done) {
      if (!budget.checkTime()) return
      yield next.value
      next = consumed.next()
    }
    yield joinPending(next.value)
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`Invalid byte sequence for ${encoding}`, { cause: error })
    throw error
  }
}

function formatLine(file: string, line: number, text: string, direct: boolean, input: GrepInput, includeFile: boolean): string {
  const separator = direct ? ':' : '-'
  const number = input['-n'] ?? true
  return `${includeFile ? `${file}${separator}` : ''}${number ? `${line}${separator}` : ''}${text}`
}

function appendFormattedLine(
  state: ResultState,
  file: string,
  line: number,
  text: string,
  direct: boolean,
  input: GrepInput,
  includeFile: boolean,
  offset: number,
  limit: number,
): boolean {
  const separator = direct ? ':' : '-'
  return appendEntryParts(state, [
    includeFile ? `${file}${separator}` : '',
    input['-n'] ?? true ? `${line}${separator}` : '',
    text,
  ], offset, limit)
}

async function countLineMatches(file: SearchFile, expression: RegExp, budget: GrepBudget, firstOnly: boolean): Promise<number> {
  let matches = 0
  for await (const line of readSearchableLines(file, budget)) {
    if (!testLine(line, expression)) continue
    matches += 1
    if (firstOnly) return matches
    if (matches > MAX_GREP_MATCHES_PER_FILE) {
      throw new Error(`File has more than ${MAX_GREP_MATCHES_PER_FILE} matches. Narrow the search pattern.`)
    }
  }
  return matches
}

async function collectContent(
  file: SearchFile,
  expression: RegExp,
  input: GrepInput,
  includeFile: boolean,
  state: ResultState,
  offset: number,
  limit: number,
  budget: GrepBudget,
): Promise<number> {
  const context = input.context ?? input['-C']
  const before = context ?? input['-B'] ?? 0
  const after = context ?? input['-A'] ?? 0
  const previousLines: Array<{ line: number; text: string }> = []
  let previousLineChars = 0
  let previousOutputLine = 0
  let afterUntil = 0
  let matches = 0
  let lineNumber = 0
  const retainPreviousLine = (previous: { line: number; text: string }): void => {
    if (previousLines.length >= before) {
      const removed = previousLines.shift()
      previousLineChars -= removed?.text.length ?? 0
    }
    if (previous.text.length > MAX_GREP_CONTEXT_CHARS - previousLineChars) {
      budget.stop('max_context_chars')
      throw new Error(`Grep context storage limit exceeded (${MAX_GREP_CONTEXT_CHARS} characters)`)
    }
    previousLines.push(previous)
    previousLineChars += previous.text.length
  }

  for await (const line of readSearchableLines(file, budget)) {
    lineNumber += 1
    if (!budget.checkTime()) return matches
    const direct = testLine(line, expression)
    if (direct) {
      matches += 1
      if (matches > MAX_GREP_MATCHES_PER_FILE) {
        throw new Error(`File has more than ${MAX_GREP_MATCHES_PER_FILE} matches. Narrow the search pattern.`)
      }
      if (input['-o']) {
        for (const part of onlyMatches(line, expression)) {
          if (!budget.consumeOnlyMatch()) return matches
          appendEntryParts(state, [
            includeFile ? `${file.file}:` : '',
            input['-n'] ?? true ? `${lineNumber}:` : '',
            part,
          ], offset, limit)
        }
      } else {
        for (const previous of previousLines) {
          if (previousOutputLine > 0 && previous.line > previousOutputLine + 1) appendEntry(state, '--', offset, limit)
          appendFormattedLine(state, file.file, previous.line, previous.text, false, input, includeFile, offset, limit)
          previousOutputLine = previous.line
        }
        previousLines.length = 0
        previousLineChars = 0
        if (previousOutputLine > 0 && lineNumber > previousOutputLine + 1) appendEntry(state, '--', offset, limit)
        appendFormattedLine(state, file.file, lineNumber, line, true, input, includeFile, offset, limit)
        previousOutputLine = lineNumber
        afterUntil = Math.max(afterUntil, lineNumber + after)
      }
      continue
    }

    if (!input['-o'] && lineNumber <= afterUntil) {
      appendFormattedLine(state, file.file, lineNumber, line, false, input, includeFile, offset, limit)
      previousOutputLine = lineNumber
      continue
    }

    if (!input['-o'] && before > 0) {
      retainPreviousLine({ line: lineNumber, text: line })
    }
  }
  return matches
}

async function readMultilineFile(file: SearchFile, budget: GrepBudget): Promise<string> {
  if (file.size > MAX_MULTILINE_FILE_BYTES) {
    budget.stop('max_multiline_file_bytes')
    throw new Error(`Multiline search is limited to ${formatMebibytes(MAX_MULTILINE_FILE_BYTES)} per file to preserve exact matching`)
  }
  if (!budget.checkTime()) throw new Error('Grep duration limit exceeded')

  const chunks: Buffer[] = []
  let bytesRead = 0
  for await (const chunk of createReadStream(file.file, { highWaterMark: 64 * 1024 })) {
    if (chunk.length > MAX_MULTILINE_FILE_BYTES - bytesRead) {
      budget.stop('max_multiline_file_bytes')
      throw new Error(`Multiline search is limited to ${formatMebibytes(MAX_MULTILINE_FILE_BYTES)} per file to preserve exact matching`)
    }
    if (!budget.addBytes(chunk.length)) throw budgetError(budget.truncationReason)
    chunks.push(chunk)
    bytesRead += chunk.length
  }
  try {
    return decodeText(Buffer.concat(chunks, bytesRead), file.context.encoding).text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  } catch (error) {
    budget.stop('decode_error')
    throw error
  }
}

function collectMultilineContent(
  file: SearchFile,
  text: string,
  expression: RegExp,
  input: GrepInput,
  includeFile: boolean,
  state: ResultState,
  offset: number,
  limit: number,
  budget: GrepBudget,
): void {
  if (input['-o']) {
    for (const part of onlyMatches(text, expression)) {
      if (!budget.consumeOnlyMatch()) return
      appendEntry(state, `${includeFile ? `${file.file}:` : ''}${input['-n'] ?? true ? '1:' : ''}${part}`, offset, limit)
    }
    return
  }
  appendEntry(state, formatLine(file.file, 1, text, true, input, includeFile), offset, limit)
}

function validateContext(input: GrepInput, limits: GrepLimits): void {
  const context = input.context ?? input['-C']
  const before = context ?? input['-B'] ?? 0
  const after = context ?? input['-A'] ?? 0
  if (before + after > limits.maxContextLines) {
    throw new Error(`Requested context exceeds CODEPAGE_BRIDGE_MAX_GREP_CONTEXT_LINES (${limits.maxContextLines})`)
  }
}

function budgetError(reason: TruncationReason | undefined): Error {
  return new Error(`Grep search budget exceeded: ${reason ?? 'unknown'}`)
}

export async function executeGrep(input: GrepInput): Promise<ToolResponse> {
  const limits = grepLimits()
  validateContext(input, limits)
  const targetInput = path.resolve(input.path ?? process.cwd())
  const initialContext = await getProjectFileContext(targetInput)
  const safeTarget = await inspectProjectPath(initialContext.root, targetInput)
  const targetInfo = await stat(safeTarget.target)
  const targetContext = targetInfo.isDirectory()
    ? await getProjectFileContext(path.join(safeTarget.target, '.codepage-bridge-search-probe'))
    : initialContext
  const matchesPath = createPathFilter(input.glob, input.type)
  const files = iterateFiles(targetContext.root, safeTarget.target, targetInfo, targetContext, matchesPath)
  const explicitFile = targetInfo.isFile()
  const flags = `${input['-i'] ? 'i' : ''}${input.multiline ? 'ms' : ''}`
  let expression: RegExp
  try {
    expression = new RegExp(input.pattern, flags)
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const mode = input.output_mode ?? 'files_with_matches'
  const scanMode = input.scan_mode ?? 'exact'
  if (scanMode === 'fast' && mode !== 'files_with_matches') {
    throw new Error('scan_mode=fast is only supported with output_mode=files_with_matches')
  }
  const offset = input.offset ?? 0
  const requestedLimit = input.head_limit ?? 250
  const limit = requestedLimit === 0 ? MAX_GREP_ENTRIES : Math.min(requestedLimit, MAX_GREP_ENTRIES)
  const state = responseState()
  const budget = new GrepBudget(limits)
  let numFiles = 0
  let numMatches = 0

  for await (const file of files) {
    if (!budget.checkTime()) break
    if (file.size > maxTextFileBytes()) {
      budget.skip('max_text_file_bytes')
      if (explicitFile) {
        throw new Error(`Failed to search ${file.file}: File exceeds the ${formatMebibytes(maxTextFileBytes())} search limit. Set CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB to raise it.`)
      }
      continue
    }
    if (input.multiline && file.size > MAX_MULTILINE_FILE_BYTES) {
      budget.skip('max_multiline_file_bytes')
      if (explicitFile) throw new Error(`Failed to search ${file.file}: Multiline search is limited to ${formatMebibytes(MAX_MULTILINE_FILE_BYTES)} per file to preserve exact matching`)
      continue
    }
    if (!budget.startFile(file.size)) {
      budget.skippedFiles += 1
      if (explicitFile) throw new Error(`Failed to search ${file.file}: ${budgetError(budget.truncationReason).message}`)
      break
    }
    try {
      if (input.multiline) {
        const searchable = await readMultilineFile(file, budget)
        if (!testLine(searchable, expression)) continue
        numFiles += 1
        numMatches += 1
        if (mode === 'files_with_matches') appendEntry(state, file.file, offset, limit)
        else if (mode === 'count') appendEntry(state, `${file.file}:1`, offset, limit)
        else collectMultilineContent(file, searchable, expression, input, !explicitFile, state, offset, limit, budget)
        if (!budget.scanComplete) break
        continue
      }

      if (mode === 'content') {
        const fileMatches = await collectContent(file, expression, input, !explicitFile, state, offset, limit, budget)
        if (fileMatches > 0) {
          numFiles += 1
          numMatches += fileMatches
        }
      } else {
        const fileMatches = await countLineMatches(file, expression, budget, scanMode === 'fast')
        if (fileMatches > 0) {
          numFiles += 1
          numMatches += fileMatches
          appendEntry(state, mode === 'count' ? `${file.file}:${fileMatches}` : file.file, offset, limit)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (budget.truncationReason === undefined) {
        if (/Invalid byte sequence|Encoding/.test(message)) budget.stop('decode_error')
        else if (/more than .* matches/.test(message)) budget.stop('max_matches_per_file')
        else budget.stop('file_error')
      }
      if (explicitFile) {
        throw new Error(`Failed to search ${file.file}: ${budgetError(budget.truncationReason).message}: ${message}`, { cause: error })
      }
      budget.skippedFiles += 1
    }
    if (!budget.scanComplete) break
  }

  if (state.count > offset + state.entries.length) state.truncated = true
  if (requestedLimit === 0 && state.count >= MAX_GREP_ENTRIES) state.truncated = true
  const outputTruncated = state.truncated
  const notices: string[] = []
  if (outputTruncated) notices.push(`Showing results with pagination = limit: ${limit}, offset: ${offset}; output is capped for server stability`)
  if (!budget.scanComplete) notices.push(`Search incomplete: scanComplete=false; truncationReason=${budget.truncationReason ?? 'unknown'}`)
  const suffix = notices.length === 0
    ? ''
    : `${state.entries.length > 0 ? '\n\n' : ''}[${notices.join('] [')}]`
  const countsExact = scanMode === 'exact' && budget.scanComplete
  return {
    content: [{ type: 'text', text: `${state.entries.join('\n')}${suffix}` }],
    structuredContent: {
      mode,
      scanMode,
      numFiles,
      numMatches,
      entries: state.entries,
      scanComplete: budget.scanComplete,
      countsExact,
      outputTruncated,
      ...(budget.truncationReason === undefined ? {} : { truncationReason: budget.truncationReason }),
      scannedFiles: budget.scannedFiles,
      scannedBytes: budget.scannedBytes,
      skippedFiles: budget.skippedFiles,
      elapsedMs: budget.elapsedMs,
    },
  }
}
