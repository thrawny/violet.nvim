import { createClient, CLAUDE_CODE_SPOOF } from "./client.ts";

async function main() {
  const client = await createClient();

  console.log("Testing Claude Max connection...");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system: CLAUDE_CODE_SPOOF,
    messages: [{ role: "user", content: "Say 'violet.nvim works!' and nothing else." }],
  });

  for (const block of response.content) {
    if (block.type === "text") {
      console.log(block.text);
    }
  }
}

main();
