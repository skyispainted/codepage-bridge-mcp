---
description: Diagnose why Codepage Bridge is not being used or not decoding files correctly.
allowed-tools: Read, Edit, AskUserQuestion
---

# /doctor

Use this command when the user reports that Codepage Bridge is not working correctly.

## Checklist

1. Verify the MCP is connected.
2. Verify the session tool list contains `mcp__codepage-bridge__Read`, `Grep`, `Edit`, and `Write`.
3. Verify built-in `Read`, `Grep`, `Edit`, `Write`, and `NotebookEdit` are denied.
4. Verify the project has `.encoding-rules`.
5. Verify the target file path is inside the project root defined by the nearest `.encoding-rules`.
6. Verify the relevant pattern matches the target file, especially nested `*.cpp` / `*.h` style rules.
7. Verify the model is not bypassing through shell commands or scripts.
8. If editing failed, determine whether:
   - the target lines were not read,
   - the file changed after reading,
   - the new text is not representable in the target encoding.
