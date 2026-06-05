"""Article extraction: HTML → markdown with local images."""
import re
import hashlib
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
import trafilatura
from markdownify import markdownify

from .strategy import UA_NORMAL, TIMEOUT


def extract_article(html: str, url: str, dom_result: dict | None = None) -> dict:
    """Extract article content from HTML. Returns dict with title, text, markdown, images.

    If dom_result is provided (from browser DOM extraction), use it directly.
    """
    if dom_result and dom_result.get("text") and len(dom_result["text"]) > 200:
        images = [img["src"] for img in dom_result.get("images", [])]
        return {
            "title": dom_result.get("title", ""),
            "author": "",
            "date": "",
            "text": dom_result["text"],
            "images": images,
            "url": url,
        }

    result = trafilatura.extract(
        html,
        url=url,
        include_images=True,
        include_links=True,
        include_tables=True,
        output_format="txt",
        favor_precision=False,
        favor_recall=True,
    )

    metadata = trafilatura.extract(
        html,
        url=url,
        output_format="xmltei",
        include_images=False,
        favor_recall=True,
    )

    title = _extract_title(html, metadata)
    author = _extract_author(metadata)
    date = _extract_date(metadata)
    images = _extract_image_urls(html, url)

    md_content = _clean_paywall_text(result or "")

    return {
        "title": title,
        "author": author,
        "date": date,
        "text": md_content,
        "images": images,
        "url": url,
    }


def article_to_markdown(article: dict, images_dir: str = "images") -> str:
    """Convert extracted article to markdown with frontmatter."""
    lines = []
    lines.append("---")
    lines.append(f"title: \"{_escape_yaml(article['title'])}\"")
    if article.get("author"):
        lines.append(f"author: \"{_escape_yaml(article['author'])}\"")
    if article.get("date"):
        lines.append(f"date: {article['date']}")
    lines.append(f"source: {article['url']}")
    lines.append("---")
    lines.append("")
    lines.append(f"# {article['title']}")
    lines.append("")

    text = article["text"]

    # Strip paywall markers from text
    for marker in ["Enjoying our latest content?", "Log in or create an account to continue",
                   "Subscribe to continue reading", "Already a subscriber?"]:
        idx = text.find(marker)
        if idx > 0:
            text = text[:idx].rstrip()

    # Embed first image as hero, rest at end
    if article.get("images"):
        fname = _image_filename(article["images"][0], 0)
        lines.append(f"![image]({images_dir}/{fname})")
        lines.append("")

    lines.append(text)

    # Remaining images at end
    if article.get("images") and len(article["images"]) > 1:
        lines.append("")
        for i, img_url in enumerate(article["images"][1:], 1):
            fname = _image_filename(img_url, i)
            lines.append(f"![image]({images_dir}/{fname})")
            lines.append("")

    return "\n".join(lines)


async def download_images(
    image_urls: list[str],
    out_dir: Path,
    max_images: int = 20,
    client: httpx.AsyncClient | None = None,
) -> list[Path]:
    """Download images to out_dir. Returns list of saved paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(follow_redirects=True, timeout=TIMEOUT)

    saved: list[Path] = []
    try:
        for i, url in enumerate(image_urls[:max_images]):
            try:
                resp = await client.get(url, headers={"User-Agent": UA_NORMAL})
                if resp.status_code == 200 and len(resp.content) > 1024:
                    fname = _image_filename(url, i)
                    path = out_dir / fname
                    path.write_bytes(resp.content)
                    saved.append(path)
            except Exception:
                continue
    finally:
        if own_client:
            await client.aclose()
    return saved


def _extract_title(html: str, metadata: str | None) -> str:
    m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
    title = m.group(1).strip() if m else ""
    if metadata:
        m2 = re.search(r"<title[^>]*>([^<]+)</title>", metadata)
        if m2:
            title = m2.group(1).strip()
    return title.split("|")[0].split(" - ")[0].strip()


def _extract_author(metadata: str | None) -> str:
    if not metadata:
        return ""
    m = re.search(r'<author[^>]*>.*?<persName>([^<]+)</persName>', metadata, re.DOTALL)
    return m.group(1).strip() if m else ""


def _extract_date(metadata: str | None) -> str:
    if not metadata:
        return ""
    m = re.search(r'when="(\d{4}-\d{2}-\d{2})"', metadata)
    return m.group(1) if m else ""


def _extract_image_urls(html: str, base_url: str) -> list[str]:
    """Extract article images only — skip UI, nav, footer, sidebar images."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')

    # Find article container
    article = (
        soup.find('article') or
        soup.find(attrs={"data-article": True}) or
        soup.find(class_=re.compile(r'article.body|story.body|post.content|entry.content'))
    )
    container = article if article else soup.find('main') or soup.body

    if not container:
        return []

    urls = []
    seen = set()
    skip_patterns = ["pixel", "tracking", "1x1", "logo", "icon", "avatar", "badge",
                     "button", "arrow", "spinner", "loading", "placeholder", "svg+xml",
                     "data:image", "gravatar", "emoji", "widget"]

    for img in container.find_all('img', src=True):
        src = img.get('src', '')
        if not src or any(skip in src.lower() for skip in skip_patterns):
            continue
        # Skip tiny images (likely icons)
        width = img.get('width', '')
        height = img.get('height', '')
        if width and width.isdigit() and int(width) < 50:
            continue
        if height and height.isdigit() and int(height) < 50:
            continue
        full = urljoin(base_url, src)
        if full not in seen:
            seen.add(full)
            urls.append(full)

    return urls[:20]


def _image_filename(url: str, index: int) -> str:
    parsed = urlparse(url)
    ext = Path(parsed.path).suffix or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"):
        ext = ".jpg"
    h = hashlib.md5(url.encode()).hexdigest()[:8]
    return f"img_{index:03d}_{h}{ext}"


def _escape_yaml(s: str) -> str:
    return s.replace('"', '\\"').replace("\n", " ")


def _clean_paywall_text(text: str) -> str:
    """Remove paywall/login prompts that leak into extracted text."""
    markers = [
        "Enjoying our latest content?",
        "Log in or create an account to continue",
        "Subscribe to continue reading",
        "Already a subscriber? Sign in",
        "Sign in to continue",
        "Create a free account to continue",
        "Register for free to continue reading",
        "Want to read more?",
        "Access the most recent journalism",
        "Explore the latest features & opinion",
    ]
    for marker in markers:
        idx = text.find(marker)
        if idx > 0:
            text = text[:idx].rstrip()
    # Also strip trailing "or" / login button text
    for tail in ["\nor\n", "\nor", "\nSign in", "\nLog in", "\nSubscribe"]:
        if text.endswith(tail):
            text = text[:-len(tail)].rstrip()
    return text
