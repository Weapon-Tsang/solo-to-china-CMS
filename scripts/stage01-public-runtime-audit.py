"""Read-only public WordPress and rendered-page audit for stage 01."""

import json
import re
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urlparse


BASE = "https://www.solotochina.com"
HEADERS = {"User-Agent": "SoloToChina-Stage01-ReadOnlyAudit/1.0"}


def get(path, limit=500_000):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=HEADERS), timeout=20) as response:
        body = response.read(limit)
        return response.status, response.headers.get("content-type", ""), body


class PageSignals(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = []
        self.meta = []
        self.canonical = False
        self.json_ld = 0

    def handle_starttag(self, tag, attrs):
        props = dict(attrs)
        if tag == "img":
            self.images.append({key: bool(props.get(key)) for key in [
                "src", "srcset", "sizes", "alt", "loading", "fetchpriority"
            ]})
        elif tag == "meta":
            self.meta.append(props.get("name", "") or props.get("property", ""))
        elif tag == "link" and props.get("rel") == "canonical":
            self.canonical = True
        elif tag == "script" and props.get("type") == "application/ld+json":
            self.json_ld += 1


posts_status, _, posts_bytes = get("/wp-json/wp/v2/posts?per_page=1&_fields=id,slug,title,excerpt,featured_media,link")
posts = json.loads(posts_bytes)
media_status, _, media_bytes = get("/wp-json/wp/v2/media?per_page=10&_fields=id,media_type,mime_type,media_details,alt_text,caption")
media = json.loads(media_bytes)
robots_status, _, robots_bytes = get("/robots.txt")
sitemap_status, sitemap_type, sitemap_bytes = get("/wp-sitemap.xml")
if posts and urlparse(posts[0].get("link", "")).netloc in {"www.solotochina.com", "solotochina.com"}:
    article_path = urlparse(posts[0]["link"]).path
    article_status, article_type, article_bytes = get(article_path)
else:
    article_path = "/"
    article_status, article_type, article_bytes = get(article_path)
page = PageSignals()
page.feed(article_bytes.decode("utf-8", errors="replace"))
images = page.images
size_counts = sorted({size for item in media for size in (item.get("media_details") or {}).get("sizes", {})})
output = {
    "version": "stage01-public-runtime-audit-1",
    "readOnly": True,
    "site": BASE,
    "wordpressRest": {"postsStatus": posts_status, "mediaStatus": media_status,
                      "postFields": sorted(posts[0]) if posts else [],
                      "sampleMediaCount": len(media), "observedMediaSizeNames": size_counts,
                      "featuredMediaPresent": bool(posts and posts[0].get("featured_media"))},
    "renderedPage": {"status": article_status, "contentType": article_type,
                     "sample": "published article" if article_path != "/" else "home",
                     "canonical": page.canonical, "jsonLdScripts": page.json_ld,
                     "hasDescription": "description" in page.meta,
                     "hasOgTitle": "og:title" in page.meta,
                     "hasOgImage": "og:image" in page.meta,
                     "images": len(images),
                     "withSrcset": sum(item["srcset"] for item in images),
                     "withSizes": sum(item["sizes"] for item in images),
                     "withAlt": sum(item["alt"] for item in images),
                     "withLazyLoading": sum(item["loading"] for item in images),
                     "withFetchPriority": sum(item["fetchpriority"] for item in images)},
    "robots": {"status": robots_status, "hasSitemapDirective": bool(re.search(rb"(?im)^sitemap:", robots_bytes))},
    "sitemap": {"status": sitemap_status, "contentType": sitemap_type},
    "unknown": ["PHP runtime version", "private frontend contract version", "authenticated WordPress write compatibility"],
}
print(json.dumps(output, ensure_ascii=False, indent=2))
