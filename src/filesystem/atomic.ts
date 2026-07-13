import { randomBytes } from "node:crypto";
import { chmod, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileStateCache, type FileVersion } from "./cache.js";
import { pathMutex } from "./mutex.js";
import { inspectProjectPath } from "./path.js";

export interface AtomicWriteOptions {
  mode?: number;
  expected?: Pick<FileVersion, "mtimeMs" | "hash">;
}

function temporaryName(target: string, suffix: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.${suffix}`);
}

async function flushDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function replaceFile(temp: string, target: string): Promise<void> {
  const attempts = process.platform === "win32" ? 4 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EEXIST")) {
        throw error;
      }
      if (attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function assertExpected(root: string, input: string, expected: Pick<FileVersion, "mtimeMs" | "hash">): Promise<void> {
  const current = await fileStateCache.read(root, input);
  if (current.mtimeMs !== expected.mtimeMs || current.hash !== expected.hash) {
    throw new Error(`File changed since it was read: ${input}`);
  }
}

export async function atomicWriteBuffer(
  root: string,
  input: string,
  buffer: Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const initial = await inspectProjectPath(root, input, true);
  const key = process.platform === "win32" ? initial.target.toLowerCase() : initial.target;
  await pathMutex.runExclusive(key, async () => {
    const safe = await inspectProjectPath(root, input, true);
    if (options.expected) await assertExpected(root, input, options.expected);
    let mode = options.mode;
    if (mode === undefined) {
      try {
        mode = (await stat(safe.target)).mode;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mode = 0o666;
      }
    }
    const temp = temporaryName(safe.target, "tmp");
    let handle;
    try {
      handle = await open(temp, "wx", mode);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temp, mode);
      await replaceFile(temp, safe.target);
      await flushDirectory(path.dirname(safe.target));
      fileStateCache.clear(safe.target);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}
