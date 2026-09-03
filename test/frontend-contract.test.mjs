import assert from "node:assert/strict";
import test from "node:test";
import { FrontendContractConsumer, FrontendContractError } from "../src/frontend-contract.mjs";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";
import { defaultComponents, frontendContractFixture } from "../test-support/frontend-contract-fixture.mjs";

function consumerFor(repository, fixture) {
  return new FrontendContractConsumer(repository, {
    sourceRepository: "https://github.com/example/solo-to-china",
    registrySource: fixture.registryPath,
    pageSchemaSource: fixture.pageSchemaPath,
  });
}

function validPayload() {
  return {
    metadata: { title: "Chongqing first visit" },
    blocks: [
      { type: "articleSection", variant: "answer-first", data: { heading: "Quick answer", body: "Plan bookings before you go." } },
      { type: "faqList", data: { items: [{ question: "When should I go?", answer: "Use the verified timing in the article." }] } },
    ],
  };
}

test("synchronized registry validates a valid page and preserves block order", async (t) => {
  const { repository } = repositoryFixture(t);
  const fixture = frontendContractFixture(t);
  const consumer = consumerFor(repository, fixture);
  const synced = await consumer.sync();
  assert.equal(synced.status, "healthy");
  assert.equal(synced.active.contractVersion, "1.2.0");
  assert.equal(consumer.capabilities({ semantics: ["faq"] }).components[0].id, "faqList");

  const validation = consumer.validatePagePayload(validPayload());
  assert.equal(validation.valid, true);
  assert.deepEqual(validPayload().blocks.map((block) => block.type), ["articleSection", "faqList"]);
});

test("commercial components are consumed from the registry and missing capabilities are explicit", async (t) => {
  const { repository } = repositoryFixture(t);
  const fixture = frontendContractFixture(t);
  const consumer = consumerFor(repository, fixture);
  await consumer.sync();
  const capabilities = consumer.commercialCapabilities(["affiliate_booking_card", "articleSection"]);
  assert.deepEqual(capabilities.supported, ["articleSection"]);
  assert.deepEqual(capabilities.missing, ["affiliate_booking_card"]);
});

test("the published Frontend inputSchema and 2020-12 shape sync while commercial capabilities stay out of pre-QA composition", async (t) => {
  const { repository } = repositoryFixture(t);
  const fixture = frontendContractFixture(t, { contractVersion: "1.0.0", schemaVersion: "2020-12", components: [{
    id: "affiliate_cta", name: "Affiliate CTA", category: "commercial", purpose: "Contextual commercial action.",
    status: "stable", variants: ["default"], cmsUsable: true, interface: "page_block", renderMode: "shortcode",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["category", "provider", "title", "description", "cta_label", "target_url"],
      properties: {
        category: { type: "string" }, provider: { type: "string" }, title: { type: "string" },
        description: { type: "string" }, cta_label: { type: "string" },
        target_url: { type: "string", pattern: "^https://" }, disclosure: { type: "string" },
      },
    },
  }] });
  const consumer = consumerFor(repository, fixture);
  await consumer.sync();
  assert.equal(consumer.hasComponent("affiliate_cta"), true);
  assert.deepEqual(consumer.commercialCapabilities(["affiliate_cta"]).supported, ["affiliate_cta"]);
  assert.deepEqual(consumer.resolveForArticle({ draft: { body_markdown: "Compare booking options." } }).components, []);
  const validation = consumer.validatePagePayload({
    metadata: { title: "Commercial payload" },
    blocks: [{ type: "affiliate_cta", variant: "default", data: {
      category: "hotel", provider: "Trip.com", title: "Compare hotels", description: "Check location before price.",
      cta_label: "View options", target_url: "https://www.trip.com/",
    } }],
  });
  assert.equal(validation.valid, true);
});

