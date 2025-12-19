local M = {}

M.channel_id = nil
M.starting = false -- Prevents multiple start() calls
M.opts = {
  debug = false,
  keymaps = {
    inline_edit = false, -- Users typically set keymaps via lazy.nvim keys spec
  },
}

local function notify(msg, level)
  -- Always show errors and warnings, only show info/debug when debug mode is on
  if level == vim.log.levels.ERROR or level == vim.log.levels.WARN then
    vim.notify(msg, level)
  elseif M.opts.debug then
    vim.notify(msg, level)
  end
end
M.on_ready_callback = nil -- Callback to run when connection is established

function M.setup(opts)
  opts = opts or {}
  M.opts = vim.tbl_deep_extend("force", M.opts, opts)
  -- Don't start backend here - defer until first use
end

function M.start()
  if M.starting then
    return
  end
  M.starting = true

  local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")

  local job_id = vim.fn.jobstart("bun run start", {
    cwd = plugin_root,
    on_exit = function(_, code)
      if code ~= 0 then
        notify("violet.nvim: process exited with code " .. code, vim.log.levels.ERROR)
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          notify("violet: " .. line, vim.log.levels.DEBUG)
        end
      end
    end,
  })

  if job_id <= 0 then
    notify("violet.nvim: failed to start", vim.log.levels.ERROR)
  end
end

function M.bridge(channel_id)
  M.channel_id = channel_id

  -- Run any pending callback
  if M.on_ready_callback then
    local cb = M.on_ready_callback
    M.on_ready_callback = nil
    vim.schedule(cb)
  end

  -- Register keymaps if configured (alternative to lazy.nvim keys spec)
  local key = M.opts.keymaps.inline_edit
  if key then
    vim.keymap.set("n", key, M.inline_edit, { desc = "Violet: Inline Edit" })
    vim.keymap.set("v", key, M.inline_edit_selection, { desc = "Violet: Inline Edit Selection" })
  end

  notify("violet.nvim: ready", vim.log.levels.INFO)
end

-- Wait for connection, then run callback. Starts backend if not running.
function M.when_ready(callback)
  if M.channel_id then
    callback()
    return
  end

  M.on_ready_callback = callback

  -- Start backend if not already starting
  if not M.starting then
    notify("violet.nvim: connecting...", vim.log.levels.INFO)
    M.start()

    -- Timeout after 5 seconds
    vim.defer_fn(function()
      if M.on_ready_callback then
        M.on_ready_callback = nil
        notify("violet.nvim: connection timeout", vim.log.levels.ERROR)
      end
    end, 5000)
  end
end

function M.do_inline_edit(selection)
  local bufnr = vim.api.nvim_get_current_buf()
  local win = vim.api.nvim_get_current_win()
  local cursor = vim.api.nvim_win_get_cursor(win)

  vim.ui.input({ prompt = "Edit: " }, function(instruction)
    if not instruction or instruction == "" then
      return
    end

    local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
    local file_content = table.concat(lines, "\n")
    local file_path = vim.api.nvim_buf_get_name(bufnr)

    local request = {
      bufnr = bufnr,
      filePath = file_path,
      fileContent = file_content,
      cursorLine = cursor[1],
      cursorCol = cursor[2] + 1,
      instruction = instruction,
    }

    if selection then
      request.selection = selection
    end

    vim.rpcrequest(M.channel_id, "violetInlineEdit", request)
    notify("violet: edit applied", vim.log.levels.INFO)
  end)
end

-- Start inline edit (no selection)
function M.inline_edit()
  M.when_ready(function()
    M.do_inline_edit(nil)
  end)
end

-- Start inline edit with visual selection
function M.inline_edit_selection()
  -- Capture visual mode type before doing anything
  local mode = vim.fn.mode()

  -- Use getpos("v") and getpos(".") which work while still in visual mode
  -- (unlike '< and '> which only update after exiting visual mode)
  local pos_v = vim.fn.getpos("v") -- visual start
  local pos_dot = vim.fn.getpos(".") -- cursor (visual end)

  -- Normalize: ensure start is before end
  local start_line, start_col, end_line, end_col
  if pos_v[2] < pos_dot[2] or (pos_v[2] == pos_dot[2] and pos_v[3] <= pos_dot[3]) then
    start_line, start_col = pos_v[2], pos_v[3]
    end_line, end_col = pos_dot[2], pos_dot[3]
  else
    start_line, start_col = pos_dot[2], pos_dot[3]
    end_line, end_col = pos_v[2], pos_v[3]
  end

  -- For line-wise visual (V), select entire lines
  if mode == "V" then
    start_col = 1
    local end_line_content = vim.api.nvim_buf_get_lines(0, end_line - 1, end_line, false)[1] or ""
    end_col = #end_line_content
  end

  -- Get the selected text
  local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
  if #lines == 0 then
    return
  end

  -- Adjust for partial lines
  if #lines == 1 then
    lines[1] = lines[1]:sub(start_col, end_col)
  else
    lines[1] = lines[1]:sub(start_col)
    lines[#lines] = lines[#lines]:sub(1, end_col)
  end

  local selection = {
    startLine = start_line,
    startCol = start_col,
    endLine = end_line,
    endCol = end_col,
    text = table.concat(lines, "\n"),
  }

  -- Exit visual mode
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)

  -- Wait for ready, then prompt for instruction
  M.when_ready(function()
    M.do_inline_edit(selection)
  end)
end

return M
