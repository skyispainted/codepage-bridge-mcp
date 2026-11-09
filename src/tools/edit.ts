import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  getProjectFileContext,
  describeNewline,
  encodeSnapshotText,
  normalizeNewlines,
  readDecodedFile,
  readRegistry,
} from '../core.js'
import { detectDominantNewline } from '../encoding/index.js'
import { atomicWriteBuffer } from '../filesystem/index.js'
import type { EditInput, ToolResponse } from '../toolTypes.js'
import {
  assertObject,
  optionalBoolean,
  rejectUnknown,
  requiredString,
} from '../validation.js'

const MAX_EDIT_BYTES = 1024 * 1024 * 1024
const SMART_QUOTES = new Map<string, string>([
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
])

export function parseEditInput(value: unknown): EditInput {
  assertObject(value)
  rejectUnknown(value, ['file_path', 'old_string', 'new_string', 'replace_all'])
  const replace_all = optionalBoolean(value, 'replace_all')
  return {
    file_path: requiredString(value, 'file_path'),
    old_string: requiredString(value, 'old_string'),
    new_string: requiredString(value, 'new_string'),
    ...(replace_all === undefined ? {} : { replace_all }),
  }
}

function normalizeQuotes(text: string): string {
  return [...text].map(character => SMART_QUOTES.get(character) ?? character).join('')
}

interface QuoteMatch {
  index: number
  actual: string
}

function lineRangeForMatch(content: string, match: QuoteMatch): { startLine: number; endLine: number } {
  const startLine = content.slice(0, match.index).split('\n').length
  const endLine = startLine + match.actual.split('\n').length - 1
  return { startLine, endLine }
}

function findQuoteMatches(content: string, search: string): QuoteMatch[] {
  const matches: QuoteMatch[] = []
  const normalizedSearch = normalizeQuotes(search)
  for (let index = 0; index <= content.length - search.length; index += 1) {
    const candidate = content.slice(index, index + search.length)
    if (normalizeQuotes(candidate) === normalizedSearch) {
      matches.push({ index, actual: candidate })
      index += Math.max(0, search.length - 1)
    }
  }
  return matches
}

function adaptReplacementQuotes(replacement: string, actual: string, requested: string): string {
  const style = new Map<string, string>()
  for (let index = 0; index < Math.min(actual.length, requested.length); index += 1) {
    const normalized = normalizeQuotes(requested[index] ?? '')
    const actualCharacter = actual[index]
    if ((normalized === "'" || normalized === '"') && actualCharacter) {
      style.set(normalized, actualCharacter)
    }
  }
  return [...replacement].map(character => style.get(normalizeQuotes(character)) ?? character).join('')
}

function replaceText(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  matches = findQuoteMatches(content, oldString),
): { content: string; actual: string; count: number } {
  if (matches.length === 0) throw new Error('old_string not found in file')
  if (matches.length > 1 && !replaceAll) {
    throw new Error(`Found ${matches.length} matches of old_string. Provide more surrounding context or set replace_all to true.`)
  }

  const selected = replaceAll ? matches : matches.slice(0, 1)
  let next = content
  for (const match of [...selected].reverse()) {
    const replacement = adaptReplacementQuotes(newString, match.actual, oldString)
    let end = match.index + match.actual.length
    if (replacement.length === 0 && !match.actual.endsWith('\n') && next[end] === '\n') end += 1
    next = `${next.slice(0, match.index)}${replacement}${next.slice(end)}`
  }
  return { content: next, actual: matches[0]!.actual, count: matches.length }
}

export async function executeEdit(input: EditInput): Promise<ToolResponse> {
  // The model edits the newline-normalized text Read displayed, so either
  // convention is accepted here; the file's own style is restored on encode.
  // A new file has no style yet, so the model's own choice is used, which is
  // why it is captured before normalization erases the difference.
  const requestedNewline = detectDominantNewline(input.new_string)
  const oldString = normalizeNewlines(input.old_string)
  const newString = normalizeNewlines(input.new_string)
  if (oldString === newString) throw new Error('old_string and new_string must be different')
  if (path.extname(input.file_path).toLowerCase() === '.ipynb') {
    throw new Error('Editing Jupyter notebooks is not supported')
  }

  const context = await getProjectFileContext(input.file_path)
  let exists = true
  try {
    const info = await stat(context.absolutePath)
    if (info.size > MAX_EDIT_BYTES) throw new Error('File exceeds the 1 GiB edit limit')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }

  if (!exists) {
    if (oldString !== '') throw new Error(`File does not exist: ${input.file_path}`)
    await mkdir(path.dirname(context.absolutePath), { recursive: true })
    const snapshot = {
      absolutePath: context.absolutePath,
      root: context.root,
      encoding: context.encoding,
      text: '',
      bom: null,
      newline: requestedNewline,
      mtimeMs: 0,
      size: 0,
      hash: '',
      complete: true,
    } as const
    const buffer = encodeSnapshotText(snapshot, newString)
    await atomicWriteBuffer(context.root, context.absolutePath, buffer)
    const info = await stat(context.absolutePath)
    readRegistry.updateAfterWrite(snapshot, newString, buffer, info.mtimeMs)
    return {
      content: [{
        type: 'text',
        text: `The file ${context.absolutePath} has been created successfully (${snapshot.encoding}, ${describeNewline(requestedNewline)} line endings).`,
      }],
    }
  }

  const current = await readDecodedFile(context)
  if (oldString === '' && current.text.trim().length > 0) {
    throw new Error('Cannot use an empty old_string to overwrite a non-empty file')
  }
  const matches = oldString === '' ? [] : findQuoteMatches(current.text, oldString)
  if (oldString !== '' && matches.length === 0) throw new Error('old_string not found in file')
  if (matches.length > 1 && !(input.replace_all ?? false)) {
    throw new Error(`Found ${matches.length} matches of old_string. Provide more surrounding context or set replace_all to true.`)
  }
  const selectedMatches = input.replace_all ? matches : matches.slice(0, 1)
  const authorization = readRegistry.authorizeEdit(
    context.absolutePath,
    current.hash,
    selectedMatches.map(match => lineRangeForMatch(current.text, match)),
  )
  if (authorization.status === 'unread') {
    throw new Error('File has not been read. Read the target lines before attempting to edit them.')
  }
  if (authorization.status === 'changed') {
    throw new Error('File has been unexpectedly modified. Read the target lines again before attempting to write it.')
  }
  if (authorization.status === 'uncovered') {
    const ranges = authorization.missing
      .map(range => range.startLine === range.endLine ? String(range.startLine) : `${range.startLine}-${range.endLine}`)
      .join(', ')
    throw new Error(`The target text has not been read. Read line range(s) ${ranges} before attempting this edit.`)
  }

  const result = oldString === ''
    ? { content: newString, actual: '', count: 1 }
    : replaceText(current.text, oldString, newString, input.replace_all ?? false, matches)
  const buffer = encodeSnapshotText(current, result.content)
  await atomicWriteBuffer(context.root, context.absolutePath, buffer, {
    expected: { mtimeMs: current.mtimeMs, hash: current.hash },
  })
  const info = await stat(context.absolutePath)
  readRegistry.updateAfterWrite(current, result.content, buffer, info.mtimeMs)

  return {
    content: [{
      type: 'text',
      text: `The file ${context.absolutePath} has been updated successfully (${current.encoding}, ${describeNewline(current.newline)} line endings preserved).`,
    }],
  }
}
