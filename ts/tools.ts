import type Anthropic from "@anthropic-ai/sdk";

export const inlineEditTool: Anthropic.Tool = {
  name: "inline_edit",
  description:
    "Replace text. You will only get one shot so do the whole edit in a single tool invocation.",
  input_schema: {
    type: "object" as const,
    properties: {
      find: {
        type: "string",
        description:
          "The text to replace. This should be the exact and complete text to replace, including indentation. Regular expressions are not supported. If the text appears multiple times, only the first match will be replaced.",
      },
      replace: {
        type: "string",
        description:
          "New content that will replace the existing text. This should be the complete text - do not skip lines or use ellipsis.",
      },
    },
    required: ["find", "replace"],
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
          "New content that will replace the existing text. This should be the complete text - do not skip lines or use ellipsis.",
      },
    },
    required: ["replace"],
  },
};

export type InlineEditInput = {
  find: string;
  replace: string;
};

export type ReplaceSelectionInput = {
  replace: string;
};
