export function insertCommercialEvent(db, event, createdAt) {
  db.prepare(`INSERT INTO commercial_events(id, event_type, article_id, draft_id, offer_id,
    affiliate_asset_id, provider, category, slot_key, component_variant, placement, entity_key, route_key,
    destination_slug, device, locale, strategy_version, value_amount, occurred_at, created_at,
    article_revision, overlay_version, event_source, conversion_data_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id, event.eventType, event.articleId, event.draftId, event.offerId, event.affiliateAssetId,
      event.provider, event.category, event.slotKey, event.componentVariant, event.placement, event.entityKey,
      event.routeKey, event.destinationSlug, event.device, event.locale, event.strategyVersion,
      event.valueAmount, event.occurredAt, createdAt, event.articleRevision, event.overlayVersion,
      event.eventSource, event.conversionDataStatus);
}

export function listCommercialPerformance(db) {
  const rows = db.prepare(`SELECT provider, category, slot_key, component_variant, destination_slug,
    SUM(event_type='impression') AS impressions, SUM(event_type='click') AS clicks,
    SUM(event_type='booking') AS observed_bookings,
    SUM(event_type='commission') AS commission_events,
    SUM(CASE WHEN event_type='commission' AND value_amount IS NULL THEN 1 ELSE 0 END) AS unknown_commission_values,
    SUM(CASE WHEN event_type='commission' THEN COALESCE(value_amount,0) ELSE 0 END) AS observed_commission,
    MAX(conversion_data_status='confirmed') AS conversion_confirmed,
    SUM(CASE WHEN article_revision IS NULL OR overlay_version IS NULL OR affiliate_asset_id IS NULL OR event_source='unknown' THEN 1 ELSE 0 END) AS unknown_attribution_events,
    COUNT(DISTINCT article_revision) AS article_revision_count,
    COUNT(DISTINCT overlay_version) AS overlay_version_count,
    COUNT(DISTINCT affiliate_asset_id) AS affiliate_asset_count
    FROM commercial_events GROUP BY provider, category, slot_key, component_variant, destination_slug
    ORDER BY CASE WHEN observed_commission IS NULL THEN 1 ELSE 0 END, observed_commission DESC, clicks DESC`).all();
  return rows.map((row) => {
    const conversionKnown = Boolean(row.conversion_confirmed);
    const commissionKnown = conversionKnown && Number(row.unknown_commission_values || 0) === 0;
    const commission = commissionKnown ? Number(row.observed_commission || 0) : null;
    const bookings = conversionKnown ? Number(row.observed_bookings || 0) : null;
    return {
      provider: row.provider, category: row.category, slot_key: row.slot_key,
      component_variant: row.component_variant, destination_slug: row.destination_slug,
      impressions: Number(row.impressions || 0), clicks: Number(row.clicks || 0), bookings, commission,
      conversion_data_status: conversionKnown ? "confirmed" : "unknown",
      attribution_status: Number(row.unknown_attribution_events || 0) ? "partial_unknown" : "traceable",
      trace: { articleRevisions: Number(row.article_revision_count || 0), overlayVersions: Number(row.overlay_version_count || 0),
        affiliateAssets: Number(row.affiliate_asset_count || 0), unknownEvents: Number(row.unknown_attribution_events || 0) },
      ctr: row.impressions ? row.clicks / row.impressions : 0,
      conversion_rate: conversionKnown && row.clicks ? bookings / row.clicks : null,
      epc: commissionKnown && row.clicks ? commission / row.clicks : null,
      rpm: commissionKnown && row.impressions ? commission * 1_000 / row.impressions : null,
    };
  });
}
