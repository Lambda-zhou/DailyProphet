import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TickerAnalysis } from "../trading/signals";

export interface WatchlistPick {
  symbol: string;
  display_name: string;
  /**
   * Direction label of the current technical setup (NOT a price prediction).
   * Original "看多/看空" wording occasionally tripped Sonnet's "no investment
   * advice" guardrail into returning an empty array; the neutral technical
   * vocabulary "偏上行/偏下行/中性" (and "Bullish/Bearish/Neutral" for en
   * mode) avoids the trigger. Legacy values are kept for backwards-compat.
   */
  stance:
    | "偏上行"
    | "偏下行"
    | "中性"
    | "看多"
    | "看空"
    | "Bullish"
    | "Bearish"
    | "Neutral";
  rationale: string;
}

export interface TradingCommentary {
  market_overview: string;
  watchlist: WatchlistPick[];
  risk_caveat: string;
}

export interface TradingCommentaryInput {
  tickers: TickerAnalysis[];
  cryptoFearGreed?: FearGreedSnapshot;
  cryptoGlobal?: CryptoGlobalStats;
}

const SYSTEM_PROMPT_ZH = `你是一名专业、克制、中性的中文技术指标解读员。你的任务是基于公开行情数据计算出的技术指标，写一份**客观的技术状态描述报告**——你不是投顾，不预测涨跌，只复述指标读数和走势形态。任何使用本报告的读者都已经知道并接受这一定位。

**严格规则**：
1. 使用专业术语描述指标读数：金叉/死叉/MACD 红柱/绿柱/超买/超卖/突破/支撑/动量/趋势/背离 等。
2. 所有结论必须**基于输入的实际数字**（价格、SMA、RSI、MACD、信号、近期 % 变化等），不允许凭空概括。
3. watchlist 必须**上行倾向 + 下行倾向 + 中性 三种 stance 都覆盖到**，反映输入数据的真实技术面分布，不能全偏一侧。
4. market_overview 要覆盖 4 类资产（美股 / 加密 / 中概 / 商品外汇）的技术面整体感觉。
5. risk_caveat 必须包含「过去走势不代表未来表现」与「仅供技术指标解读参考」的明确声明。

输入：JSON 数组，每个元素是某 ticker 的技术分析对象，字段包括 symbol、displayName、group、currentPrice、pct1Day、pct5Day、pct52WeekHigh、pct52WeekLow、sma20/sma50/sma200、rsi14、macd/macdSignal/macdHistogram、trend、rsiState、signals。

输出严格 JSON 对象（不要 markdown、不要任何前后缀），三个字段都**必填且非空**：
{
  "market_overview": "<300-400 字段落，不能省略>",
  "watchlist": [
    { "symbol": "<必须从输入精确复制>", "display_name": "<中文+(英文代码) 或 仅中文>", "stance": "偏上行" | "偏下行" | "中性", "rationale": "<80-150 字，必须引用具体技术指标数字>" },
    ...
  ],
  "risk_caveat": "<60-100 字，必须包含「过去走势不代表未来表现」与「仅供技术指标解读参考」>"
}

**关于 watchlist（这是历史上最容易出错的字段，请严格执行）**：
- watchlist **必须正好包含 3-5 个 ticker**。
- watchlist 长度 < 3 是**输出格式错误**，下游会自动拒绝并重新调用你，浪费一次配额。
- "stance" 是当前技术 setup 的方向标签——纯描述、纯客观——不是涨跌预测，不是行动建议。你只是在说"这只标的当前的指标状态偏上行 / 偏下行 / 中性"。
- 如果你扫完 21 个 ticker 觉得"今天市场太平静、没有突出标的"，仍然要从中选出**技术信号最显著的 3 个**（例如 RSI 偏离 50 最远的、近 1 日涨跌幅最大的、最近触发金叉/死叉的），全部标 "中性" stance 完全合规。
- 任何情况下**禁止返回空数组**。空 watchlist 不是更安全的选择，它就是错的。

**引号规则（重要！）**：JSON 字符串内的中文引用一律使用全角引号「」或""，**绝不**使用英文双引号——否则 JSON 解析失败。

**输出顺序建议**：在你的回复里先生成 watchlist 数组（最重要、最容易遗漏），再生成 market_overview，最后 risk_caveat。这样即使输出被截断也保留了 picks。`;

