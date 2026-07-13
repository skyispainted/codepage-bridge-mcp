import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeText, encodeText, findEncodingRules, parseEncodingRules, resolveEncoding } from "../src/encoding/index.js";

describe("encoding rules", () => {
  it("uses the nearest rules file as project root and last match wins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "encoding-rules-"));
    const project = path.join(root, "project");
    const nested = path.join(project, "src", "deep");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, ".encoding-rules"), "**/*.txt windows-1252\n");
    await writeFile(
      path.join(project, ".encoding-rules"),
      "**/*.txt windows-1252\nsrc/**/*.txt shift_jis\n!src/deep/*.txt\n",
    );
    const rules = await findEncodingRules(nested, root);
    expect(rules.root).toBe(project);
    expect(resolveEncoding(path.join(project, "other.txt"), rules)).toBe("windows-1252");
    expect(resolveEncoding(path.join(project, "src", "a.txt"), rules)).toBe("shift_jis");
    expect(resolveEncoding(path.join(project, "src", "deep", "a.txt"), rules)).toBe("utf-8");
  });

  it("matches basename-only patterns at every directory depth", () => {
    const root = path.resolve("project");
    const rules = parseEncodingRules("*.cpp gbk\n*.h gbk", root);
    expect(resolveEncoding(path.join(root, "proj.android", "Classes", "AppDelegate.cpp"), rules)).toBe("gbk");
    expect(resolveEncoding(path.join(root, "SourceCode", "nested", "Header.h"), rules)).toBe("gbk");
  });
  it("matches slash-separated paths relative to the rules directory", () => {
    const root = path.resolve("project");
    const rules = parseEncodingRules("assets/**/*.txt gbk", root);
    expect(resolveEncoding(path.join(root, "assets", "zh", "a.txt"), rules)).toBe("gbk");
    expect(resolveEncoding(path.join(root, "a.txt"), rules)).toBe("utf-8");
    expect(() => resolveEncoding(path.resolve(root, "..", "outside.txt"), rules)).toThrow(/outside project root/);
  });
});

describe("strict codec", () => {
  it("defaults to strict UTF-8", () => {
    expect(() => decodeText(Buffer.from([0xc3, 0x28]))).toThrow(/Invalid byte sequence/);
  });

  it("preserves BOM and detects dominant newline", () => {
    const decoded = decodeText(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("a\r\nb\r\nc\n")]));
    expect(decoded).toMatchObject({ text: "a\r\nb\r\nc\n", bom: "utf-8", newline: "\r\n" });
    expect(encodeText("x\ny\n", decoded.encoding, decoded)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("x\r\ny\r\n")]),
    );
  });

  it("writes legacy encodings and rejects lossy conversion", () => {
    expect(decodeText(encodeText("café", "windows-1252"), "windows-1252").text).toBe("café");
    expect(() => encodeText("price € and 漢", "windows-1252")).toThrow(/not representable/);
  });
});
