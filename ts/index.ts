import { attach } from "./nvim.ts";
import { createClient } from "./client.ts";
import { performInlineEdit, type InlineEditRequest } from "./inline-edit.ts";
import { EditPredictionController } from "./edit-prediction.ts";
import { ChangeTracker, type BufferChange } from "./change-tracker.ts";
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

const changeTracker = new ChangeTracker();
const editPrediction = new EditPredictionController(client, nvim, changeTracker);

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
    await nvim.call("nvim_notify", [
      `violet.nvim: inline edit failed: ${message}`,
      3,
      {},
    ]);
    return { success: false, error: message };
  }
});

nvim.onNotification("violetEditPrediction", async () => {
  await log("Received violetEditPrediction notification");
  try {
    await editPrediction.triggerOrAccept();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log("ERROR:", message);
    console.error("violet.nvim: edit prediction failed:", message);
  }
});

nvim.onNotification("violetAcceptPrediction", async () => {
  await log("Received violetAcceptPrediction notification");
  try {
    await editPrediction.acceptPredictionOnly();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log("ERROR:", message);
    console.error("violet.nvim: edit prediction accept failed:", message);
  }
});

nvim.onNotification("violetBufferChange", (args: unknown[]) => {
  const change = args[0] as Omit<BufferChange, "timestamp">;
  changeTracker.addChange(change);
});

nvim.onNotification("violetPredictionDismissed", async (args: unknown[]) => {
  const payload = args[0] as { bufnr?: number } | undefined;
  await editPrediction.dismissPrediction(payload?.bufnr);
});

console.error("violet.nvim: ready");