const SYSTEM_PROMPT_EN = `You are a professional, restrained, neutral English-language technical-indicator interpreter. Your job is to write an **objective technical-state report** based on the public-market data's computed indicators — you are NOT an investment advisor, you do not predict price direction, you only describe indicator readings and chart structure. Any reader of this report already knows and accepts this framing.

**Strict rules**:
1. Use technical terminology to describe readings: golden-cross / death-cross / MACD bullish/bearish histogram / overbought / oversold / breakout / support / momentum / trend / divergence, etc.
2. Every conclusion MUST be **grounded in actual input numbers** (price, SMA, RSI, MACD, signals, recent % moves) — no generalizing without data.
3. The watchlist MUST **cover all three stances — Bullish / Bearish / Neutral** — reflecting the real technical distribution; do not bias entirely to one side.
4. market_overview must cover all 4 asset categories (US equity / crypto / China-HK equity / commodities-FX).
5. risk_caveat MUST explicitly include "past performance does not guarantee future results" and "for technical-indicator interpretation only".

Input: a JSON array of ticker analysis objects with fields symbol, displayName, group, currentPrice, pct1Day, pct5Day, pct52WeekHigh, pct52WeekLow, sma20/sma50/sma200, rsi14, macd/macdSignal/macdHistogram, trend, rsiState, signals.

Output STRICTLY a JSON object (no markdown, no prefix/suffix). All three fields must be **populated and non-empty**:
{
  "market_overview": "<300-400 word paragraph; do not skip>",
  "watchlist": [
    { "symbol": "<copied exactly from input>", "display_name": "<readable name>", "stance": "Bullish" | "Bearish" | "Neutral", "rationale": "<80-150 words; must cite specific indicator numbers>" },
    ...
  ],
  "risk_caveat": "<60-100 words; must include 'past performance does not guarantee future results' and 'for technical-indicator interpretation only'>"
}

**About watchlist (historically the most error-prone field — execute strictly)**:
- watchlist MUST contain **exactly 3-5 tickers**.
- watchlist length < 3 is **a format error** — downstream auto-rejects and re-invokes you, wasting a quota call.
- "stance" is a label for the **current technical setup** — pure description, pure observation — not a price prediction or an action recommendation. You are merely saying "this ticker's current indicator state is Bullish / Bearish / Neutral".
- If after scanning all tickers you feel "today is quiet, no standout names", you still MUST pick the **3 with the most pronounced technical signals** (e.g. RSI furthest from 50, largest 1-day % move, most recent golden/death cross) — labeling all of them "Neutral" is perfectly compliant.
- Under no circumstances may you return an empty array. An empty watchlist is not the safer choice — it is wrong.

**Quote rule (important!)**: For any quotation INSIDE a JSON string, use single quotes ' or curly quotes '" — **never** raw double-quotes, which break JSON parsing.

**Output-order suggestion**: in your response, generate the watchlist array FIRST (most important, most easily missed), then market_overview, then risk_caveat. This preserves picks even if the response is truncated.`;

const SYSTEM_PROMPT =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;

