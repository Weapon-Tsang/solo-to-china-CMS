# Manual Source Ingestion

The administrator Sources page accepts intentionally selected research evidence in addition to the Chrome extension.

## Supported inputs

- Public Xiaohongshu note links
- Public WeChat Official Account article links (`mp.weixin.qq.com`)
- Public video links and ordinary web pages. Public YouTube links are passed to the active Vertex Gemini model as video/audio evidence; other video platforms contribute only publicly extractable page text and should include an authorized transcript in the supplementary-text field.
- PDF documents
- Word documents (`.doc` and `.docx`)
- JPG, PNG, WebP, or GIF images (up to eight per submission)

Every accepted item is stored as a regular `Source` and queued for the existing `extract_source` pipeline. That pipeline performs multimodal extraction, creates structured Claims and an editorial Blueprint, updates eligible Knowledge, and produces the normal content-intake recommendation. Manual intake does not bypass human editorial approval or the QA gate.

Uploaded originals are stored below `SOURCE_UPLOADS_DIR`. Production must point this directory into the existing persistent Docker volume. The SQLite database records file hashes, MIME types, sizes, original filenames, and provenance; images are loaded locally into the configured multimodal model. Never delete the persistent volume during deployment.

## Link extraction and failures

The fetcher sends no account cookies, login credentials, administrator tokens, or browser session state. It accepts only HTTP/HTTPS public destinations, follows at most four validated redirects, rejects credentials and unusual ports, resolves every destination, and blocks loopback, private, link-local, and reserved network addresses.

Failures are returned to the form with an HTTP status, stable `code`, and operator-facing Chinese explanation. Important codes include:

- `AUTH_REQUIRED`: the source requires login, authorization, or a specific client.
- `BOT_PROTECTION`: the remote site returned an anti-bot, CAPTCHA, or access-verification page.
- `RATE_LIMITED`: the remote site rejected the request due to request frequency.
- `FETCH_TIMEOUT`, `DNS_FAILED`, `FETCH_FAILED`: the remote site could not be reached reliably.
- `EMPTY_CONTENT`, `EMPTY_DOCUMENT`: the response opened but provided no usable text. A scanned PDF should be submitted as page images.
- `DOCUMENT_PARSE_FAILED`: the PDF/Word file is encrypted, damaged, or mismatched with its extension.
- `UNSUPPORTED_CONTENT_TYPE`: a link returned a binary type outside the supported parser set.
- `PRIVATE_NETWORK_BLOCKED`: the target could reach local, private, link-local, or reserved infrastructure and was refused.

When a public site cannot be extracted, the operator should upload an authorized document/screenshot or paste an authorized transcript into the supplementary-text field. The system does not attempt CAPTCHA bypass, cookie reuse, authenticated scraping, or account automation.

## API

`POST /api/manual-sources` is administrator-only and accepts JSON. Link example:

```json
{
  "kind": "auto_url",
  "url": "https://mp.weixin.qq.com/s/example",
  "title": "Optional title",
  "notes": "Optional authorized supplementary text"
}
```

File submissions use `kind` equal to `pdf`, `word`, or `images`, and include browser-produced base64 file entries:

```json
{
  "kind": "images",
  "title": "Chongqing route screenshots",
  "files": [
    { "name": "route.png", "mimeType": "image/png", "base64": "..." }
  ]
}
```

The defaults are 12 MB per document, 6 MB per image, 25 MB per submission, 8 MB per fetched response, eight images, and a 20-second link timeout. They can be adjusted with the `MANUAL_SOURCE_*` environment settings documented in `.env.example`.
