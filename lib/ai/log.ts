import fs from "node:fs";

export type LlmErrorCategory = "timeout" | "quota" | "auth" | "other" | null;

export interface LlmCallRecord {
  ts: string;
  backend: string;
  model: string;
  durationMs: number;
  success: boolean;
  inputChars: number;
  outputChars: number;
  errorCategory: LlmErrorCategory;
  errorSnippet: string | null;
}

const LOG_PATH = "logs/llm-calls.jsonl";

export function logLlmCall(record: LlmCallRecord): void {
  try {
    fs.mkdirSync("logs", { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Logging failures must never break the actual LLM pipeline.
  }
}

const QUOTA_PATTERN =
  /(rate.?limit|usage.?limit|quota|429|too many requests|credit.?balance|insufficient.?balance)/i;

const AUTH_PATTERN =
  /(401|403|unauthorized|invalid.?api.?key|authentication|forbidden)/i;

export function classifyError(blob: string): LlmErrorCategory {
  if (!blob.trim()) return null;
  if (/timeout|timed out|etimedout/i.test(blob)) return "timeout";
  if (QUOTA_PATTERN.test(blob)) return "quota";
  if (AUTH_PATTERN.test(blob)) return "auth";
  return "other";
}
