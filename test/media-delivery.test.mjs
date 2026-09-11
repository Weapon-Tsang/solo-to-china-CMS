import assert from "node:assert/strict";
import test from "node:test";
import { responsiveImageAttributes, validateMediaDelivery, wordpressMediaMetadata } from "../src/media-delivery.mjs";
import { markdownToSafeHtml, WordPressDraftAdapter } from "../src/wordpress.mjs";

const bytes = Buffer.from("a stable image fixture");
const wpBody = {
  id: 71, source_url: "https://site.test/uploads/guide.jpg", mime_type: "image/jpeg",
  media_details: { width: 1200, height: 800, sizes: {
    medium: { source_url: "https://site.test/uploads/guide-600.jpg", width: 600, height: 400, mime_type: "image/jpeg" },
    large: { source_url: "https://site.test/uploads/guide-1200.jpg", width: 1200, height: 800, mime_type: "image/jpeg" },
  } },
};

test("WordPress media metadata records a public final URL, dimensions, bytes, hash and derivatives", () => {
  const metadata = wordpressMediaMetadata(wpBody, { bytes, contentType: "image/jpeg" });
  assert.equal(metadata.reusable, true);
  assert.deepEqual([metadata.width, metadata.height, metadata.bytes], [1200, 800, bytes.length]);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(metadata.derivatives.map((item) => item.width), [600, 1200]);
});

test("media delivery rejects private/signed routes, missing dimensions, bad alt roles and duplicate uploads", () => {
  const goodMetadata = wordpressMediaMetadata(wpBody, { bytes, contentType: "image/jpeg" });
  const source_asset_id = "source-asset-71";
  const base = { wordpress_media_id: 71, wordpress_media_url: wpBody.source_url, source_asset_id,
    alt_text: "Chongqing riverside walkway at night", image_role: "featured", image_type: "real_world_photo",
    acquisition_strategy: "use_authorized_source_image", factual_image_required: 1, media_metadata: { ...goodMetadata,
      wordpress_uploaded: true, wordpress_media_id: 71, source_provenance: { source_asset_id, original_stored: true,
        source_owner_confirmed: true, source_publishable: true, asset_owner_confirmed: true, asset_publishable: true } } };
  assert.equal(validateMediaDelivery([base]).valid, true);
  const result = validateMediaDelivery([
    { ...base, wordpress_media_url: "data:image/png;base64,AAAA", alt_text: "guide guide guide guide guide" },
    { ...base, wordpress_media_id: 72, image_role: "decorative", alt_text: "Not empty",
      wordpress_media_url: "https://site.test/uploads/copy.jpg?token=secret", media_metadata: { ...goodMetadata, width: null } },
  ]);
  const codes = result.errors.map((item) => item.code);
  assert.ok(codes.includes("MEDIA_URL_NOT_PUBLIC"));
  assert.ok(codes.includes("MEDIA_DIMENSIONS_MISSING"));
  assert.ok(codes.includes("MEDIA_ALT_ROLE_MISMATCH"));
  assert.ok(codes.includes("MEDIA_ALT_KEYWORD_STUFFING"));
  assert.ok(codes.includes("MEDIA_DUPLICATE_UPLOAD"));
});

test("localized real photos require an original, authorization, a real localized file and WordPress upload", () => {
  const source_asset_id = "source-asset-localized";
  const metadata = { ...wordpressMediaMetadata(wpBody, { bytes, contentType: "image/jpeg" }),
    wordpress_uploaded: true, wordpress_media_id: 71, localized_file: true,
    localized_from_source_asset_id: source_asset_id, source_provenance: { source_asset_id, original_stored: true,
      source_owner_confirmed: true, source_publishable: true, asset_owner_confirmed: true, asset_publishable: true } };
  const visual = { wordpress_media_id: 71, wordpress_media_url: wpBody.source_url, source_asset_id,
    alt_text: "Localized authorized source photo", image_role: "featured", image_type: "real_world_photo",
    acquisition_strategy: "localize_source_image", factual_image_required: 1, media_metadata: metadata };
  assert.equal(validateMediaDelivery([visual]).valid, true);
  const invalid = validateMediaDelivery([{ ...visual, media_metadata: { ...metadata, localized_file: false } }]);
  assert.ok(invalid.errors.some((error) => error.code === "LOCALIZED_SCENE_FILE_NOT_PROVEN"));
});

test("responsive HTML gives only the first image high priority and later images lazy loading", () => {
  const metadata = wordpressMediaMetadata(wpBody, { bytes, contentType: "image/jpeg" });
  const attributes = responsiveImageAttributes(metadata, { featured: true });
  assert.equal(attributes.fetchpriority, "high");
  assert.equal(attributes.loading, undefined);
  const html = markdownToSafeHtml("Paragraph one.\n\nParagraph two.", [
    { id: 71, url: wpBody.source_url, alt: "Chongqing riverside", metadata },
    { id: 72, url: "https://site.test/uploads/detail.jpg", alt: "Chongqing walkway detail", metadata },
  ]);
  assert.equal((html.match(/fetchpriority="high"/g) || []).length, 1);
  assert.equal((html.match(/loading="lazy"/g) || []).length, 1);
  assert.match(html, /width="1200" height="800"/);
  assert.match(html, /srcset="[^"]+600w[^"]+1200w"/);
});

test("two placements of the same source asset reuse one WordPress media upload", async () => {
  let sourceFetches = 0;
  let uploads = 0;
  const adapter = new WordPressDraftAdapter({ siteUrl: "https://site.test", username: "editor", applicationPassword: "password" }, async (url) => {
    if (String(url).includes("xhscdn.com")) {
      sourceFetches += 1;
      return new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    uploads += 1;
    return new Response(JSON.stringify(wpBody), { status: 201, headers: { "content-type": "application/json" } });
  });
  const visuals = ["hero", "context"].map((role, index) => ({ id: `visual-${index}`, status: "generated",
    source_asset_id: "same-source-asset", source_remote_url: "https://ci.xhscdn.com/same.jpg",
    alt_text: "Evidence-backed Chongqing scene", caption: "Saved source image", image_role: role }));
  const output = await adapter.resolveVisualMedia(visuals);
  assert.deepEqual(output.map((item) => item.id), [71, 71]);
  assert.equal(sourceFetches, 1);
  assert.equal(uploads, 1);
});
