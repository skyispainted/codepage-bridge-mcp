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
  return new EncodingRulesLookup().find(startPath, boundary);
}

/**
 * Resolves encoding rules while remembering, per directory, which ancestor's
 * rules file applies. A walk over a deep tree would otherwise repeat the same
 * upward climb for every file it visits.
 */
export class EncodingRulesLookup {
  private readonly resolved = new Map<string, EncodingRules>();
  private readonly pending = new Map<string, Promise<EncodingRules>>();

  async find(startPath: string, boundary?: string): Promise<EncodingRules> {
    const directory = path.resolve(startPath);
    const outstanding = this.pending.get(directory);
    if (outstanding !== undefined) return outstanding;
    const climb = this.climb(directory, boundary);
    // Callers that arrive while this climb is in flight share it. Without that,
    // concurrent readers each start their own and the memo never hits.
    this.pending.set(directory, climb);
    try {
      return await climb;
    } finally {
      this.pending.delete(directory);
    }
  }

  private async climb(startPath: string, boundary?: string): Promise<EncodingRules> {
    const resolvedBoundary = path.resolve(boundary ?? path.parse(startPath).root);
    let directory = startPath;
    if (!isWithin(directory, resolvedBoundary)) {
      throw new Error(`Path is outside the rules boundary: ${startPath}`);
    }

    const visited: string[] = [];
    while (isWithin(directory, resolvedBoundary)) {
      const known = this.resolved.get(directory);
      if (known !== undefined) return this.remember(visited, known);
      visited.push(directory);

      const rulesFile = path.join(directory, RULES_FILE);
      try {
        await access(rulesFile);
        const rules = parseEncodingRules(await readFile(rulesFile, "utf8"), directory, rulesFile);
        return this.remember(visited, rules);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }

      if (directory === resolvedBoundary) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }

    return this.remember(visited, { root: resolvedBoundary, file: null, rules: [] });
  }

  private remember(directories: readonly string[], rules: EncodingRules): EncodingRules {
    for (const directory of directories) this.resolved.set(directory, rules);
    return rules;
  }
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