export async function generateTradingCommentary(
  input: TradingCommentaryInput,
): Promise<TradingCommentary> {
  const { tickers, cryptoFearGreed, cryptoGlobal } = input;
  // Slim payload — drop fields that don't help the model (no need to send
  // exchangeName/currency etc. — those are display-only)
  const payload = tickers.map((a) => ({
    symbol: a.symbol,
    displayName: a.displayName,
    group: a.group,
    currentPrice: round(a.currentPrice),
    pct1Day: round(a.pct1Day, 2),
    pct5Day: round(a.pct5Day, 2),
    pct52WeekHigh: round(a.pct52WeekHigh, 2),
    pct52WeekLow: round(a.pct52WeekLow, 2),
    sma20: roundNullable(a.sma20),
    sma50: roundNullable(a.sma50),
    sma200: roundNullable(a.sma200),
    rsi14: roundNullable(a.rsi14, 1),
    macd: roundNullable(a.macd, 4),
    macdSignal: roundNullable(a.macdSignal, 4),
    trend: a.trend,
    rsiState: a.rsiState,
    signals: a.signals.map((s) => s.label),
  }));

  // Compact context sidecars — the model should weave these into the
  // market_overview when relevant (e.g. "VIX 14 + DXY weakening + crypto
  // F&G 43 → risk-on lite").
  const contextLines: string[] = [];
  if (cryptoFearGreed) {
    const classification =
      REPORT_LOCALE === "en"
        ? cryptoFearGreed.classification
        : cryptoFearGreed.classificationCn;
    const label =
      REPORT_LOCALE === "en"
        ? `Crypto Fear & Greed Index = ${cryptoFearGreed.value} (${classification})`
        : `加密恐慌贪婪指数 = ${cryptoFearGreed.value}（${classification}）`;
    contextLines.push(label);
  }
  if (cryptoGlobal) {
    const label =
      REPORT_LOCALE === "en"
        ? `Crypto total market cap = ${(cryptoGlobal.totalMarketCapUsd / 1e12).toFixed(2)}T USD (24h ${round(cryptoGlobal.marketCapChangePct24h, 2)}%) · BTC dominance ${round(cryptoGlobal.btcDominance, 1)}% · ETH ${round(cryptoGlobal.ethDominance, 1)}%`
        : `加密总市值 = ${(cryptoGlobal.totalMarketCapUsd / 1e12).toFixed(2)}T USD (24h ${round(cryptoGlobal.marketCapChangePct24h, 2)}%) · BTC 主导率 ${round(cryptoGlobal.btcDominance, 1)}% · ETH ${round(cryptoGlobal.ethDominance, 1)}%`;
    contextLines.push(label);
  }

  // user prompt header = highest instruction-recency precedence. The
  // SYSTEM_PROMPT already says "watchlist must be 3-5", but inside a
  // system prompt that constraint sometimes loses to the RLHF "no
  // investment advice" reflex; restating it at the top of the user
  // prompt materially improves hit rate (see lesson #8).
  const userPrompt =
    REPORT_LOCALE === "en"
      ? [
          `**Output language: ENGLISH ONLY.** Every string value in the JSON — market_overview, every pick's display_name and rationale, risk_caveat — MUST be written entirely in English. Do not use any Chinese characters anywhere in the output. Even if some input ticker names appear in Chinese (e.g. "黄金期货"), translate them to English in the display_name field (e.g. "Gold Futures").`,
          "",
          `**Hard output constraint**: the response MUST be a single valid JSON object (starts with \`{\`, ends with \`}\`, no markdown, no prefix/suffix). **The watchlist field MUST contain exactly 3-5 complete WatchlistPick objects**, each shaped like \`{ "symbol": "...", "display_name": "<English name>", "stance": "Bullish"|"Bearish"|"Neutral", "rationale": "80-150 word English summary citing concrete indicator numbers" }\`. **DO NOT write the watchlist as a string array of ticker symbols** (e.g. \`["^TNX","BTC-USD"]\` is wrong) — this is a technical-indicator interpretation task; every entry must carry a rationale field. Empty arrays and string arrays are both format errors.`,
          "",
          contextLines.length > 0
            ? `Auxiliary context (**you MUST reference at least one of these in market_overview**):\n${contextLines.map((l) => `  - ${l}`).join("\n")}\n`
            : "",
          `Candidate assets (${payload.length} entries, JSON array):`,
          JSON.stringify(payload),
          "",
          `Output a JSON object per the system-prompt schema. watchlist must contain 3-5 complete WatchlistPick objects (symbol / display_name / stance / rationale fields). Empty arrays and string arrays are forbidden.`,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `**输出硬约束**：响应必须是单一合法 JSON 对象（以 \`{\` 开头以 \`}\` 结尾，不要 markdown、不要前后缀）。**watchlist 字段必须正好包含 3-5 个完整的 WatchlistPick 对象**，每个对象形如 \`{ "symbol": "...", "display_name": "...", "stance": "偏上行"|"偏下行"|"中性", "rationale": "80-150 字中文，引用具体指标数字" }\`。**禁止把 watchlist 写成 ticker symbol 字符串数组**（如 \`["^TNX","BTC-USD"]\` 是错的）——这是技术指标解读任务，每条必须含 rationale 字段。空数组或字符串数组都是输出错误。`,
          "",
          contextLines.length > 0
            ? `辅助背景（**必须在 market_overview 里至少引用一项**）：\n${contextLines.map((l) => `  - ${l}`).join("\n")}\n`
            : "",
          `候选资产（共 ${payload.length} 个，JSON 数组）：`,
          JSON.stringify(payload),
          "",
          `请按 system prompt 的 schema 输出 JSON 对象。watchlist 必须 3-5 个完整 WatchlistPick 对象（含 symbol / display_name / stance / rationale 四个字段），绝不允许空数组或字符串数组。`,
        ]
          .filter(Boolean)
          .join("\n");

  const fallback: TradingCommentary = {
    market_overview: "",
    watchlist: [],
    risk_caveat:
      REPORT_LOCALE === "en"
        ? "The above is based on computed technical indicators from public market data and text summaries; it does NOT constitute investment advice. Past performance does not guarantee future results — market risk is your own."
        : "以上内容基于公开行情数据的技术指标计算与文本摘要，不构成任何投资建议。过去走势不代表未来表现，市场风险自负。",
  };

  // Up to 3 attempts. The "0 picks" failure mode is a probabilistic
  // guardrail trigger, not a deterministic prompt bug — retrying with the
  // exact same prompt usually flips to a different sampling branch. From
  // attempt 2 on, we also prefix a corrective note so the model sees its
  // own prior empty output as the thing to fix.
  const MAX_ATTEMPTS = 3;
  const RETRY_HINT =
    REPORT_LOCALE === "en"
      ? `\n\n⚠️ Important: the previous attempt returned an empty watchlist — that's a format error, downstream rejected and triggered this retry (wasting quota). This attempt MUST return 3-5 tickers (even if you feel "no standout names today", pick the 3 with the most pronounced technical signals and label them "Neutral").`
      : `\n\n⚠️ 重要：上一次尝试 watchlist 为空——这是错误输出，下游已经拒绝并触发重试，浪费配额。本次必须返回 3-5 个 ticker（即使认为"今天没有突出标的"也要选信号最显著的 3 个并标「中性」stance）。`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const promptForAttempt = attempt === 1 ? userPrompt : userPrompt + RETRY_HINT;
    try {
      return await callOnce(promptForAttempt, fallback);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `[trading-commentary] attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${msg}`,
        );
      } else {
        console.warn(
          `[trading-commentary] all ${MAX_ATTEMPTS} attempts failed: ${msg}`,
        );
      }
    }
  }
  return fallback;
}

