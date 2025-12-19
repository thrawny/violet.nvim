import type Anthropic from "@anthropic-ai/sdk";
import type { Nvim } from "./nvim.ts";
import { predictEditTool, type PredictEditInput } from "./tools.ts";
import { calculateDiff } from "./edit-prediction-diff.ts";
import { type ChangeTracker } from "./change-tracker.ts";
import { log } from "./log.ts";

export const PREDICTION_SYSTEM_PROMPT = `You are a code editing assistant. Predict the most likely next edit based on recent changes and the current context window. Always respond with a single predict_edit tool call. The find/replace must be scoped to the provided context window only. Do not include any explanation.`;

export const DEFAULT_RECENT_CHANGE_TOKEN_BUDGET = 1000;

type PredictionState =
  | { type: "idle" }
  | { type: "awaiting-agent-reply"; requestId: number; context: CapturedContext }
  | { type: "displaying-proposed-edit"; context: CapturedContext; prediction: PredictEditInput }
  | { type: "prediction-being-applied"; context: CapturedContext; prediction: PredictEditInput };

type CapturedContext = {
  contextLines: string[];
  cursorDelta: number;
  cursorCol: number;
  bufferName: string;
  bufferId: number;
  startLine: number;
  endLine: number;
  totalLines: number;
};

type CursorPosition = { row: number; col: number };

export type RecentChange = {
  filePath: string;
  startLine: number;
  endLine: number;
  oldText: string;
  newText: string;
};

export function buildPredictionPrompt(params: {
  contextLines: string[];
  cursorLine: number;
  cursorCol: number;
  bufferName: string;
  startLine: number;
  endLine: number;
  recentChanges: RecentChange[];
  tokenBudget?: number;
}): string {
  const {
    contextLines,
    cursorLine,
    cursorCol,
    bufferName,
    startLine,
    endLine,
    recentChanges,
    tokenBudget = DEFAULT_RECENT_CHANGE_TOKEN_BUDGET,
  } = params;

  const contextWithCursor = [...contextLines];
  const line = contextWithCursor[cursorLine] ?? "";
  contextWithCursor[cursorLine] =
    line.slice(0, cursorCol) + "│" + line.slice(cursorCol);

  const selectedChanges: string[] = [];
  let tokenCount = 0;

  for (let i = recentChanges.length - 1; i >= 0; i -= 1) {
    const change = recentChanges[i];
    const formatted = [
      `${change.filePath}:${change.startLine + 1}:${change.endLine + 1}`,
      `- ${change.oldText}`,
      `+ ${change.newText}`,
    ].join("\n");

    const estimatedTokens = Math.ceil(formatted.length / 3);
    if (tokenCount + estimatedTokens > tokenBudget) {
      break;
    }

    selectedChanges.unshift(formatted);
    tokenCount += estimatedTokens;
  }

  const displayStartLine = startLine + 1;
  const displayEndLine = endLine + 1;

  return `Recent changes:
${selectedChanges.join("\n")}

Current context (│ marks cursor position):
${bufferName}:${displayStartLine}:${displayEndLine}
${contextWithCursor.join("\n")}

Predict the most likely next edit the user will make.`;
}

export class EditPredictionController {
  private state: PredictionState = { type: "idle" };
  private namespaceId: number | null = null;
  private renderedBufferId: number | null = null;
  private requestCounter = 0;

  constructor(
    private client: Anthropic,
    private nvim: Nvim,
    private changeTracker: ChangeTracker,
    private recentChangeTokenBudget = DEFAULT_RECENT_CHANGE_TOKEN_BUDGET
  ) {}

  async triggerOrAccept(): Promise<void> {
    if (this.state.type === "displaying-proposed-edit") {
      await this.acceptPrediction();
      return;
    }

    if (this.state.type === "awaiting-agent-reply") {
      return;
    }

    await this.triggerPrediction();
  }

