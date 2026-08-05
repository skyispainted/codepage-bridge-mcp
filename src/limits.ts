const BYTES_PER_MEBIBYTE = 1024 * 1024
const DEFAULT_MAX_TEXT_FILE_MEBIBYTES = 32

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function maxTextFileBytes(): number {
  const mebibytes = parsePositiveInteger(process.env.CODEPAGE_BRIDGE_MAX_TEXT_FILE_MIB)
    ?? DEFAULT_MAX_TEXT_FILE_MEBIBYTES
  return mebibytes * BYTES_PER_MEBIBYTE
}

export function formatMebibytes(bytes: number): string {
  return `${bytes / BYTES_PER_MEBIBYTE} MiB`
}
