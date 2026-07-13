import { structuredPatch } from 'diff'

export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export function createStructuredPatch(filePath: string, before: string, after: string): PatchHunk[] {
  return structuredPatch(filePath, filePath, before, after, '', '').hunks.map(hunk => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }))
}
