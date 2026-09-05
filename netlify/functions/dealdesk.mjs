import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

export const STORE_NAME = 'dealdesk-v1';
export const ACTIVE_STAGES = new Set(['new','review','watch','data-room','loi']);

export const SOURCE_QUERIES = [
  'vertical SaaS registration payments software business for sale recurring revenue',
  'compliance software SaaS business for sale recurring revenue',
  'association management registration payments SaaS business for sale',
  'field service niche SaaS business for sale recurring revenue',
  'permit inspection credential management SaaS business for sale',
  'reconciliation scheduling workflow SaaS business for sale',
  'sports registration payments software company acquisition founder',
  'municipal compliance software company founder recurring revenue',
  'specialized operations software founder retirement SaaS',
  'vertical software system of record small company founder'
];

export function getDealStore() { return getStore({ name: STORE_NAME, consistency: 'strong' }); }
export function json(data, status=200) { return new Response(JSON.stringify(data), { status, headers:{'content-type':'application/json','cache-control':'no-store'} }); }
export function requireAuth(req) {
  const expected = process.env.DEALDESK_TOKEN;
  if (!expected) return { ok:false, response:json({error:'DEALDESK_TOKEN is not configured.'},503) };
  const auth = req.headers.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a,b);
  return ok ? {ok:true} : {ok:false,response:json({error:'Unauthorized'},401)};
}
export function dealId(url) { return crypto.createHash('sha256').update(String(url).trim().toLowerCase()).digest('hex').slice(0,20); }
export function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

export function computeScore(deal) {
  const s = deal.scores || {};
  const parts = [num(s.aiDurability),num(s.operations),num(s.economics),num(s.retention),num(s.technical)].filter(v=>v!==null);
  const totalScore = parts.length === 5 ? Math.round(parts.reduce((a,b)=>a+b,0)) : null;
  const unknowns = [];
  if (num(s.aiDurability) === null) unknowns.push('AI durability evidence');
  if (num(deal.autoCollectedPct) === null) unknowns.push('billing processor / auto-collection %');
  if (num(deal.ownerHours) === null) unknowns.push('owner hours / recurring founder work');
  if (num(deal.normalizedEbitda) === null) unknowns.push('owner-adjusted EBITDA');
  if (num(deal.arr) === null) unknowns.push('ARR / recurring revenue');
  if (num(s.technical) === null) unknowns.push('technical transfer risk');

  let anchorEligibility = 'REVIEW';
  if (num(s.aiDurability) !== null && num(s.aiDurability) < 24) anchorEligibility = 'NO';
  else if (num(deal.autoCollectedPct) !== null && num(deal.autoCollectedPct) < 90) anchorEligibility = 'NO';
  else if (num(deal.ownerHours) !== null && num(deal.ownerHours) > 10) anchorEligibility = 'NO';
  else if (totalScore !== null && totalScore >= 72 && unknowns.length === 0) anchorEligibility = 'PASS';

  const icRank = (num(s.aiDurability) ?? 0) * 3 + (totalScore ?? 0) - unknowns.length * 5 + (anchorEligibility==='PASS'?50:anchorEligibility==='NO'?-50:0);
  return { ...deal, totalScore, unknowns, anchorEligibility, icRank };
}

export async function upsertDeal(raw) {
  if (!raw?.url) throw new Error('Candidate URL is required');
  const store = getDealStore();
  const id = raw.id || dealId(raw.url);
  const key = `deal/${id}`;
  const existingRaw = await store.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};
  const now = new Date().toISOString();
  const deal = computeScore({
    stage:'new', scores:{aiDurability:null,operations:null,economics:null,retention:null,technical:null},
    ...existing, ...raw, id,
    scores:{...(existing.scores||{}),...(raw.scores||{})},
    createdAt: existing.createdAt || raw.createdAt || now,
    updatedAt: now, lastSeenAt: raw.lastSeenAt || now
  });
  await store.set(key, JSON.stringify(deal));
  return {deal, created:!existingRaw};
}

export async function listDeals() {
  const store = getDealStore();
  const { blobs } = await store.list({ prefix:'deal/' });
  const deals = [];
  for (const b of blobs) {
    const raw = await store.get(b.key);
    if (raw) deals.push(computeScore(JSON.parse(raw)));
  }
  return deals.sort((a,b)=>(b.icRank??-999)-(a.icRank??-999));
}

function extractOutputText(response) {
  const chunks=[];
  for (const item of response?.output || []) for (const c of item?.content || []) if (c?.type === 'output_text' && c.text) chunks.push(c.text);
  return chunks.join('\n');
}

