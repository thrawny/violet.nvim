import type Anthropic from "@anthropic-ai/sdk";
import type { Nvim } from "./nvim.ts";
import {
  inlineEditTool,
  replaceSelectionTool,
  type InlineEditInput,
  type ReplaceSelectionInput,
} from "./tools.ts";
import { log } from "./log.ts";

const SYSTEM_PROMPT = `You are a code editing assistant. When the user asks you to modify code, use the provided tool to make the edit. Be precise and make exactly the changes requested.`;

type Selection = {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
};

export type InlineEditRequest = {
  bufnr: number;
  filePath: string;
  fileContent: string;
  cursorLine: number;
  cursorCol: number;
  instruction: string;
  selection?: Selection;
};

function buildPrompt(req: InlineEditRequest): string {
  const ext = req.filePath.split(".").pop() || "";

  if (req.selection) {
    return `I am working in file \`${req.filePath}\` with the following contents:
\`\`\`${ext}
${req.fileContent}
\`\`\`

I have the following text selected on line ${req.selection.startLine}:
\`\`\`
${req.selection.text}
\`\`\`

${req.instruction}`;
  }

  const lines = req.fileContent.split("\n");
  const cursorLineContent = lines[req.cursorLine - 1] || "";

  return `I am working in file \`${req.filePath}\` with the following contents:
\`\`\`${ext}
${req.fileContent}
\`\`\`

My cursor is on line ${req.cursorLine}: ${cursorLineContent}

${req.instruction}`;
}

export async function performInlineEdit(
  client: Anthropic,
  nvim: Nvim,
  req: InlineEditRequest
): Promise<void> {
  await log("=== Inline Edit Request ===");
  await log("Request:", req);

  const tool = req.selection ? replaceSelectionTool : inlineEditTool;
  const prompt = buildPrompt(req);
  await log("Prompt:", prompt);

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: prompt }],
  });

  await log("Response:", response);

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("No tool use in response");
  }

  await log("Tool use:", toolUse);

  if (req.selection) {
    const input = toolUse.input as ReplaceSelectionInput;
    await log("Applying selection replace:", input);
    await applySelectionReplace(nvim, req.bufnr, req.selection, input.replace);
  } else {
    const input = toolUse.input as InlineEditInput;
    await log("Applying inline edit - find:", input.find);
    await log("Applying inline edit - replace:", input.replace);
    await applyInlineEdit(nvim, req.bufnr, input.find, input.replace);
  }

  await log("Edit applied successfully");
}

async function applySelectionReplace(
  nvim: Nvim,
  bufnr: number,
  selection: Selection,
  replacement: string
): Promise<void> {
  // nvim_buf_set_text uses 0-indexed, exclusive end
  // selection.endCol is 1-indexed, inclusive (last selected char)
  // Conversion: (endCol - 1) for 0-indexed + 1 for exclusive = endCol (no change)
  // But we must clamp to actual line length to avoid out-of-range errors
  const endLineContent = await nvim.call<string[]>("nvim_buf_get_lines", [
    bufnr,
    Number(selection.endLine) - 1,
    Number(selection.endLine),
    false,
  ]);
  const lineLength = endLineContent[0]?.length ?? 0;
  const endCol = Math.min(Number(selection.endCol), lineLength);

  const lines = replacement.split("\n");
  await nvim.call("nvim_buf_set_text", [
    bufnr,
    Number(selection.startLine) - 1,
    Number(selection.startCol) - 1,
    Number(selection.endLine) - 1,
    endCol,
    lines,
  ]);
}

async function applyInlineEdit(
  nvim: Nvim,
  bufnr: number,
  find: string,
  replace: string
): Promise<void> {
  const lines = await nvim.call<string[]>("nvim_buf_get_lines", [
    bufnr,
    0,
    -1,
    false,
  ]);
  const content = lines.join("\n");

  // Handle empty file - just set the content directly
  if (content === "" || content.trim() === "") {
    await log("Empty file detected, setting content directly");
    const replacementLines = replace.split("\n");
    await nvim.call("nvim_buf_set_lines", [bufnr, 0, -1, false, replacementLines]);
    return;
  }

  const startIdx = content.indexOf(find);
  if (startIdx === -1) {
    throw new Error(`Could not find text to replace: ${find.slice(0, 50)}...`);
  }

  const endIdx = startIdx + find.length;

  // Convert character indices to line/col
  let startLine = 0;
  let startCol = 0;
  let endLine = 0;
  let endCol = 0;
  let pos = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1; // +1 for newline

    if (pos <= startIdx && startIdx < pos + lineLen) {
      startLine = i;
      startCol = startIdx - pos;
    }

    if (pos <= endIdx && endIdx <= pos + lineLen) {
      endLine = i;
      endCol = endIdx - pos;
      break;
    }

    pos += lineLen;
  }

  const replacementLines = replace.split("\n");
  await nvim.call("nvim_buf_set_text", [
    bufnr,
    startLine,
    startCol,
    endLine,
    endCol,
    replacementLines,
  ]);
}
