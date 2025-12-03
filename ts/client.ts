import Anthropic from "@anthropic-ai/sdk";
import { getClaudeCodeTokens } from "./auth.ts";

const CLAUDE_CODE_SPOOF =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export async function createClient(): Promise<Anthropic> {
  const tokens = await getClaudeCodeTokens();

  return new Anthropic({
    apiKey: "dummy",
    fetch: async (input, init) => {
      return fetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          authorization: `Bearer ${tokens.accessToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        },
      });
    },
  });
}

export { CLAUDE_CODE_SPOOF };
