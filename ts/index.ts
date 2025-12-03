import { attach } from "./nvim.ts";
import { createClient } from "./client.ts";
import { performInlineEdit, type InlineEditRequest } from "./inline-edit.ts";
import { log } from "./log.ts";

const socket = process.env["NVIM"];
if (!socket) {
  throw new Error("NVIM socket not provided");
}

await log("=== Violet Starting ===");
await log("NVIM socket:", socket);

const nvim = await attach(socket);
await log("Connected to nvim, channel:", nvim.channelId);

const client = await createClient();
await log("Anthropic client created");

console.error("violet.nvim: connected to neovim");

// Register the bridge with neovim
await nvim.call("nvim_exec_lua", [
  `require("violet").bridge(${nvim.channelId})`,
  [],
]);

// Handle inline edit requests
nvim.onRequest("violetInlineEdit", async (args: unknown[]) => {
  await log("Received violetInlineEdit request");
  const req = args[0] as InlineEditRequest;
  try {
    await performInlineEdit(client, nvim, req);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log("ERROR:", message);
    console.error("violet.nvim: inline edit failed:", message);
    return { success: false, error: message };
  }
});

console.error("violet.nvim: ready");
