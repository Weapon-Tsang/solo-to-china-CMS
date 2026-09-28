import {inspectRobotsTxt} from './seo-observation.mjs';

const openai='https://developers.openai.com/api/docs/bots';
const google='https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers';
// Reviewed from official documentation on this date, not discovered from logs.
const definitions=[
  {agent:'Googlebot',purpose:'搜索抓取',source:google,control:'crawl'},
  {agent:'OAI-SearchBot',purpose:'ChatGPT 搜索抓取',source:openai,control:'crawl'},
  {agent:'GPTBot',purpose:'模型训练采集',source:openai,control:'crawl'},
  {agent:'Google-Extended',purpose:'Gemini 训练与检索增强使用控制；不决定 Google 搜索收录',source:google,control:'usage'},
  {agent:'ChatGPT-User',purpose:'用户发起的页面访问；不能据 robots 规则断言访问结果',source:openai,control:'user_action'},
];
export function inspectCrawlerPolicies(text,{url,httpStatus=200}={}) {
  let pathname='/';try{const parsed=new URL(url);pathname=parsed.pathname+parsed.search;}catch{}
  return definitions.map(definition=>({...definition,reviewed_at:'2026-09-28',
    policy:definition.control==='user_action'?{status:'unknown',allowed:null,reason:'user_initiated_not_automatic_crawl'}:
      inspectRobotsTxt(text,{agent:definition.agent,path:pathname,httpStatus}),
    actual_access:'not_observed',search_outcome:'unknown',settings_changed:false}));
}
