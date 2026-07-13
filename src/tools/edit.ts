import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { getProjectFileContext, encodeSnapshotText, readDecodedFile, readRegistry } from '../core.js'
import { createStructuredPatch } from '../diff.js'
import { atomicWriteBuffer, inspectProjectPath } from '../filesystem/index.js'
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
): { content: string; actual: string; count: number } {
  const matches = findQuoteMatches(content, oldString)
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
  if (input.old_string === input.new_string) throw new Error('old_string and new_string must be different')
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
    if (input.old_string !== '') throw new Error(`File does not exist: ${input.file_path}`)
    await mkdir(path.dirname(context.absolutePath), { recursive: true })
    const snapshot = {
      absolutePath: context.absolutePath,
      root: context.root,
      encoding: context.encoding,
      text: '',
      bom: null,
      newline: null,
      mtimeMs: 0,
      size: 0,
      hash: '',
      complete: true,
    } as const
    const buffer = encodeSnapshotText(snapshot, input.new_string)
    await atomicWriteBuffer(context.root, context.absolutePath, buffer)
    const info = await stat(context.absolutePath)
    readRegistry.updateAfterWrite(snapshot, input.new_string, buffer, info.mtimeMs)
    return {
      content: [{ type: 'text', text: `The file ${context.absolutePath} has been created successfully.` }],
      structuredContent: {
        filePath: context.absolutePath,
        oldString: '',
        newString: input.new_string,
        originalFile: '',
        structuredPatch: createStructuredPatch(context.absolutePath, '', input.new_string),
        userModified: false,
        replaceAll: false,
      },
    }
  }

  const readSnapshot = readRegistry.get(context.absolutePath)
  if (!readSnapshot) throw new Error('File has not been read. Read it before attempting to edit it.')
  const current = await readDecodedFile(context)
  if (current.hash !== readSnapshot.hash || current.mtimeMs !== readSnapshot.mtimeMs) {
    if (current.text !== readSnapshot.text) {
      throw new Error('File has been unexpectedly modified. Read it again before attempting to write it.')
    }
  }
  if (input.old_string === '' && current.text.trim().length > 0) {
    throw new Error('Cannot use an empty old_string to overwrite a non-empty file')
  }

  const result = input.old_string === ''
    ? { content: input.new_string, actual: '', count: 1 }
    : replaceText(current.text, input.old_string, input.new_string, input.replace_all ?? false)
  const buffer = encodeSnapshotText(current, result.content)
  await atomicWriteBuffer(context.root, context.absolutePath, buffer, {
    expected: { mtimeMs: current.mtimeMs, hash: current.hash },
  })
  const info = await stat(context.absolutePath)
  readRegistry.updateAfterWrite(current, result.content, buffer, info.mtimeMs)

  return {
    content: [{ type: 'text', text: `The file ${context.absolutePath} has been updated successfully.` }],
    structuredContent: {
      filePath: context.absolutePath,
      oldString: result.actual,
      newString: input.new_string,
      originalFile: current.text,
      structuredPatch: createStructuredPatch(context.absolutePath, current.text, result.content),
      userModified: false,
      replaceAll: input.replace_all ?? false,
    },
  }
}
