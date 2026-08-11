import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import picomatch from 'picomatch'

import { normalizeEncoding } from '../encoding/index.js'
import { inspectProjectPath } from '../filesystem/index.js'
import { maxTextFileBytes, formatMebibytes } from '../limits.js'
import { getProjectFileContext, readDecodedFile } from '../core.js'
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

export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: GrepOutputMode
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
  const allowed = ['pattern', 'path', 'glob', 'type', 'output_mode', '-i', '-n', '-o', '-A', '-B', '-C', 'context', 'multiline', 'head_limit', 'offset']
  rejectUnknown(value, allowed)
  const outputMode = optionalString(value, 'output_mode')
  if (outputMode !== undefined && !['content', 'files_with_matches', 'count'].includes(outputMode)) {
    throw new Error('output_mode must be content, files_with_matches, or count')
  }
  const result: GrepInput = { pattern: requiredString(value, 'pattern') }
  for (const key of ['path', 'glob', 'type'] as const) {
    const item = optionalString(value, key)
    if (item !== undefined) result[key] = item
  }
  if (outputMode !== undefined) result.output_mode = outputMode as GrepOutputMode
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

function matchesType(relative: string, type: string | undefined): boolean {
  if (!type) return true
  const patterns = TYPE_GLOBS[type]
  if (!patterns) throw new Error(`Unsupported file type: ${type}`)
  return patterns.some(pattern => picomatch.isMatch(relative, pattern, { dot: true }))
}

function matchesGlob(relative: string, glob: string | undefined): boolean {
  return glob === undefined || picomatch.isMatch(relative, glob, { dot: true })
}

async function* iterateFiles(root: string, target: string, glob: string | undefined, type: string | undefined): AsyncGenerator<string> {
  const info = await stat(target)
  if (info.isFile()) {
    yield target
    return
  }
  if (!info.isDirectory()) throw new Error(`Path is not a file or directory: ${target}`)

  const visit = async function* (directory: string): AsyncGenerator<string> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) yield* visit(absolute)
      else if (entry.isFile() && matchesGlob(relative, glob) && matchesType(relative, type)) yield absolute
    }
  }

  yield* visit(target)
}

interface LineMatch {
  line: number
  text: string
  only?: string[]
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
  if (state.truncated) return false
  if (state.count >= offset && state.entries.length < limit) {
    if (state.characters + entry.length > MAX_GREP_RESPONSE_CHARS) {
      state.truncated = true
      return false
    }
    state.entries.push(entry)
    state.characters += entry.length + 1
  }
  state.count += 1
  return true
}

