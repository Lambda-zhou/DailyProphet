<p align="center">
  <img src="assets/logo.png" width="128" height="128" alt="bpc-fetch logo">
</p>

<h1 align="center">bpc-fetch</h1>

<p align="center">
  付费墙绕过 — 搜索, 发现, 批量抓取新闻文章为 Markdown
</p>

<p align="center">
  <a href="#支持站点">936 个站点</a> •
  <a href="#功能特点">功能</a> •
  <a href="#安装">安装</a> •
  <a href="#使用方法">使用</a> •
  <a href="#致谢">致谢</a>
</p>

<p align="center">
  <a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-Community-blue?style=flat-square" alt="LINUX DO Community"></a>
</p>

---

## 这是什么?

命令行工具, 覆盖全球 936 个付费新闻站点, 自动绕过 paywall 并将文章保存为 Markdown + 图片. 复用 [Bypass Paywalls Clean](https://gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean) 浏览器扩展的绕过逻辑, 无需安装浏览器扩展即可运行.

## 支持站点

**936 个站点**, 覆盖 40+ 国家/地区:

| 类别 | 代表站点 |
|------|----------|
| 财经商业 | The Economist, Financial Times, Bloomberg, WSJ, Reuters, Forbes, Business Insider |
| 美国新闻 | New York Times, Washington Post, LA Times, Chicago Tribune, Politico |
| 英欧新闻 | The Telegraph, The Times, Der Spiegel, Le Monde, El País |
| 科技科学 | Wired, The Atlantic, Nature, Science, Scientific American, MIT Tech Review |
| 杂志 | The New Yorker, Vanity Fair, Vogue, National Geographic, Esquire |
| 德语区 | 76 站 (FAZ, Handelsblatt, Süddeutsche Zeitung...) |
| 法语区 | 69 站 (Le Figaro, Libération, Les Echos...) |
| 其他 | 荷兰 30, 意大利 28, 西班牙 26, 比利时 22, 澳大利亚 39... |

运行 `bpc-fetch sites` 查看完整列表.

## 功能特点

- **全策略覆盖** — 复用 BPC 扩展全部绕过逻辑: 自定义 UA, Googlebot 伪装, Referer 伪装, Playwright 拦截 paywall JS, archive.org 兜底
- **自动降级链** — 每个 URL 自动尝试最优策略, 逐级降级直到成功
- **文章发现** — RSS / sitemap / 首页解析 / 浏览器渲染, 获取任意站点最近文章列表
- **跨站爬取** — 关键词搜索 + 时间范围过滤 + 并发下载, 一条命令完成
- **Agent 友好** — JSON 输出, stderr 进度信号, 每个命令返回 `next_command`
- **跨平台** — pip install 即用 (Win/Linux/Mac), 也可打包为 Windows 单 exe

## 绕过策略

| 策略 | 站点数 | 方法 |
|------|--------|------|
| `ua:custom` | 7 | 自定义 User-Agent (Liskov, Google-InspectionTool 等) |
| `ua:googlebot` | 85 | Googlebot UA 伪装 |
| `ua:facebookbot` | 5 | Facebook 爬虫 UA |
| `referer:google` | 2 | Google Referer 头 |
| `block_js` | 425 | Playwright 通过 `Page.route()` 拦截 paywall 脚本 |
| `archive` | 274 | 从 archive.org / archive.is 获取缓存 |
| `cookies` | 138 | 不带追踪 cookie 访问 |

## 安装

### pip 安装 (推荐)

```bash
pip install bpc-fetch
playwright install chromium
```

### 从源码安装

```bash
git clone https://github.com/Sophomoresty/bpc-fetch.git
cd bpc-fetch
pip install -e .
playwright install chromium
```

### Windows exe

从 [Releases](https://github.com/Sophomoresty/bpc-fetch/releases) 下载 `bpc-fetch.exe`, 然后:

```
bpc-fetch.exe install-browser
bpc-fetch.exe doctor
```

## 使用方法

```bash
# 环境检测
bpc-fetch doctor

# 查看支持站点
bpc-fetch sites --filter economist

# 发现某站今日文章
bpc-fetch discover economist.com --since today

# 抓取单篇文章
bpc-fetch fetch "https://www.economist.com/..." --out-dir ./articles

# 批量抓取
bpc-fetch batch --file urls.txt --out-dir ./articles

# 跨站爬取: 关键词 + 时间范围
bpc-fetch crawl "AI regulation" --sites economist.com,ft.com --since 7d --out-dir ./ai-articles
```

### 输出格式

```
article-title/
├── article-title.md      # YAML frontmatter + 正文 + 图片引用
└── images/
    ├── img_000_abc1.jpg
    └── img_001_def2.png
```

### Agent 集成

所有命令输出 JSON, 使用 `--compact` 获取精简输出:

```bash
bpc-fetch discover ft.com --since today --compact
# → {"ok": true, "domain": "ft.com", "count": 15, "articles": [...], "next_command": "bpc-fetch batch ..."}
```

### DailyBrief 集成

相邻目录的 `DailyBrief-main` 可以把 `bpc-fetch` 作为 `type=bpc` 数据源使用：`discover` 负责找文章，`batch --incremental --compact` 负责抓 Markdown 正文并返回可复用的 `path`。这让 DailyBrief 保持 Node/TS 报告管线不变，同时把付费墙绕过和正文抽取留在本项目内。

如需固定增量历史库位置，可设置 `BPC_FETCH_HISTORY_DB`。在 Windows 上如果用户目录不可写，程序会自动回退到系统临时目录。

## 打包 Windows exe

```bash
pip install pyinstaller
python build/build_win.py
# 产出: dist/bpc-fetch.exe
```

## 致谢

本工具基于以下项目的绕过逻辑构建:

- **[Bypass Paywalls Clean](https://gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean)** by [magnolia1234](https://gitflic.ru/user/magnolia1234) — 提供站点数据库和绕过策略的原始浏览器扩展. 所有 paywall 绕过研究的功劳归属于 BPC 项目维护者.
- **[LINUX DO](https://linux.do)** — 社区支持与反馈.

## 许可证

MIT — 见 [LICENSE](LICENSE).

`data/sites.js` 文件来自 Bypass Paywalls Clean 项目 (MIT License).
