local M = {}

M.channel_id = nil
M.starting = false -- Prevents multiple start() calls
M.opts = {
  keymaps = {
    inline_edit = false, -- Users typically set keymaps via lazy.nvim keys spec
  },
}
M.state = {
  input_buf = nil,
  input_win = nil,
  target_buf = nil,
  target_win = nil,
  selection = nil,
}
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
        vim.notify("violet.nvim: process exited with code " .. code, vim.log.levels.ERROR)
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          vim.notify("violet: " .. line, vim.log.levels.DEBUG)
        end
      end
    end,
  })

  if job_id <= 0 then
    vim.notify("violet.nvim: failed to start", vim.log.levels.ERROR)
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

  vim.notify("violet.nvim: ready", vim.log.levels.INFO)
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
    vim.notify("violet.nvim: connecting...", vim.log.levels.INFO)
    M.start()

    -- Timeout after 5 seconds
    vim.defer_fn(function()
      if M.on_ready_callback then
        M.on_ready_callback = nil
        vim.notify("violet.nvim: connection timeout", vim.log.levels.ERROR)
      end
    end, 5000)
  end
end

function M.open_input(selection)
  -- Store target window/buffer
  M.state.target_win = vim.api.nvim_get_current_win()
  M.state.target_buf = vim.api.nvim_get_current_buf()
  M.state.selection = selection

  -- Create input buffer
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_option(buf, "buftype", "nofile")
  vim.api.nvim_buf_set_option(buf, "bufhidden", "wipe")
  vim.api.nvim_buf_set_option(buf, "filetype", "markdown")

  -- Open split above current window
  local win = vim.api.nvim_open_win(buf, true, {
    split = "above",
    height = 5,
  })

  vim.api.nvim_win_set_option(win, "winbar", "Violet: Describe your edit")
  vim.api.nvim_win_set_option(win, "wrap", true)

  M.state.input_buf = buf
  M.state.input_win = win

  -- Keymaps for the input buffer
  local function submit()
    M.submit_edit()
  end

  local function cancel()
    M.close_input()
  end

  vim.keymap.set("n", "<CR>", submit, { buffer = buf, desc = "Submit edit" })
  vim.keymap.set("i", "<C-CR>", submit, { buffer = buf, desc = "Submit edit" })
  vim.keymap.set("n", "<Esc>", cancel, { buffer = buf, desc = "Cancel" })
  vim.keymap.set("n", "q", cancel, { buffer = buf, desc = "Cancel" })

  vim.cmd("startinsert")
end

function M.close_input()
  if M.state.input_win and vim.api.nvim_win_is_valid(M.state.input_win) then
    vim.api.nvim_win_close(M.state.input_win, true)
  end
  M.state.input_buf = nil
  M.state.input_win = nil
  M.state.selection = nil
end

function M.submit_edit()
  if not M.state.input_buf or not M.state.target_buf then
    return
  end

  local input_lines = vim.api.nvim_buf_get_lines(M.state.input_buf, 0, -1, false)
  local instruction = table.concat(input_lines, "\n")

  if instruction == "" then
    vim.notify("violet: empty instruction", vim.log.levels.WARN)
    return
  end

  -- Get file content and cursor position
  local target_lines = vim.api.nvim_buf_get_lines(M.state.target_buf, 0, -1, false)
  local file_content = table.concat(target_lines, "\n")
  local file_path = vim.api.nvim_buf_get_name(M.state.target_buf)
  local cursor = vim.api.nvim_win_get_cursor(M.state.target_win)

  local request = {
    bufnr = M.state.target_buf,
    filePath = file_path,
    fileContent = file_content,
    cursorLine = cursor[1],
    cursorCol = cursor[2] + 1,
    instruction = instruction,
  }

  if M.state.selection then
    request.selection = M.state.selection
  end

  -- Update winbar to show loading
  if M.state.input_win and vim.api.nvim_win_is_valid(M.state.input_win) then
    vim.api.nvim_win_set_option(M.state.input_win, "winbar", "Violet: Processing...")
  end

  -- Make the RPC call
  vim.rpcrequest(M.channel_id, "violetInlineEdit", request)

  M.close_input()
  vim.notify("violet: edit applied", vim.log.levels.INFO)
end

-- Start inline edit (no selection)
function M.inline_edit()
  M.when_ready(function()
    M.open_input(nil)
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

  -- Wait for ready, then open input
  M.when_ready(function()
    M.open_input(selection)
  end)
end

return M
