import { createClient } from "./client.ts";
import {
  buildPrompt,
  SYSTEM_PROMPT,
  type InlineEditRequest,
  type Selection,
} from "./inline-edit.ts";
import {
  inlineEditTool,
  replaceSelectionTool,
  type InlineEditInput,
  type ReplaceSelectionInput,
} from "./tools.ts";

type NormalModeExpected = {
  startLine: number;
  endLine: number;
  replace: string;
};

type SelectionModeExpected = {
  replace: string;
};

type TestCase = {
  name: string;
  fileContent: string;
  filePath: string;
  cursorLine: number;
  instruction: string;
  selection?: Selection;
  expected: (NormalModeExpected | SelectionModeExpected)[];
};

const tests: TestCase[] = [
  // Normal mode: replace single line
  {
    name: "replace single line",
    fileContent: "const x = 1",
    filePath: "test.ts",
    cursorLine: 1,
    instruction: "change the value to 42",
    expected: [{ startLine: 1, endLine: 1, replace: "const x = 42" }],
  },
  // Normal mode: insert new line after cursor
  {
    name: "insert line after cursor",
    fileContent: "line one\nline two\nline three",
    filePath: "test.txt",
    cursorLine: 2,
    instruction: "add a new line saying 'inserted' after this line",
    expected: [
      // Insert pattern: endLine < startLine
      { startLine: 3, endLine: 2, replace: "inserted" },
      // Replace pattern: include original line + new line
      { startLine: 2, endLine: 2, replace: "line two\ninserted" },
    ],
  },
  // Normal mode: delete line
  {
    name: "delete current line",
    fileContent: "keep this\ndelete me\nkeep this too",
    filePath: "test.txt",
    cursorLine: 2,
    instruction: "delete this line",
    expected: [{ startLine: 2, endLine: 2, replace: "" }],
  },
  // Selection mode: transform text
  {
    name: "uppercase selection",
    fileContent: "hello world",
    filePath: "test.txt",
    cursorLine: 1,
    selection: {
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 5,
      text: "hello",
    },
    instruction: "uppercase this",
    expected: [{ replace: "HELLO" }],
  },
  // Selection mode: wrap in quotes
  {
    name: "wrap selection in quotes",
    fileContent: "const name = jonas",
    filePath: "test.ts",
    cursorLine: 1,
    selection: {
      startLine: 1,
      startCol: 14,
      endLine: 1,
      endCol: 18,
      text: "jonas",
    },
    instruction: "wrap in double quotes",
    expected: [{ replace: '"jonas"' }],
  },
];

function isSelectionMode(
  test: TestCase
): test is TestCase & { selection: Selection } {
  return test.selection !== undefined;
}

function isNormalModeExpected(
  expected: NormalModeExpected | SelectionModeExpected
): expected is NormalModeExpected {
  return "startLine" in expected;
}

async function runTest(
  client: Awaited<ReturnType<typeof createClient>>,
  test: TestCase
): Promise<{ pass: boolean; actual: unknown; error?: string }> {
  const req: InlineEditRequest = {
    bufnr: 0,
    filePath: test.filePath,
    fileContent: test.fileContent,
    cursorLine: test.cursorLine,
    cursorCol: 1,
    instruction: test.instruction,
    selection: test.selection,
  };

  const tool = isSelectionMode(test) ? replaceSelectionTool : inlineEditTool;
  const prompt = buildPrompt(req);

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { pass: false, actual: null, error: "No tool use in response" };
  }

  const actual = toolUse.input;

  if (isSelectionMode(test)) {
    const actualInput = actual as ReplaceSelectionInput;
    const pass = test.expected.some(
      (exp) => (exp as SelectionModeExpected).replace === actualInput.replace
    );
    return { pass, actual };
  } else {
    const actualInput = actual as InlineEditInput;
    const pass = test.expected.some((exp) => {
      const e = exp as NormalModeExpected;
      return (
        e.startLine === actualInput.startLine &&
        e.endLine === actualInput.endLine &&
        e.replace === actualInput.replace
      );
    });
    return { pass, actual };
  }
}

async function main() {
  console.log("Creating client...");
  const client = await createClient();

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    process.stdout.write(`Running: ${test.name}... `);
    try {
      const result = await runTest(client, test);
      if (result.pass) {
        console.log("✓ PASS");
        passed++;
      } else {
        console.log("✗ FAIL");
        console.log("  Expected one of:");
        for (const exp of test.expected) {
          console.log("    -", JSON.stringify(exp));
        }
        console.log("  Actual:", JSON.stringify(result.actual));
        if (result.error) {
          console.log("  Error:", result.error);
        }
        failed++;
      }
    } catch (err) {
      console.log("✗ ERROR");
      console.log("  ", err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
