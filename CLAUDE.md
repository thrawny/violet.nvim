# violet.nvim

Neovim plugin for AI-assisted editing with two core features:
1. **Edit Prediction** - Ghost text completions based on recent edits
2. **Inline Edits** - Select code → describe change → apply edit

## Tech Stack

- **Runtime**: Bun (not Node)
- **Language**: TypeScript (ts/) + Lua (lua/)
- **Auth**: Claude Max only, via macOS keychain (`security find-generic-password`)

## Project Structure

```
violet.nvim/
├── ts/           # TypeScript source (bun runs directly, no build step)
├── lua/          # Neovim Lua plugin code (future)
├── package.json  # Dependencies at root
└── tsconfig.json # Type checking only (noEmit)
```

## Commands

```bash
bun run start      # Run ts/index.ts
bun run typecheck  # Type check without emitting
```

## Key Decisions

- Manual trigger for edit predictions (not auto)
- No TEA architecture - simple classes
- Change tracking via `nvim_buf_attach` + `on_bytes` (not fake LSP)
- Ghost text preview for predictions, direct apply for inline edits
