/* Actual local corpus retrieval. No prewritten answer paths or semantic-model claims. */
export function terms(text) {
 const normalized=String(text).toLowerCase().normalize('NFKC');
 const words=normalized.match(/[a-z0-9]+(?:[.-][a-z0-9]+)*|[\u3400-\u9fff]+/g)||[];
 return words.flatMap(w=>/[\u3400-\u9fff]/.test(w)?[w,...Array.from({length:Math.max(0,w.length-1)},(_,i)=>w.slice(i,i+2))]:[w]);
}
const aliases=[['电动牙刷','electric toothbrush'],['牙刷','toothbrush'],['刷头','brush head'],['特许权使用费','royalty royalties license fee'],['完税价格','customs valuation transaction value'],['税率','tariff rate duty'],['原产地','country origin'],['归类','classification'],['电机','motor'],['进口','import'],['关联','related'],['合同','agreement contract']];
export function expandQuery(query){return query+' '+aliases.filter(([a])=>query.includes(a)).map(([,b])=>b).join(' ')}
export class CorpusSearch {
 constructor(corpus){
  this.docs=new Map(corpus.docs.map(d=>[String(d.id),d]));this.chunks=corpus.chunks.map(c=>({...c,id:String(c.id),doc_id:String(c.doc_id)}));
  this.index=new Map();this.lengths=[];this.total=0;
  this.chunks.forEach((c,i)=>{const ts=terms(c.text+' '+(this.docs.get(c.doc_id)?.title||''));this.lengths[i]=ts.length;this.total+=ts.length;const counts=new Map();ts.forEach(t=>counts.set(t,(counts.get(t)||0)+1));counts.forEach((n,t)=>{if(!this.index.has(t))this.index.set(t,[]);this.index.get(t).push([i,n])})});this.avg=this.total/Math.max(1,this.chunks.length);
 }
 search(query,{limit=8,jurisdiction='',exclude=[],docIds=null}={}){
  const expanded=expandQuery(query),tokens=[...new Set(terms(expanded))],scores=new Map(),matched=new Map(),N=this.chunks.length;
  tokens.forEach(t=>{const postings=this.index.get(t)||[],idf=Math.log(1+(N-postings.length+.5)/(postings.length+.5));postings.forEach(([i,n])=>{const score=idf*n*2.2/(n+1.2*(.25+.75*this.lengths[i]/this.avg));scores.set(i,(scores.get(i)||0)+score);if(!matched.has(i))matched.set(i,[]);matched.get(i).push(t)})});
  const matchedAliases=aliases.filter(([a])=>query.includes(a)),longestAlias=Math.max(0,...matchedAliases.map(([a])=>a.length));
  const phrases=[query.trim().toLowerCase(),...matchedAliases.filter(([a])=>a.length===longestAlias).flatMap(([a,b])=>[a,b.toLowerCase()])].filter(p=>p.length>=2);
  scores.forEach((score,i)=>{const c=this.chunks[i],d=this.docs.get(c.doc_id);const body=c.text.toLowerCase(),title=(d?.title||'').toLowerCase();scores.set(i,score+phrases.reduce((sum,p)=>sum+(body.includes(p)?18:0)+(title.includes(p)?12:0),0))});
  const denied=new Set(exclude),allowedDocs=docIds&&new Set(docIds);scores.forEach((_,i)=>{const c=this.chunks[i],d=this.docs.get(c.doc_id);if(denied.has(c.id)||!d||(jurisdiction&&d.jurisdiction!==jurisdiction)||(allowedDocs&&!allowedDocs.has(c.doc_id)))scores.delete(i)});
  const anchored=new Set();scores.forEach((_,i)=>{const c=this.chunks[i],d=this.docs.get(c.doc_id);const body=(c.text+' '+(d?.title||'')).toLowerCase();if(phrases.some(p=>body.includes(p)))anchored.add(i)});
  const perDoc=new Map();return [...scores].filter(([i])=>!anchored.size||anchored.has(i)).sort((a,b)=>b[1]-a[1]).filter(([i])=>{const c=this.chunks[i],d=this.docs.get(c.doc_id);return !denied.has(c.id)&&d&&(!jurisdiction||d.jurisdiction===jurisdiction)}).filter(([i])=>{const id=this.chunks[i].doc_id,n=perDoc.get(id)||0;perDoc.set(id,n+1);return n<2}).slice(0,limit).map(([i,score])=>({...this.chunks[i],score,matched:matched.get(i),relation:'query',reason:'命中查询词：'+matched.get(i).slice(0,8).join('、')}));
 }
 follow(chunk,query,options={}){
  const ids=new Set((chunk.refs||[]).map(r=>String(typeof r==='string'?r:r.id||r.ref||'')));
  const ranked=this.search(query,{...options,limit:30});
  const references=[...ids].filter(id=>this.docs.has(id)&&(!options.jurisdiction||this.docs.get(id).jurisdiction===options.jurisdiction)).slice(0,5).map(id=>{const local=this.search(query,{...options,docIds:[id],limit:1})[0];const c=local||this.chunks.find(x=>x.doc_id===id);if(!c)return null;return {...c,score:local?.score||0,matched:local?.matched||[],relation:'reference',from:chunk.id,reason:local?`所选片段明确引用 ${id}；在该文档内检索，命中：${local.matched.slice(0,8).join('、')}。`:`所选片段明确引用 ${id}；显示引用目标入口片段，未命中本轮查询。`}}).filter(Boolean);
  const excluded=new Set([chunk.id,...references.map(x=>x.id)]);return [...references,...ranked.filter(c=>!excluded.has(c.id)).slice(0,Math.max(3,8-references.length)).map(c=>({...c,from:chunk.id,reason:'基于本轮补充问题继续词项检索；不代表原文存在引用关系。'}))];
 }
}