async function openAiScout(query) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured for automatic scouting.');
  const model = process.env.DEALDESK_MODEL || 'gpt-5.6-luna';
  const prompt = `You are the sourcing agent for a permanent buyer of small software companies. Search the live public web for CURRENT opportunities or off-market company targets related to this query:\n\n${query}\n\nBUY BOX: boring embedded vertical software; systems of record/action; payments, registration, compliance, reconciliation, scheduling or proprietary operational data. AI durability is the #1 risk. Avoid themes/templates, generic content generation, thin LLM wrappers, translation-only tools, simple summarizers, and businesses whose paid job can plausibly be replaced by frontier AI. Prefer recurring revenue, established products, low founder dependence, automated card billing, and $150k-$1.2m enterprise value when a price is available.\n\nRules: public sources only; do not invent financials, billing processors, owner hours or retention. If unknown, use null. Return 1-8 distinct candidates. URLs must point to the listing or company page actually found.`;
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title','url','source','vertical','summary','scores','askingPrice','arr','normalizedEbitda','autoCollectedPct','ownerHours'],
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            source: { type: 'string' },
            vertical: { type: 'string' },
            summary: { type: 'string' },
            askingPrice: { type: ['number','null'] },
            arr: { type: ['number','null'] },
            normalizedEbitda: { type: ['number','null'] },
            autoCollectedPct: { type: ['number','null'] },
            ownerHours: { type: ['number','null'] },
            scores: {
              type: 'object',
              additionalProperties: false,
              required: ['aiDurability','operations','economics','retention','technical'],
              properties: {
                aiDurability: { type: ['number','null'], minimum: 0, maximum: 35 },
                operations: { type: ['number','null'], minimum: 0, maximum: 25 },
                economics: { type: ['number','null'], minimum: 0, maximum: 18 },
                retention: { type: ['number','null'], minimum: 0, maximum: 12 },
                technical: { type: ['number','null'], minimum: 0, maximum: 10 }
              }
            }
          }
        }
      }
    }
  };
  const res = await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'authorization':`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,tools:[{type:'web_search'}],input:prompt,text:{format:{type:'json_schema',name:'deal_scout_results',strict:true,schema}}})});
  if(!res.ok) throw new Error(`OpenAI scout failed (${res.status}): ${await res.text()}`);
  const body=await res.json();
  const text=extractOutputText(body);
  return JSON.parse(text).candidates || [];
}

export async function runScout() {
  const store = getDealStore();
  const stateRaw = await store.get('state/scout');
  const state = stateRaw ? JSON.parse(stateRaw) : {cursor:0};
  const query = SOURCE_QUERIES[state.cursor % SOURCE_QUERIES.length];
  const candidates = await openAiScout(query);
  let added=0,updated=0;
  for (const candidate of candidates) {
    try {
      const result = await upsertDeal({ ...candidate, scoutQuery:query, source:candidate.source || 'web scout' });
      result.created ? added++ : updated++;
    } catch {}
  }
  await store.set('state/scout',JSON.stringify({cursor:(state.cursor+1)%SOURCE_QUERIES.length,lastRunAt:new Date().toISOString(),lastQuery:query,lastAdded:added,lastUpdated:updated}));
  return {added,updated,query};
}

export default async (req) => {
  const auth=requireAuth(req); if(!auth.ok) return auth.response;
  try {
    const action = new URL(req.url).searchParams.get('action') || 'deals';
    if (action === 'run-scout') {
      if (req.method !== 'POST') return json({error:'Method not allowed'},405);
      return json(await runScout());
    }
    if (action !== 'deals') return json({error:'Unknown action'},404);
    if(req.method==='GET') return json({deals:await listDeals()});
    if(req.method==='POST') {
      const body=await req.json();
      const result=await upsertDeal({ ...body, stage:body.stage || 'new' });
      return json(result, result.created?201:200);
    }
    if(req.method==='PATCH') {
      const body=await req.json();
      if(!body.id) return json({error:'id required'},400);
      const store=getDealStore(); const key=`deal/${body.id}`; const raw=await store.get(key);
      if(!raw) return json({error:'deal not found'},404);
      const current=JSON.parse(raw);
      const updated=computeScore({...current,...body,scores:{...(current.scores||{}),...(body.scores||{})},updatedAt:new Date().toISOString()});
      await store.set(key,JSON.stringify(updated));
      return json({deal:updated});
    }
    return json({error:'Method not allowed'},405);
  } catch(err) { return json({error:err.message || 'Deal Desk error'},500); }
};
