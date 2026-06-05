import Anthropic from "@anthropic-ai/sdk";
import { classifyError, logLlmCall } from "../log";
import type { LlmRunOptions, LlmRunResult } from "../llm";

export interface AnthropicCompatConfig {
  backend: "anthropic" | "zhipu";
  defaultBaseUrl: string | undefined;
  defaultModel: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
}

export const PRESETS: Record<AnthropicCompatConfig["backend"], AnthropicCompatConfig> = {
  anthropic: {
    backend: "anthropic",
    defaultBaseUrl: undefined,
    defaultModel: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
  zhipu: {
    backend: "zhipu",
    defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    defaultModel: "claude-sonnet-4-6",
    apiKeyEnv: "ZHIPU_API_KEY",
    baseUrlEnv: "ZHIPU_BASE_URL",
  },
};

const clientCache = new Map<string, Anthropic>();

function getClient(cfg: AnthropicCompatConfig): { client: Anthropic; model: string } {
  const apiKey = process.env[cfg.apiKeyEnv] || process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      `${cfg.apiKeyEnv} (or generic LLM_API_KEY) is required for LLM_BACKEND=${cfg.backend}. Set it in .env.local.`,
    );
  }
  const baseURL = process.env[cfg.baseUrlEnv]?.trim()
    || process.env.LLM_BASE_URL?.trim()
    || cfg.defaultBaseUrl;
  const model = process.env.LLM_MODEL?.trim() || cfg.defaultModel;

  const cacheKey = `${baseURL ?? "default"}::${apiKey.slice(-6)}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new Anthropic({ apiKey, baseURL });
    clientCache.set(cacheKey, client);
  }
  return { client, model };
}

export function anthropicCompatModel(cfg: AnthropicCompatConfig): string {
  return process.env.LLM_MODEL?.trim() || cfg.defaultModel;
}

export async function runAnthropicCompat(
  opts: LlmRunOptions,
  cfg: AnthropicCompatConfig,
): Promise<LlmRunResult> {
  const { client, model } = getClient(cfg);
  const started = Date.now();
  const inputChars = opts.systemPrompt.length + opts.userPrompt.length;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  try {
    const resp = await client.messages.create(
      {
        model,
        max_tokens: 8192,
        system: opts.systemPrompt,
        messages: [{ role: "user", content: opts.userPrompt }],
      },
      { timeout: timeoutMs },
    );
    const text = resp.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    const durationMs = Date.now() - started;
    logLlmCall({
      ts: new Date(started).toISOString(),
      backend: cfg.backend,
      model,
      durationMs,
      success: true,
      inputChars,
      outputChars: text.length,
      errorCategory: null,
      errorSnippet: null,
    });
    return { text, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    logLlmCall({
      ts: new Date(started).toISOString(),
      backend: cfg.backend,
      model,
      durationMs,
      success: false,
      inputChars,
      outputChars: 0,
      errorCategory: classifyError(msg),
      errorSnippet: msg.slice(0, 200),
    });
    throw err;
  }
}
