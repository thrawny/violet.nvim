import type Anthropic from "@anthropic-ai/sdk";
import type { Nvim } from "./nvim.ts";
import {
  inlineEditTool,
  replaceSelectionTool,
  type InlineEditInput,
  type ReplaceSelectionInput,
} from "./tools.ts";
import { log } from "./log.ts";

const SYSTEM_PROMPT = `You are a code editing assistant. Use the provided tool to make the edit. The replace field must contain ONLY the new code/text - never include the user's instruction or any commentary.`;

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

Instruction: ${req.instruction}`;
  }

  const lines = req.fileContent.split("\n");
  const cursorLineContent = lines[req.cursorLine - 1] || "";

  return `I am working in file \`${req.filePath}\` with the following contents:
\`\`\`${ext}
${req.fileContent}
\`\`\`

My cursor is on line ${req.cursorLine}: ${cursorLineContent}

Instruction: ${req.instruction}`;
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
    await log("Applying inline edit - startLine:", input.startLine);
    await log("Applying inline edit - endLine:", input.endLine);
    await log("Applying inline edit - replace:", input.replace);
    await applyInlineEdit(nvim, req.bufnr, input.startLine, input.endLine, input.replace);
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
  startLine: number,
  endLine: number,
  replace: string
): Promise<void> {
  // Convert 1-indexed to 0-indexed for nvim_buf_set_lines
  // nvim_buf_set_lines uses [start, end) range (end is exclusive)
  const start0 = startLine - 1;
  const end0 = endLine; // endLine is inclusive in our API, exclusive in nvim

  const replacementLines = replace === "" ? [] : replace.split("\n");
  await nvim.call("nvim_buf_set_lines", [
    bufnr,
    start0,
    end0,
    false,
    replacementLines,
  ]);
}