function onlyMatches(line: string, expression: RegExp): string[] {
  const global = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`)
  return [...line.matchAll(global)].map(match => match[0]).filter(Boolean)
}

function testLine(line: string, expression: RegExp): boolean {
  expression.lastIndex = 0
  return expression.test(line)
}

async function* readSearchableLines(file: string): AsyncGenerator<string> {
  const context = await getProjectFileContext(file)
  const safe = await inspectProjectPath(context.root, file)
  const info = await stat(safe.target)
  const maximumBytes = maxTextFileBytes()
  if (info.size > maximumBytes) {
    throw new Error(
      `File exceeds the ${formatMebibytes(maximumBytes)} search limit. Set CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB to raise it.`,
    )
  }

  const encoding = normalizeEncoding(context.encoding)
  const decoder = new TextDecoder(encoding, { fatal: true })
  let pending = ''
  let trailingCarriageReturn = false
  try {
    for await (const chunk of createReadStream(safe.target)) {
      let decoded = decoder.decode(chunk, { stream: true })
      if (trailingCarriageReturn) {
        decoded = `${decoded.startsWith('\n') ? '' : '\n'}${decoded}`
        trailingCarriageReturn = false
      }
      if (decoded.endsWith('\r')) {
        decoded = decoded.slice(0, -1)
        trailingCarriageReturn = true
      }
      decoded = decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      const lines = `${pending}${decoded}`.split('\n')
      pending = lines.pop() ?? ''
      yield* lines
    }
    let decoded = decoder.decode()
    if (trailingCarriageReturn) decoded = `${decoded.startsWith('\n') ? '' : '\n'}${decoded}`
    decoded = decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    for (const line of `${pending}${decoded}`.split('\n')) yield line
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`Invalid byte sequence for ${encoding}`, { cause: error })
    throw error
  }
}

async function countLineMatches(file: string, expression: RegExp): Promise<number> {
  let matches = 0
  for await (const line of readSearchableLines(file)) {
    if (!testLine(line, expression)) continue
    matches += 1
    if (matches > MAX_GREP_MATCHES_PER_FILE) {
      throw new Error(`File has more than ${MAX_GREP_MATCHES_PER_FILE} matches. Narrow the search pattern.`)
    }
  }
  return matches
}

function formatLine(file: string, line: number, text: string, direct: boolean, input: GrepInput, includeFile: boolean): string {
  const separator = direct ? ':' : '-'
  const number = input['-n'] ?? true
  return `${includeFile ? `${file}${separator}` : ''}${number ? `${line}${separator}` : ''}${text}`
}

async function collectContent(
  file: string,
  expression: RegExp,
  input: GrepInput,
  includeFile: boolean,
  state: ResultState,
  offset: number,
  limit: number,
): Promise<number> {
  const context = input.context ?? input['-C']
  const before = context ?? input['-B'] ?? 0
  const after = context ?? input['-A'] ?? 0
  const previousLines: Array<{ line: number; text: string }> = []
  let previousOutputLine = 0
  let afterUntil = 0
  let matches = 0
  let lineNumber = 0

  for await (const line of readSearchableLines(file)) {
    lineNumber += 1
    const direct = testLine(line, expression)
    if (direct) {
      matches += 1
      if (matches > MAX_GREP_MATCHES_PER_FILE) {
        throw new Error(`File has more than ${MAX_GREP_MATCHES_PER_FILE} matches. Narrow the search pattern.`)
      }
      if (input['-o']) {
        for (const part of onlyMatches(line, expression)) {
          appendEntry(state, `${includeFile ? `${file}:` : ''}${input['-n'] ?? true ? `${lineNumber}:` : ''}${part}`, offset, limit)
        }
      } else {
        for (const previous of previousLines) {
          if (previousOutputLine > 0 && previous.line > previousOutputLine + 1) appendEntry(state, '--', offset, limit)
          appendEntry(state, formatLine(file, previous.line, previous.text, false, input, includeFile), offset, limit)
          previousOutputLine = previous.line
        }
        previousLines.length = 0
        if (previousOutputLine > 0 && lineNumber > previousOutputLine + 1) appendEntry(state, '--', offset, limit)
        appendEntry(state, formatLine(file, lineNumber, line, true, input, includeFile), offset, limit)
        previousOutputLine = lineNumber
        afterUntil = Math.max(afterUntil, lineNumber + after)
      }
      continue
    }

    if (!input['-o'] && lineNumber <= afterUntil) {
      appendEntry(state, formatLine(file, lineNumber, line, false, input, includeFile), offset, limit)
      previousOutputLine = lineNumber
      continue
    }

    if (!input['-o'] && before > 0) {
      previousLines.push({ line: lineNumber, text: line })
      if (previousLines.length > before) previousLines.shift()
    }
  }
  return matches
}

function searchLines(text: string, expression: RegExp, onlyMatching: boolean): LineMatch[] {
  const lines = text.split('\n')
  const matches: LineMatch[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!testLine(line, expression)) continue
    if (matches.length >= MAX_GREP_MATCHES_PER_FILE) {
      throw new Error(`File has more than ${MAX_GREP_MATCHES_PER_FILE} matches. Narrow the search pattern.`)
    }
    matches.push({
      line: index + 1,
      text: line,
      ...(onlyMatching ? { only: onlyMatches(line, expression) } : {}),
    })
  }
  return matches
}

function formatContent(file: string, text: string, matches: LineMatch[], input: GrepInput, includeFile: boolean): string[] {
  const lines = text.split('\n')
  const context = input.context ?? input['-C']
  const before = context ?? input['-B'] ?? 0
  const after = context ?? input['-A'] ?? 0
  const withNumbers = input['-n'] ?? true
  const output: string[] = []
  if (input['-o']) {
    for (const match of matches) {
      for (const part of match.only ?? []) output.push(`${includeFile ? `${file}:` : ''}${withNumbers ? `${match.line}:` : ''}${part}`)
    }
    return output
  }
  const selected = new Map<number, boolean>()
  for (const match of matches) {
    for (let line = Math.max(1, match.line - before); line <= Math.min(lines.length, match.line + after); line += 1) {
      selected.set(line, selected.get(line) === true || line === match.line)
    }
  }
  let previous = 0
  for (const [line, direct] of [...selected.entries()].sort((left, right) => left[0] - right[0])) {
    if (previous > 0 && line > previous + 1) output.push('--')
    const separator = direct ? ':' : '-'
    output.push(`${includeFile ? `${file}${separator}` : ''}${withNumbers ? `${line}${separator}` : ''}${lines[line - 1] ?? ''}`)
    previous = line
  }
  return output
}

async function readSearchableFile(file: string): Promise<string> {
  const info = await stat(file)
  const maximumBytes = maxTextFileBytes()
  if (info.size > maximumBytes) {
    throw new Error(
      `File exceeds the ${formatMebibytes(maximumBytes)} search limit. Set CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB to raise it.`,
    )
  }
  const context = await getProjectFileContext(file)
  return (await readDecodedFile(context)).text
}

function appendEntries(state: ResultState, source: Iterable<string>, offset: number, limit: number): void {
  for (const entry of source) appendEntry(state, entry, offset, limit)
}

export async function executeGrep(input: GrepInput): Promise<ToolResponse> {
  const targetInput = path.resolve(input.path ?? process.cwd())
  const targetInfo = await stat(targetInput)
  const targetContext = await getProjectFileContext(
    targetInfo.isDirectory() ? path.join(targetInput, '.codepage-bridge-search-probe') : targetInput,
  )
  const files = iterateFiles(targetContext.root, targetInput, input.glob, input.type)
  const explicitFile = targetInfo.isFile()
  const flags = `${input['-i'] ? 'i' : ''}${input.multiline ? 'ms' : ''}`
  let expression: RegExp
  try {
    expression = new RegExp(input.pattern, flags)
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const mode = input.output_mode ?? 'files_with_matches'
  const offset = input.offset ?? 0
  const requestedLimit = input.head_limit ?? 250
  const limit = requestedLimit === 0 ? MAX_GREP_ENTRIES : Math.min(requestedLimit, MAX_GREP_ENTRIES)
  const state = responseState()
  let numFiles = 0
  let numMatches = 0

  for await (const file of files) {
    try {
      if (input.multiline) {
        const searchable = await readSearchableFile(file)
        expression.lastIndex = 0
        if (!expression.test(searchable)) continue
        numFiles += 1
        numMatches += 1
        if (mode === 'files_with_matches') appendEntry(state, file, offset, limit)
        else if (mode === 'count') appendEntry(state, `${file}:1`, offset, limit)
        else appendEntries(state, formatContent(file, searchable, [{ line: 1, text: searchable }], input, !explicitFile), offset, limit)
        continue
      }

      if (mode === 'content') {
        const fileMatches = await collectContent(file, expression, input, !explicitFile, state, offset, limit)
        if (fileMatches > 0) {
          numFiles += 1
          numMatches += fileMatches
        }
        continue
      }

      const fileMatches = await countLineMatches(file, expression)
      if (fileMatches === 0) continue
      numFiles += 1
      numMatches += fileMatches
      appendEntry(state, mode === 'count' ? `${file}:${fileMatches}` : file, offset, limit)
    } catch (error) {
      if (explicitFile) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to search ${file}: ${message}`, { cause: error })
      }
    }
  }

  if (state.count > offset + state.entries.length) state.truncated = true
  if (requestedLimit === 0 && state.count >= MAX_GREP_ENTRIES) state.truncated = true
  const suffix = state.truncated
    ? `\n\n[Showing results with pagination = limit: ${limit}, offset: ${offset}; output is capped for server stability]`
    : ''
  return {
    content: [{ type: 'text', text: `${state.entries.join('\n')}${suffix}` }],
    structuredContent: {
      mode,
      numFiles,
      numMatches,
      entries: state.entries,
    },
  }
}
