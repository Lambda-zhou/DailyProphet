/**
 * Strip the LLM's chatty wrapping (markdown code fences, "Here is the JSON:"
 * preamble) and return just the payload between the first `{` and last `}`.
 * Does NOT validate parsability — callers still pipe the result through
 * JSON.parse with a jsonrepair fallback for unescaped-quote issues.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence) text = fence[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}
