import { opportunityTitlePackage, saveOpportunityTitles } from '../src/services/opportunity-titles.mjs';

export function acceptFixtureTitles(repository,destination) {
  const pack=opportunityTitlePackage(repository,destination);
  const output={proposals:pack.opportunities.map(input=>({id:input.id,
    title:`Using ${input.subject} for Your Airport Journey`,angle:'Choose transport',
    reader_promise:'Understand the supplied route and payment options.',evidence_keys:input.facts.map(fact=>fact.key)}))};
  saveOpportunityTitles(repository,pack,output,'fixture');
  return {pack,output};
}
