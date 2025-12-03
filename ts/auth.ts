import { $ } from "bun";

interface ClaudeOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function getClaudeCodeTokens(): Promise<ClaudeOAuthTokens> {
  const result =
    await $`security find-generic-password -s "Claude Code-credentials" -w | jq -c '.claudeAiOauth'`.text();

  const parsed = JSON.parse(result.trim());

  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
  };
}
