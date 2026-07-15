---
description: Configure the current repository to use Codepage Bridge with project-local .mcp.json, CLAUDE.md, and .encoding-rules. Use when the user says "set this project up" or "make this repo use codepage bridge".
allowed-tools: Read, Edit, AskUserQuestion
---

# /setup-project

## What to do

1. Confirm the project root.
2. Check whether `.mcp.json`, `CLAUDE.md`, and `.encoding-rules` already exist.
3. If they do not exist, propose the minimal templates from:
   - `examples/minimal-project/.mcp.json`
   - `examples/minimal-project/CLAUDE.md`
   - `examples/minimal-project/.encoding-rules`
4. If they do exist, explain how to merge rather than overwrite.
5. Remind the user that project `.mcp.json` may require approval the first time Claude Code loads it.
6. Remind the user that denying built-in file tools is still user-level behavior unless their environment provides another policy layer.