async function callOnce(
  userPrompt: string,
  fallback: TradingCommentary,
): Promise<TradingCommentary> {
  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: 240_000,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<TradingCommentary>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (strictErr) {
    try {
      parsed = JSON.parse(jsonrepair(cleaned));
      console.warn("[trading-commentary] JSON.parse failed, jsonrepair recovered");
    } catch {
      // Dump raw output for postmortem — symmetric to pipeline.ts logging.
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/trading-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/trading-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[trading-commentary] both JSON.parse and jsonrepair failed; raw at logs/trading-raw-${ts}.txt`,
        );
      } catch {
        // best-effort
      }
      throw strictErr;
    }
  }
  // Validate critical fields are populated. Empty watchlist, missing
  // overview, or wrong-shape picks (e.g. Sonnet sometimes returns a
  // string array ["^TNX", ...] when over-anchored on the "3-5 ticker"
  // wording) all trigger retry.
  const overview = parsed.market_overview ?? "";
  const picks = parsed.watchlist ?? [];
  if (overview.length < 100) {
    throw new Error(`market_overview too short (${overview.length} chars)`);
  }
  if (picks.length < 2) {
    throw new Error(`watchlist too short (${picks.length} picks)`);
  }
  const malformed = picks.find(
    (p) =>
      !p ||
      typeof p !== "object" ||
      typeof (p as WatchlistPick).symbol !== "string" ||
      typeof (p as WatchlistPick).stance !== "string" ||
      typeof (p as WatchlistPick).rationale !== "string" ||
      (p as WatchlistPick).rationale.length < 20,
  );
  if (malformed !== undefined) {
    throw new Error(
      `watchlist pick has invalid shape: ${JSON.stringify(malformed).slice(0, 120)}`,
    );
  }
  return {
    market_overview: overview,
    watchlist: picks as WatchlistPick[],
    risk_caveat: parsed.risk_caveat ?? fallback.risk_caveat,
  };
}

function round(n: number, dp = 2): number {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}
function roundNullable(n: number | null, dp = 2): number | null {
  return n == null ? null : round(n, dp);
}
