import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { encodeText, detectDominantNewline } from '../encoding/index.js'
import {
  getProjectFileContext,
  describeNewline,
  encodeSnapshotText,
  normalizeNewlines,
  readDecodedFile,
  readRegistry,
} from '../core.js'
import { atomicWriteBuffer } from '../filesystem/index.js'
import type { ToolResponse, WriteInput } from '../toolTypes.js'
import { assertObject, rejectUnknown, requiredString } from '../validation.js'

export function parseWriteInput(value: unknown): WriteInput {
  assertObject(value)
  rejectUnknown(value, ['file_path', 'content'])
  return {
    file_path: requiredString(value, 'file_path'),
    content: requiredString(value, 'content'),
  }
}

export async function executeWrite(input: WriteInput): Promise<ToolResponse> {
  // Content arrives newline-normalized so the model can send either
  // convention; the file's own line ending is restored when it is encoded.
  // A new file has no style yet, so the model's own line ending is used: read
  // it before normalization erases the difference.
  const requestedNewline = detectDominantNewline(input.content)
  const content = normalizeNewlines(input.content)
  const context = await getProjectFileContext(input.file_path)
  let exists = true
  try {
    await stat(context.absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }

  await mkdir(path.dirname(context.absolutePath), { recursive: true })
  if (!exists) {
    const newline = requestedNewline
    const buffer = encodeText(content, context.encoding, { newline })
    await atomicWriteBuffer(context.root, context.absolutePath, buffer)
    const info = await stat(context.absolutePath)
    const snapshot = {
      absolutePath: context.absolutePath,
      root: context.root,
      encoding: context.encoding,
      text: '',
      bom: null,
      newline,
      mtimeMs: 0,
      size: 0,
      hash: '',
      complete: true,
    } as const
    readRegistry.updateAfterWrite(snapshot, content, buffer, info.mtimeMs)
    return {
      content: [{
        type: 'text',
        text: `File created successfully at: ${context.absolutePath} (${snapshot.encoding}, ${describeNewline(newline)} line endings).`,
      }],
    }
  }

  const readSnapshot = readRegistry.get(context.absolutePath)
  if (!readSnapshot) throw new Error('File has not been read. Read it before attempting to write it.')
  const current = await readDecodedFile(context)
  if (current.hash !== readSnapshot.hash || current.mtimeMs !== readSnapshot.mtimeMs) {
    throw new Error('File has been unexpectedly modified. Read it again before attempting to write it.')
  }

  const buffer = encodeSnapshotText(current, content)
  await atomicWriteBuffer(context.root, context.absolutePath, buffer, {
    expected: { mtimeMs: current.mtimeMs, hash: current.hash },
  })
  const info = await stat(context.absolutePath)
  readRegistry.updateAfterWrite(current, content, buffer, info.mtimeMs)
  return {
    content: [{
      type: 'text',
      text: `The file ${context.absolutePath} has been updated successfully (${current.encoding}, ${describeNewline(current.newline)} line endings preserved).`,
    }],
  }
}
