/**
 * Smoke test for the zhipu LLM backend.
 *
 * Usage:
 *   ZHIPU_API_KEY=your-key npx tsx scripts/test-zhipu.ts
 *
 * Optional env vars:
 *   ZHIPU_BASE_URL  — override default base URL
 *   LLM_MODEL       — override default model (glm-4-flash)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runLlm, getBackend, getModelTag } from "../lib/ai/llm";

process.env.LLM_BACKEND = "zhipu";

async function main() {
  const backend = getBackend();
  const tag = getModelTag();
  console.log(`Backend: ${backend}`);
  console.log(`Model tag: ${tag}`);
  console.log("Calling zhipu API...\n");

  const result = await runLlm({
    systemPrompt: "You are a helpful assistant. Respond in one short sentence.",
    userPrompt: "Hello! What is 2+2?",
    timeoutMs: 30_000,
  });

  console.log(`Response (${result.durationMs}ms):`);
  console.log(result.text);
  console.log("\n✓ Zhipu backend works!");
}

main().catch((err) => {
  console.error("✗ Zhipu backend failed:", err.message);
  process.exit(1);
});
