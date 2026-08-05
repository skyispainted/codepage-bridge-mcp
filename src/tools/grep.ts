import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import picomatch from 'picomatch'

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

const MAX_GREP_FILES = 10_000
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

async function collectFiles(root: string, target: string, glob: string | undefined, type: string | undefined): Promise<string[]> {
  const info = await stat(target)
  if (info.isFile()) return [target]
  if (!info.isDirectory()) throw new Error(`Path is not a file or directory: ${target}`)
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && matchesGlob(relative, glob) && matchesType(relative, type)) {
        files.push(absolute)
        if (files.length > MAX_GREP_FILES) {
          throw new Error(`Search matches more than ${MAX_GREP_FILES} files. Narrow path, glob, or type.`)
        }
      }
    }
  }
  await visit(target)
  return files.sort()
}

interface LineMatch {
  line: number
  text: string
  only?: string[]
}

function searchLines(text: string, expression: RegExp, onlyMatching: boolean): LineMatch[] {
  const lines = text.split('\n')
  const matches: LineMatch[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    expression.lastIndex = 0
    if (!expression.test(line)) continue
    if (matches.length >= MAX_GREP_MATCHES_PER_FILE) {
      throw new Error(`File has more than ${MAX_GREP_MATCHES_PER_FILE} matches. Narrow the search pattern.`)
    }
    if (onlyMatching) {
      const global = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`)
      const only = [...line.matchAll(global)].map(match => match[0]).filter(Boolean)
      matches.push({ line: index + 1, text: line, only })
    } else matches.push({ line: index + 1, text: line })
  }
  return matches
}

function findMatches(text: string, expression: RegExp, input: GrepInput): LineMatch[] {
  if (!input.multiline) return searchLines(text, expression, input['-o'] ?? false)
  expression.lastIndex = 0
  return expression.test(text) ? [{ line: 1, text }] : []
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
  const snapshot = await readDecodedFile(context)
  return snapshot.text
}

function appendEntries(
  source: string[],
  selected: string[],
  offset: number,
  limit: number,
  count: { value: number },
  characters: { value: number },
): boolean {
  for (const entry of source) {
    if (count.value >= offset && selected.length < limit) {
      if (characters.value + entry.length > MAX_GREP_RESPONSE_CHARS) return false
      selected.push(entry)
      characters.value += entry.length + 1
    }
    count.value += 1
  }
  return true
}

export async function executeGrep(input: GrepInput): Promise<ToolResponse> {
  const targetInput = path.resolve(input.path ?? process.cwd())
  const targetInfo = await stat(targetInput)
  const targetContext = await getProjectFileContext(
    targetInfo.isDirectory() ? path.join(targetInput, '.codepage-bridge-search-probe') : targetInput,
  )
  const files = await collectFiles(targetContext.root, targetInput, input.glob, input.type)
  const explicitFile = targetInfo.isFile()
  const flags = `${input['-i'] ? 'i' : ''}${input.multiline ? 'ms' : ''}`
  let expression: RegExp
  try {
    expression = new RegExp(input.pattern, flags)
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const matched: Array<{ file: string; count: number }> = []
  for (const file of files) {
    try {
      const searchable = await readSearchableFile(file)
      const matches = findMatches(searchable, expression, input)
      if (matches.length > 0) matched.push({ file, count: matches.length })
    } catch (error) {
      if (explicitFile) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to search ${file}: ${message}`, { cause: error })
      }
    }
  }

  const mode = input.output_mode ?? 'files_with_matches'
  const offset = input.offset ?? 0
  const requestedLimit = input.head_limit ?? 250
  const limit = requestedLimit === 0 ? MAX_GREP_ENTRIES : Math.min(requestedLimit, MAX_GREP_ENTRIES)
  const entries: string[] = []
  const count = { value: 0 }
  const characters = { value: 0 }
  let truncated = false

  if (mode === 'files_with_matches') {
    truncated = !appendEntries(matched.map(result => result.file), entries, offset, limit, count, characters)
  } else if (mode === 'count') {
    truncated = !appendEntries(matched.map(result => `${result.file}:${result.count}`), entries, offset, limit, count, characters)
  } else {
    for (const result of matched) {
      const searchable = await readSearchableFile(result.file)
      const matches = findMatches(searchable, expression, input)
      if (!appendEntries(
        formatContent(result.file, searchable, matches, input, !explicitFile),
        entries,
        offset,
        limit,
        count,
        characters,
      )) {
        truncated = true
        break
      }
    }
  }

  if (count.value > offset + entries.length) truncated = true
  if (requestedLimit === 0 && count.value >= MAX_GREP_ENTRIES) truncated = true
  const suffix = truncated
    ? `\n\n[Showing results with pagination = limit: ${limit}, offset: ${offset}; output is capped for server stability]`
    : ''
  return {
    content: [{ type: 'text', text: `${entries.join('\n')}${suffix}` }],
    structuredContent: {
      mode,
      numFiles: matched.length,
      numMatches: matched.reduce((sum, result) => sum + result.count, 0),
      entries,
    },
  }
}
