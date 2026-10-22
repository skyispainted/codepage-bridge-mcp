#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'

import {
  EDIT_DESCRIPTION,
  EDIT_PROMPT,
  GREP_DESCRIPTION,
  GREP_PROMPT,
  READ_DESCRIPTION,
  READ_PROMPT,
  WRITE_DESCRIPTION,
  WRITE_PROMPT,
} from './prompts.js'
import {
  editInputSchema,
  grepInputSchema,
  readInputSchema,
  writeInputSchema,
} from './schemas.js'
import { executeEdit, parseEditInput } from './tools/edit.js'
import { executeGrep, parseGrepInput } from './tools/grep.js'
import { executeRead, parseReadInput } from './tools/read.js'
import { executeWrite, parseWriteInput } from './tools/write.js'
import type { ToolResponse } from './toolTypes.js'

export const toolDefinitions = [
  {
    name: 'Read',
    title: READ_DESCRIPTION,
    description: READ_PROMPT,
    inputSchema: readInputSchema,
  },
  {
    name: 'Edit',
    title: EDIT_DESCRIPTION,
    description: EDIT_PROMPT,
    inputSchema: editInputSchema,
  },
  {
    name: 'Write',
    title: WRITE_DESCRIPTION,
    description: WRITE_PROMPT,
    inputSchema: writeInputSchema,
  },  {
    name: 'Grep',
    title: GREP_DESCRIPTION,
    description: GREP_PROMPT,
    inputSchema: grepInputSchema,
  },
] as const

async function dispatch(name: string, input: unknown): Promise<ToolResponse> {
  switch (name) {
    case 'Read':
      return executeRead(parseReadInput(input))
    case 'Edit':
      return executeEdit(parseEditInput(input))
    case 'Write':
      return executeWrite(parseWriteInput(input))
    case 'Grep':
      return executeGrep(parseGrepInput(input))
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function toCallToolResult(response: ToolResponse): CallToolResult {
  return {
    content: response.content,
    ...(response.isError === undefined ? {} : { isError: response.isError }),
    ...(response.structuredContent === undefined ? {} : { structuredContent: response.structuredContent }),
  }
}

/**
 * The package version, reported to clients as the server version. Reading it
 * from package.json instead of a literal keeps the handshake honest across
 * releases. The manifest is found by climbing from this module, because the
 * compiled file sits one directory deeper than the source.
 */
function packageVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = path.join(directory, 'package.json')
    if (existsSync(manifest)) {
      const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
      if (typeof version !== 'string') throw new Error(`${manifest} has no version`)
      return version
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error('Could not find package.json for the server version')
    directory = parent
  }
}

const PACKAGE_VERSION = packageVersion()

export function createServer(): Server {
  const server = new Server(
    { name: 'codepage-bridge', version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...toolDefinitions] }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return toCallToolResult(await dispatch(request.params.name, request.params.arguments ?? {}))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        isError: true,
        content: [{ type: 'text', text: `<tool_use_error>${message}</tool_use_error>` }],
      }
    }
  })
  return server
}

export async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await server.close()
  }
  process.stdin.on('end', () => void close())
  process.stdin.on('error', error => {
    console.error(error)
    void close()
  })
  await server.connect(transport)
}

export function isMainModule(moduleUrl: string, entryPath = process.argv[1]): boolean {
  if (entryPath === undefined) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath)
  } catch {
    return false
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