test("component validation rejects unknown components, variants, required fields, and arbitrary data", async (t) => {
  const { repository } = repositoryFixture(t);
  const fixture = frontendContractFixture(t);
  const consumer = consumerFor(repository, fixture);
  await consumer.sync();

  const unknown = consumer.validatePagePayload({ metadata: { title: "x" }, blocks: [{ type: "madeUp", data: {} }] });
  assert.ok(unknown.errors.some((item) => item.code === "UNKNOWN_COMPONENT"));
  const variant = consumer.validatePagePayload({ metadata: { title: "x" }, blocks: [{ type: "notice", variant: "urgent", data: { title: "x", message: "y" } }] });
  assert.ok(variant.errors.some((item) => item.code === "UNSUPPORTED_VARIANT"));
  const missing = consumer.validatePagePayload({ metadata: { title: "x" }, blocks: [{ type: "articleSection", data: { heading: "x" } }] });
  assert.ok(missing.errors.some((item) => item.code === "MISSING_REQUIRED_FIELD"));
  const arbitrary = consumer.validatePagePayload({ metadata: { title: "x" }, blocks: [{ type: "notice", data: { title: "x", message: "y", color: "red" } }] });
  assert.ok(arbitrary.errors.some((item) => item.code === "INVALID_COMPONENT_DATA"));
});

test("deprecated components are blocked for new pages and warned for historical compatibility", async (t) => {
  const { repository } = repositoryFixture(t);
  const fixture = frontendContractFixture(t);
  const consumer = consumerFor(repository, fixture);
  await consumer.sync();
  const payload = { metadata: { title: "Legacy" }, blocks: [{ type: "legacyPanel", data: { body: "Old content" } }] };
  assert.ok(consumer.validatePagePayload(payload).errors.some((item) => item.code === "DEPRECATED_COMPONENT"));
  const existing = consumer.validatePagePayload(payload, { existingPage: true });
  assert.equal(existing.valid, true);
  assert.ok(existing.warnings.some((item) => item.code === "DEPRECATED_COMPONENT"));
  assert.equal(consumer.validateCompositionPlan({ blocks: [{ type: "legacyPanel", semantic_role: "legacy", writer_guidance: "old" }] }).valid, false);
});

test("minor updates activate automatically while major updates keep the Last Known Good Contract until accepted", async (t) => {
  const { repository } = repositoryFixture(t);
  const fixture = frontendContractFixture(t);
  const consumer = consumerFor(repository, fixture);
  await consumer.sync();
  fixture.write({ contractVersion: "1.3.0", components: [...defaultComponents(), {
    id: "comparisonTable", category: "comparison", purpose: "Compare evidence-backed options.", status: "stable", variants: ["default"],
    schema: { type: "object", additionalProperties: false, required: ["rows"], properties: { rows: { type: "array" } } },
  }] });
  const minor = await consumer.sync();
  assert.equal(minor.status, "healthy");
  assert.ok(minor.update.addedComponents.includes("comparisonTable"));
  assert.equal(consumer.active.contractVersion, "1.3.0");

  fixture.write({ contractVersion: "2.0.0" });
  const major = await consumer.sync();
  assert.equal(major.majorMismatch, true);
  assert.equal(consumer.diagnostics().status, "major_mismatch");
  assert.equal(consumer.active.contractVersion, "1.3.0");
  assert.equal(consumer.diagnostics().canCompose, false);
  consumer.acceptMajorSnapshot(major.snapshot.id);
  assert.equal(consumer.active.contractVersion, "2.0.0");
  assert.equal(consumer.diagnostics().status, "healthy");
});

test("failed refresh uses Last Known Good Contract but a new environment without one fails safely", async (t) => {
  const { repository } = repositoryFixture(t);
  const fixture = frontendContractFixture(t);
  const consumer = consumerFor(repository, fixture);
  await consumer.sync();
  consumer.config.registrySource = `${fixture.registryPath}.missing`;
  await assert.rejects(() => consumer.sync(), FrontendContractError);
  assert.equal(consumer.diagnostics().status, "stale");
  assert.equal(consumer.validatePagePayload(validPayload()).valid, true);

  const { repository: emptyRepository } = repositoryFixture(t);
  const empty = new FrontendContractConsumer(emptyRepository, {});
  const invalid = empty.validatePagePayload(validPayload());
  assert.equal(invalid.errors[0].code, "NO_VALID_FRONTEND_CONTRACT");
});
