import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { inspectProjectPath } from "./path.js";

export interface FileVersion {
  mtimeMs: number;
  size: number;
  hash: string;
}

export interface BufferReadState extends FileVersion {
  buffer: Buffer;
  partial: boolean;
  offset: number;
  totalSize: number;
}

export interface ReadBufferOptions {
  offset?: number;
  length?: number;
}

interface CacheEntry extends FileVersion {
  buffer: Buffer;
}

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class FileStateCache {
  private readonly entries = new Map<string, CacheEntry>();

  clear(filePath?: string): void {
    if (filePath === undefined) this.entries.clear();
    else this.entries.delete(filePath);
  }

  async read(root: string, input: string, options: ReadBufferOptions = {}): Promise<BufferReadState> {
    const safe = await inspectProjectPath(root, input);
    const info = await stat(safe.target);
    const buffer = await readFile(safe.target);
    const entry = { buffer, mtimeMs: info.mtimeMs, size: buffer.length, hash: digest(buffer) };
    this.entries.set(safe.target, entry);
    const offset = options.offset ?? 0;
    const length = options.length ?? entry.buffer.length - offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new Error("offset and length must be non-negative safe integers");
    }
    const end = Math.min(entry.buffer.length, offset + length);
    const selectedBuffer = Buffer.from(entry.buffer.subarray(Math.min(offset, entry.buffer.length), end));
    return {
      buffer: selectedBuffer,
      partial: offset !== 0 || end !== entry.buffer.length,
      offset,
      totalSize: entry.buffer.length,
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      hash: entry.hash,
    };
  }
}

export const fileStateCache = new FileStateCache();