  async acceptPredictionOnly(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }
    await this.acceptPrediction();
  }

  async dismissPrediction(bufnr?: number): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    if (bufnr && bufnr !== this.state.context.bufferId) {
      return;
    }

    await this.clearVirtualText();
    await this.cleanupPredictionListeners();
    this.state = { type: "idle" };
  }

  private async ensureNamespace(): Promise<number> {
    if (this.namespaceId === null) {
      this.namespaceId = await this.nvim.call("nvim_create_namespace", [
        "violet_prediction",
      ]);
    }
    return this.namespaceId!;
  }

  private async clearVirtualText(): Promise<void> {
    if (this.renderedBufferId === null) {
      return;
    }
    const ns = await this.ensureNamespace();
    await this.nvim.call("nvim_buf_clear_namespace", [
      this.renderedBufferId,
      ns,
      0,
      -1,
    ]);
    this.renderedBufferId = null;
    await this.setPredictionActive(false);
  }

  private async setupPredictionListeners(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    const bufnr = this.state.context.bufferId;
    const res = await this.nvim.call<{ mode: string }>("nvim_get_mode", []);

    if (res.mode === "n") {
      await this.nvim.call("nvim_exec_lua", [
        `require("violet").setup_prediction_esc_mapping(${bufnr})`,
        [],
      ]);
    }

    await this.nvim.call("nvim_exec_lua", [
      `require("violet").listen_for_text_changed(${bufnr})`,
      [],
    ]);
  }

  private async cleanupPredictionListeners(bufnr?: number): Promise<void> {
    const targetBufnr =
      bufnr ??
      (this.state.type === "displaying-proposed-edit"
        ? this.state.context.bufferId
        : undefined);

    if (!targetBufnr) {
      return;
    }

    await this.nvim.call("nvim_exec_lua", [
      `require("violet").cleanup_prediction_esc_mapping(${targetBufnr})`,
      [],
    ]);
    await this.nvim.call("nvim_exec_lua", [
      `require("violet").cleanup_listen_for_text_changed(${targetBufnr})`,
      [],
    ]);
  }

  private async showCompletingIndicator(context: CapturedContext): Promise<void> {
    const ns = await this.ensureNamespace();
    await this.clearVirtualText();
    this.renderedBufferId = context.bufferId;

    const cursorPos: CursorPosition = {
      row: context.startLine + context.cursorDelta,
      col: context.cursorCol,
    };

    await this.nvim.call("nvim_buf_set_extmark", [
      context.bufferId,
      ns,
      cursorPos.row,
      cursorPos.col,
      {
        virt_text: [["completing...", "Comment"]],
        right_gravity: false,
      },
    ]);
  }

  private convertCharPosToLineCol(
    text: string,
    charPos: number,
    startLine: number,
    startCol: number
  ): CursorPosition {
    const lines = text.slice(0, charPos).split("\n");
    const row = startLine + lines.length - 1;
    const col =
      lines.length === 1 ? startCol + lines[0].length : lines[lines.length - 1].length;
    return { row, col };
  }

  private resolveFindText(findText: string, contextText: string): string {
    if (contextText.includes(findText)) {
      return findText;
    }

    if (findText.includes("│")) {
      const fallbackFind = findText.replace(/│/g, "");
      if (contextText.includes(fallbackFind)) {
        return fallbackFind;
      }
      throw new Error(
        `Find text "${findText}" (or fallback "${fallbackFind}") not found in context`
      );
    }

    throw new Error(`Find text "${findText}" not found in context`);
  }

  private async showVirtualTextPreview(
    context: CapturedContext,
    prediction: PredictEditInput
  ): Promise<void> {
    const ns = await this.ensureNamespace();
    await this.clearVirtualText();
    this.renderedBufferId = context.bufferId;

    const contextText = context.contextLines.join("\n");
    const findText = this.resolveFindText(prediction.find, contextText);
    const newText = contextText.split(findText).join(prediction.replace);
    const diffOps = calculateDiff(contextText, newText);

    for (const op of diffOps) {
      if (op.type === "delete") {
        const startPos = this.convertCharPosToLineCol(
          contextText,
          op.startPos,
          context.startLine,
          0
        );
        const endPos = this.convertCharPosToLineCol(
          contextText,
          op.endPos,
          context.startLine,
          0
        );
        await this.nvim.call("nvim_buf_set_extmark", [
          context.bufferId,
          ns,
          startPos.row,
          startPos.col,
          {
            end_row: endPos.row,
            end_col: endPos.col,
            hl_group: "VioletPredictionDelete",
          },
        ]);
      }

      if (op.type === "insert") {
        const insertPos = this.convertCharPosToLineCol(
          contextText,
          op.insertAfterPos,
          context.startLine,
          0
        );
        const insertLines = op.text.split("\n");

        if (insertLines.length === 1) {
          await this.nvim.call("nvim_buf_set_extmark", [
            context.bufferId,
            ns,
            insertPos.row,
            insertPos.col,
            {
              virt_text: [[insertLines[0], "VioletPredictionInsert"]],
              virt_text_pos: "inline",
              right_gravity: false,
            },
          ]);
        } else {
          await this.nvim.call("nvim_buf_set_extmark", [
            context.bufferId,
            ns,
            insertPos.row,
            insertPos.col,
            {
              virt_text: [[insertLines[0], "VioletPredictionInsert"]],
              virt_text_pos: "inline",
              virt_lines: insertLines
                .slice(1)
                .map((line) => [[line, "VioletPredictionInsert"]]),
              right_gravity: false,
            },
          ]);
        }
      }
    }

    await this.setPredictionActive(true);
  }

  private async captureContextWindow(): Promise<CapturedContext> {
    const bufferId = await this.nvim.call<number>("nvim_get_current_buf", []);
    const cursor = await this.nvim.call<[number, number]>(
      "nvim_win_get_cursor",
      [0]
    );
    const totalLines = await this.nvim.call<number>("nvim_buf_line_count", [
      bufferId,
    ]);
    const bufferName = await this.nvim.call<string>("nvim_buf_get_name", [
      bufferId,
    ]);

    const cursorRow = cursor[0] - 1;
    const cursorCol = cursor[1];
    const startLine = Math.max(0, cursorRow - 10);
    const endLine = Math.min(totalLines - 1, cursorRow + 20);

    const contextLines = await this.nvim.call<string[]>(
      "nvim_buf_get_lines",
      [bufferId, startLine, endLine + 1, false]
    );

    return {
      contextLines,
      cursorDelta: cursorRow - startLine,
      cursorCol,
      bufferName,
      bufferId,
      startLine,
      endLine,
      totalLines,
    };
  }

  private composeUserMessage(context: CapturedContext): string {
    return buildPredictionPrompt({
      contextLines: context.contextLines,
      cursorLine: context.cursorDelta,
      cursorCol: context.cursorCol,
      bufferName: context.bufferName,
      startLine: context.startLine,
      endLine: context.endLine,
      recentChanges: this.changeTracker.getChanges(),
      tokenBudget: this.recentChangeTokenBudget,
    });
  }

  private async triggerPrediction(): Promise<void> {
    const requestId = ++this.requestCounter;
    const context = await this.captureContextWindow();

    this.state = { type: "awaiting-agent-reply", requestId, context };

    const userMessage = this.composeUserMessage(context);
    await log("=== Edit Prediction Request ===");
    await log("Prompt:", userMessage);

    await this.showCompletingIndicator(context);

    let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
    try {
      response = await this.client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 4096,
        system: PREDICTION_SYSTEM_PROMPT,
        tools: [predictEditTool],
        tool_choice: { type: "tool", name: predictEditTool.name },
        messages: [{ role: "user", content: userMessage }],
      });
    } catch (err) {
      await this.clearVirtualText();
      await this.cleanupPredictionListeners(context.bufferId);
      this.state = { type: "idle" };

      const message = err instanceof Error ? err.message : String(err);
      await this.nvim.call("nvim_notify", [
        `violet.nvim: edit prediction failed: ${message}`,
        3,
        {},
      ]);
      throw err;
    }

    if (
      this.state.type !== "awaiting-agent-reply" ||
      this.state.requestId !== requestId
    ) {
      return;
    }

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      await this.clearVirtualText();
      await this.cleanupPredictionListeners(context.bufferId);
      this.state = { type: "idle" };
      const error = new Error("No tool use in prediction response");
      await this.nvim.call("nvim_notify", [
        `violet.nvim: edit prediction failed: ${error.message}`,
        3,
        {},
      ]);
      throw error;
    }

    const prediction = toolUse.input as PredictEditInput;
    this.state = { type: "displaying-proposed-edit", context, prediction };

    await this.setupPredictionListeners();
    await this.showVirtualTextPreview(context, prediction);
  }

  private async acceptPrediction(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    const { context, prediction } = this.state;
    this.state = { type: "prediction-being-applied", context, prediction };

    await this.clearVirtualText();
    await this.cleanupPredictionListeners(context.bufferId);

    const currentLines = await this.nvim.call<string[]>(
      "nvim_buf_get_lines",
      [context.bufferId, context.startLine, context.endLine + 1, false]
    );

    for (let i = 0; i < context.contextLines.length; i += 1) {
      if (currentLines[i] !== context.contextLines[i]) {
        this.state = { type: "idle" };
        throw new Error("Context window has changed since prediction was made");
      }
    }

    const contextText = context.contextLines.join("\n");
    const findText = this.resolveFindText(prediction.find, contextText);
    const replacedText = contextText.split(findText).join(prediction.replace);
    const replacedLines = replacedText === "" ? [] : replacedText.split("\n");

    await this.nvim.call("nvim_buf_set_lines", [
      context.bufferId,
      context.startLine,
      context.endLine + 1,
      false,
      replacedLines,
    ]);

    const firstMatchPos = contextText.indexOf(findText);
    if (firstMatchPos !== -1) {
      const newPos = this.convertCharPosToLineCol(
        replacedText,
        firstMatchPos + prediction.replace.length,
        context.startLine,
        0
      );
      await this.nvim.call("nvim_win_set_cursor", [
        0,
        [newPos.row + 1, newPos.col],
      ]);
    }

    this.state = { type: "idle" };
  }

  private async setPredictionActive(active: boolean): Promise<void> {
    try {
      await this.nvim.call("nvim_exec_lua", [
        `require("violet").set_prediction_active(${active ? "true" : "false"})`,
        [],
      ]);
    } catch {
      // Ignore if Lua side isn't ready yet.
    }
  }
}
