import { access, readFile } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type { EncodingRule, EncodingRules } from "./types.js";

const RULES_FILE = ".encoding-rules";

function isWithin(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export async function findEncodingRules(startPath: string, boundary?: string): Promise<EncodingRules> {
  const resolvedBoundary = path.resolve(boundary ?? path.parse(path.resolve(startPath)).root);
  let directory = path.resolve(startPath);
  if (!isWithin(directory, resolvedBoundary)) {
    throw new Error(`Path is outside the rules boundary: ${startPath}`);
  }

  while (isWithin(directory, resolvedBoundary)) {
    const rulesFile = path.join(directory, RULES_FILE);
    try {
      await access(rulesFile);
      return parseEncodingRules(await readFile(rulesFile, "utf8"), directory, rulesFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (directory === resolvedBoundary) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return { root: resolvedBoundary, file: null, rules: [] };
}

export function parseEncodingRules(source: string, root: string, file: string | null = null): EncodingRules {
  const rules: EncodingRule[] = [];
  for (const [index, rawLine] of source.split(/\r\n|\n|\r/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.search(/\s/);
    const rawPattern = separator < 0 ? line : line.slice(0, separator);
    const rawEncoding = separator < 0 ? "" : line.slice(separator).trim().split(/\s+/)[0] ?? "";
    const cancelled = rawPattern.startsWith("!");
    const pattern = cancelled ? rawPattern.slice(1) : rawPattern;
    if (!pattern) throw new Error(`Invalid empty pattern at ${file ?? RULES_FILE}:${index + 1}`);
    if (!cancelled && !rawEncoding) {
      throw new Error(`Missing encoding at ${file ?? RULES_FILE}:${index + 1}`);
    }
    rules.push({ pattern, encoding: cancelled ? null : rawEncoding, line: index + 1 });
  }
  return { root: path.resolve(root), file, rules };
}

export function resolveEncoding(filePath: string, rules: EncodingRules): string {
  const absolute = path.resolve(filePath);
  if (!isWithin(absolute, rules.root)) throw new Error(`Path is outside project root: ${filePath}`);
  const relative = path.relative(rules.root, absolute).split(path.sep).join("/");
  let encoding = "utf-8";
  for (const rule of rules.rules) {
    const pattern = rule.pattern.split("\\").join("/");
    const basename = !pattern.includes("/");
    if (picomatch.isMatch(relative, pattern, { dot: true, basename })) {
      encoding = rule.encoding ?? "utf-8";
    }
  }
  return encoding;
}
