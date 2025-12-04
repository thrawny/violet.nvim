# violet.nvim

Neovim plugin for AI-assisted inline code editing powered by Claude.

## Features

- **Inline Edit**: Describe a change in natural language and have Claude apply it
- Works in normal mode (edit at cursor) or visual mode (edit selection)

## Requirements

- [Bun](https://bun.sh/) runtime
- Claude Max subscription (uses macOS keychain for auth)
- Neovim 0.9+

## Installation

Using [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "thrawny/violet.nvim",
  keys = {
    { "<leader>ai", function() require("violet").inline_edit() end, desc = "Inline Edit" },
    { "<leader>ai", function() require("violet").inline_edit_selection() end, mode = "v", desc = "Inline Edit Selection" },
  },
  config = function()
    require("violet").setup()
  end,
}
```

## Usage

1. In normal mode, press `<leader>ai` to open the edit prompt
2. In visual mode, select text and press `<leader>ai` to edit the selection
3. Describe your edit and press Enter to apply

The plugin opens a small input window where you describe the change you want. Press `<Esc>` or `q` to cancel.
