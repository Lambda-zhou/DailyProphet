import type { RawArticle } from "./types";

/**
 * V2EX 「最热门技术帖子」抓取。
 *
 * 实现选择：用 /api/topics/show.json?node_name=X 拉每个**技术节点**的 topics，
 * 然后按 replies 字段排序取 top N。这是 V2EX 公开 API 里**唯一**能拿到
 * 「回复数」（= 真实热度）的端点：
 *   - /api/topics/hot.json：全站热议，但 80% 是 promotions / taste / life
 *     节点的非技术帖（实测过），过滤完剩不下几条。
 *   - 各节点的 atom feed (/feed/<node>.xml)：是按发布时间序，不含 replies
 *     字段，所以无法按热度排序，会混进很多 0 回复的新帖。
 *
 * 因此选择「节点级 show.json + 按 replies 排序 + 丢掉 0 回复」这个组合，
 * 同时具备：节点天然过滤掉非技术内容 + replies 排序对齐"最热门"语义。
 *
 * 共享 V2EX_OFF_TOPIC_RE 作为标题级兜底（lib/sources/linuxdo.ts 也用）。
 */

const TECH_NODES = [
  "programmer", // 程序员（最活跃的综合技术节点）
  "dev", // 开发
  "python",
  "golang",
  "linux",
  "apple", // macOS 开发
  "rust",
  "ai", // AI 相关讨论
];

/**
 * 标题层面的兜底过滤 — 即使来自技术节点，部分帖子仍是生活/感情/广告/吐槽。
 * 命中即丢弃。同时被 lib/sources/linuxdo.ts 和 lib/output/render.ts 引用。
 *
 * 命名保留 V2EX_ 前缀仅出于历史原因 — 实际是中文社区通用过滤规则。
 */
export const V2EX_OFF_TOPIC_RE =
  /(足浴|按摩|捏\s*jio|相亲|对象|男友|女友|分手|婆|岳|家暴|出轨|彩礼|9\.9\s*元|抽奖|薅羊毛|代理\s*IP|住宅\s*IP|跨境\s*(卖家|IP|电商)|辣椒\s*HTTP|买房|买车|装修|房贷|养老|退休|结婚|生娃|带娃|养娃|减肥|健身|租房|搬家|签证|移民|岛主|离职|裸辞|老赖|存款|新人报道|无聊|发小|废了|工资|加班吐槽|找工作|失业|找对象)/i;

interface V2exTopic {
  id: number;
  title: string;
  url: string;
  content?: string;
  replies: number;
  created: number;
  last_touched?: number;
  node?: { name: string; title?: string };
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; DailyBriefBot/1.0)",
  Accept: "application/json",
} as const;

async function fetchNode(node: string): Promise<V2exTopic[]> {
  try {
    const r = await fetch(
      `https://www.v2ex.com/api/topics/show.json?node_name=${node}`,
      {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) return [];
    return (await r.json()) as V2exTopic[];
  } catch {
    return [];
  }
}

export async function fetchV2ex(
  sourceId: string,
  limit = 25,
): Promise<RawArticle[]> {
  const lists = await Promise.all(TECH_NODES.map(fetchNode));

  const seen = new Set<string>();
  const candidates: Array<{ topic: V2exTopic; nodeTitle: string }> = [];

  for (const list of lists) {
    for (const t of list) {
      if (!t.url || !t.title) continue;
      if (seen.has(t.url)) continue;
      if (V2EX_OFF_TOPIC_RE.test(t.title)) continue;
      // Drop 0-reply posts: user-stated requirement is "最热门 10 个"
      // — a 0-reply post is by definition not hot, no matter how recent.
      if ((t.replies ?? 0) === 0) continue;
      seen.add(t.url);
      candidates.push({
        topic: t,
        nodeTitle: t.node?.title ?? t.node?.name ?? "?",
      });
    }
  }

  // Sort by reply count desc — closest available proxy for "hot"
  candidates.sort((a, b) => b.topic.replies - a.topic.replies);

  return candidates.slice(0, limit).map(({ topic, nodeTitle }) => ({
    sourceId,
    title: topic.title,
    url: topic.url,
    excerpt: `${topic.replies} 回复 · ${nodeTitle} 节点`,
    publishedAt: topic.created ? new Date(topic.created * 1000) : undefined,
    category: "tech" as const,
  }));
}
