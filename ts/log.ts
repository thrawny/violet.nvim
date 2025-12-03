import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const LOG_FILE = join(import.meta.dir, "..", "violet.log");

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

export async function log(...args: unknown[]): Promise<void> {
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, replacer, 2)))
    .join(" ");
  await appendFile(LOG_FILE, `[${timestamp}] ${message}\n`);
}
