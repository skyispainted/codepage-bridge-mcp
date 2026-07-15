---
description: Set up Codepage Bridge in Claude Code and disable the unsafe built-in file tools. Use when the user says things like "install codepage bridge", "set up the plugin", or "configure encoding bridge".
allowed-tools: Read, Edit, AskUserQuestion
---

# /setup

Use this command after the plugin is installed.

## What to do

1. Explain that plugin installation enables the MCP declaration, but safe usage still requires user settings and project rules.
2. Ask which scope the user wants:
   - Global for all projects
   - Current project only
3. Show them the exact config fragment from `examples/claude-config/settings.fragment.json`.
4. Tell them to add a `CLAUDE.md` policy using `examples/minimal-project/CLAUDE.md`.
5. Tell them to add `.encoding-rules` using `examples/minimal-project/.encoding-rules`.
6. Explain how to verify that Claude is calling `mcp__codepage-bridge__Read`, `Grep`, `Edit`, and `Write`.

## Important guidance

- Emphasize that built-in `Read`, `Grep`, `Edit`, `Write`, and `NotebookEdit` must be denied.
- Emphasize that shell commands and scripts must not be used to bypass the bridge.
- If the user wants help applying the project files, offer to generate project-local `.mcp.json`, `CLAUDE.md`, and `.encoding-rules`.
