import type Anthropic from "@anthropic-ai/sdk";

export const inlineEditTool: Anthropic.Tool = {
  name: "inline_edit",
  description:
    "Edit lines in the file. You will only get one shot so do the whole edit in a single tool invocation.",
  input_schema: {
    type: "object" as const,
    properties: {
      startLine: {
        type: "number",
        description: "The 1-indexed line number where the edit starts.",
      },
      endLine: {
        type: "number",
        description:
          "The 1-indexed line number where the edit ends (inclusive). Use the same as startLine to replace a single line. Set endLine = startLine - 1 to insert before startLine without removing anything.",
      },
      replace: {
        type: "string",
        description:
          "The new code/text only. Do NOT include the user's instruction or any explanation - just the raw content to insert.",
      },
    },
    required: ["startLine", "endLine", "replace"],
  },
};

export const replaceSelectionTool: Anthropic.Tool = {
  name: "replace_selection",
  description: "Replace the selected text.",
  input_schema: {
    type: "object" as const,
    properties: {
      replace: {
        type: "string",
        description:
          "The new code/text only. Do NOT include the user's instruction or any explanation - just the raw content.",
      },
    },
    required: ["replace"],
  },
};

export const predictEditTool: Anthropic.Tool = {
  name: "predict_edit",
  description:
    "Predict the user's next edit within the provided context window.",
  input_schema: {
    type: "object" as const,
    properties: {
      find: {
        type: "string",
        description:
          "The exact text to find inside the provided context window. It may include the cursor marker if useful.",
      },
      replace: {
        type: "string",
        description:
          "The replacement text for the find target. Do NOT include any explanation.",
      },
    },
    required: ["find", "replace"],
  },
};

export type InlineEditInput = {
  startLine: number;
  endLine: number;
  replace: string;
};

export type ReplaceSelectionInput = {
  replace: string;
};

export type PredictEditInput = {
  find: string;
  replace: string;
};
