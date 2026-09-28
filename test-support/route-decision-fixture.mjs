import { seedRouteProduction } from './route-production-fixture.mjs';
import { routeReadableMarkdown } from '../src/route-bundle.mjs';

// Synthetic published inventory is local test input, never a WordPress write.
export function publishedRouteFixture(repository) {
  const seed=seedRouteProduction(repository,{dayCount:3});
  const research=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId});
  const brief=repository.saveBrief(seed.candidateId,{title:'Three-day historical itinerary',audience:['solo'],outline:[],
    search_intent:'informational'},'fixture',{deferDraft:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
  const draft=repository.saveDraft(brief,{title:'Three-day historical itinerary',slug:'three-day-fixture',
    body_markdown:routeReadableMarkdown(research.route_bundle),meta_description:'Supported historical route',
    evidence_ledger:[],unresolved_conflicts:[],visuals:[]},'fixture',{deferReview:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
  repository.db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at)
    VALUES ('published-route',?,'https://example.invalid',42,'synced','now','now')`).run(draft);
  repository.db.prepare(`INSERT INTO wordpress_content_inventory(id,site_url,post_id,slug,title,status,synced_at)
    VALUES ('route-inventory','https://example.invalid',42,'three-day-fixture','Three-day historical itinerary','publish','now')`).run();
  return {...seed,draft,bundle:research.route_bundle};
}
