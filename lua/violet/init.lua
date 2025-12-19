local M = {}

M.channel_id = nil
M.starting = false -- Prevents multiple start() calls
M.opts = {
  debug = false,
  keymaps = {
    inline_edit = false, -- Users typically set keymaps via lazy.nvim keys spec
    edit_prediction = false,
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
M._change_tracking = { buffers = {}, started = false }
M._prediction = { esc_mappings = {}, text_changed_autocmds = {}, active = false }

local function is_trackable_buffer(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return false
  end
  local buftype = vim.api.nvim_buf_get_option(bufnr, "buftype")
  return buftype == ""
end

local function resolve_end_pos(start_row, start_col, end_row_delta, end_col)
  local end_row = start_row + end_row_delta
  local end_col_abs = end_col
  if end_row_delta == 0 then
    end_col_abs = start_col + end_col
  end
  return end_row, end_col_abs
end

local function slice_text(lines, start_row, start_col, end_row, end_col)
  if start_row > end_row or (start_row == end_row and start_col >= end_col) then
    return ""
  end

  local parts = {}
  for row = start_row, end_row do
    local line = lines[row + 1] or ""
    local line_start = 1
    local line_end = #line
    if row == start_row then
      line_start = start_col + 1
    end
    if row == end_row then
      line_end = end_col
    end
    parts[#parts + 1] = line:sub(line_start, line_end)
  end
  return table.concat(parts, "\n")
end

function M.setup(opts)
  opts = opts or {}
  M.opts = vim.tbl_deep_extend("force", M.opts, opts)
  M.setup_commands()
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

  local prediction_key = M.opts.keymaps.edit_prediction
  if prediction_key then
    vim.keymap.set("n", prediction_key, M.edit_prediction, { desc = "Violet: Edit Prediction" })
    vim.keymap.set("i", prediction_key, M.edit_prediction, { desc = "Violet: Edit Prediction" })
  end

  M.setup_prediction_highlights()
  M.start_change_tracking()

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

function M.setup_prediction_highlights()
  vim.api.nvim_set_hl(0, "VioletPredictionInsert", { link = "Comment" })
  vim.api.nvim_set_hl(0, "VioletPredictionDelete", { strikethrough = true, fg = "#6b7280" })
end

function M.attach_buffer(bufnr)
  if M._change_tracking.buffers[bufnr] or not is_trackable_buffer(bufnr) then
    return
  end

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  M._change_tracking.buffers[bufnr] = { lines = lines }

  vim.api.nvim_buf_attach(bufnr, false, {
    on_bytes = function(
      _,
      buf,
      _,
      start_row,
      start_col,
      _,
      old_end_row,
      old_end_col,
      _,
      new_end_row,
      new_end_col,
      _
    )
      local cache = M._change_tracking.buffers[buf]
      if not cache then
        return
      end

      local old_end_row_abs, old_end_col_abs = resolve_end_pos(start_row, start_col, old_end_row, old_end_col)
      local new_end_row_abs, new_end_col_abs = resolve_end_pos(start_row, start_col, new_end_row, new_end_col)

      local old_text = slice_text(cache.lines, start_row, start_col, old_end_row_abs, old_end_col_abs)
      local new_lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      local new_text = slice_text(new_lines, start_row, start_col, new_end_row_abs, new_end_col_abs)

      cache.lines = new_lines

      if old_text == "" and new_text == "" then
        return
      end

      if not M.channel_id then
        return
      end

      local file_path = vim.api.nvim_buf_get_name(buf)
      if file_path == "" then
        return
      end

      vim.rpcnotify(M.channel_id, "violetBufferChange", {
        filePath = file_path,
        startLine = start_row,
        endLine = math.max(old_end_row_abs, new_end_row_abs),
        startCol = start_col,
        endCol = math.max(old_end_col_abs, new_end_col_abs),
        oldText = old_text,
        newText = new_text,
      })
    end,
    on_detach = function(_, buf)
      M._change_tracking.buffers[buf] = nil
    end,
  })
end

function M.start_change_tracking()
  if M._change_tracking.started then
    return
  end
  M._change_tracking.started = true

  local group = vim.api.nvim_create_augroup("VioletChangeTracking", { clear = true })
  vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
    group = group,
    callback = function(args)
      M.attach_buffer(args.buf)
    end,
  })

  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    M.attach_buffer(bufnr)
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

function M.edit_prediction()
  M.when_ready(function()
    vim.rpcnotify(M.channel_id, "violetEditPrediction", {})
  end)
end

function M.accept_prediction()
  local active = M._prediction.active
  M.when_ready(function()
    vim.rpcnotify(M.channel_id, "violetAcceptPrediction", {})
  end)
  if not active then
    return nil
  end
  return true
end

function M.accept_prediction_blink()
  return function()
    return M.accept_prediction()
  end
end

function M.accept_prediction_expr()
  local accepted = M.accept_prediction()
  if accepted then
    return ""
  end
  return vim.api.nvim_replace_termcodes("<Tab>", true, false, true)
end

function M.dismiss_prediction()
  if not M.channel_id then
    return
  end
  vim.rpcnotify(M.channel_id, "violetPredictionDismissed", {})
end

function M.command(cmd)
  if cmd == "predict-edit" then
    return M.edit_prediction()
  end
  if cmd == "accept-prediction" then
    return M.accept_prediction()
  end
  if cmd == "dismiss-prediction" then
    return M.dismiss_prediction()
  end
  notify("violet.nvim: unknown command '" .. cmd .. "'", vim.log.levels.WARN)
end

function M.setup_commands()
  vim.api.nvim_create_user_command("Violet", function(opts)
    M.command(opts.args)
  end, {
    nargs = 1,
    complete = function()
      return { "predict-edit", "accept-prediction", "dismiss-prediction" }
    end,
  })
end

function M.set_prediction_active(value)
  M._prediction.active = value and true or false
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

function M.setup_prediction_esc_mapping(bufnr)
  if M._prediction.esc_mappings[bufnr] then
    return
  end

  local function dismiss()
    if M.channel_id then
      vim.rpcnotify(M.channel_id, "violetPredictionDismissed", { bufnr = bufnr })
    end
  end

  vim.keymap.set("n", "<Esc>", dismiss, { buffer = bufnr, noremap = true, silent = true })

  M._prediction.esc_mappings[bufnr] = true
end

function M.cleanup_prediction_esc_mapping(bufnr)
  if not M._prediction.esc_mappings[bufnr] then
    return
  end

  pcall(vim.keymap.del, "n", "<Esc>", { buffer = bufnr })
  M._prediction.esc_mappings[bufnr] = nil
end

function M.listen_for_text_changed(bufnr)
  if M._prediction.text_changed_autocmds[bufnr] then
    return
  end

  local group = vim.api.nvim_create_augroup("VioletPredictionTextChanged" .. bufnr, { clear = true })
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "InsertLeave" }, {
    group = group,
    buffer = bufnr,
    callback = function()
      if M.channel_id then
        vim.rpcnotify(M.channel_id, "violetPredictionDismissed", { bufnr = bufnr })
      end
    end,
  })

  M._prediction.text_changed_autocmds[bufnr] = group
end

function M.cleanup_listen_for_text_changed(bufnr)
  local group = M._prediction.text_changed_autocmds[bufnr]
  if not group then
    return
  end

  pcall(vim.api.nvim_del_augroup_by_id, group)
  M._prediction.text_changed_autocmds[bufnr] = nil
end

return M
