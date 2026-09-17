import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from './server.mjs';
async function listen(s){await new Promise(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${s.address().port}`;}
async function close(s){s.closeAllConnections();await new Promise(r=>s.close(r));}
const input={question:'证据说明什么？',evidence:[{id:'1',title:'Test source',url:'https://example.org/source',text:'Source excerpt'}]};
test('unconfigured, static paths, same origin',async()=>{
 const s=createApp({config:{}}),url=await listen(s);try{
 assert.equal((await (await fetch(url+'/api/status')).json()).configured,false);
 assert.equal((await fetch(url+'/api/chat',{method:'POST'})).status,503);
 for(const p of ['/.env','/.git/config','/server.mjs','/server.test.mjs','/%2e%2e%2f.env','/README.md'])assert.equal((await fetch(url+p)).status,404);
 assert.equal((await fetch(url+'/')).status,200);
 assert.equal((await fetch(url+'/api/status',{headers:{Origin:'https://evil.example'}})).status,403);
 }finally{await close(s);}
});
for(const protocol of ['anthropic','openai'])test(`${protocol} real local HTTP stream and upstream failure`,async()=>{
 let mode='good';const up=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;const payload=JSON.parse(b);assert.equal(payload.stream,true);assert.equal(payload.model,'mock');
 if(mode==='failure'){res.writeHead(401);return res.end('secret-token-do-not-leak');}
 res.writeHead(200,{'content-type':'text/event-stream'});
 if(protocol==='anthropic'){res.write('data: '+JSON.stringify({type:'content_block_delta',delta:{type:'thinking_delta',thinking:'HIDDEN'}})+'\n\n');res.write('data: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:'依据[1]'}})+'\n\n');setTimeout(()=>res.end(mode==='cut'?'':'data: {"type":"message_stop"}\n\n'),10);}
 else {res.write('data: '+JSON.stringify({choices:[{delta:{content:'依据[1]',reasoning_content:'HIDDEN'}}]})+'\n\n');setTimeout(()=>res.end(mode==='cut'?'':'data: [DONE]\n\n'),10);}
 });const upURL=await listen(up);const s=createApp({config:{enabled:true,protocol,baseURL:upURL,token:'secret-token-do-not-leak',model:'mock',timeoutMs:1000,maxConcurrent:1}}),url=await listen(s);
 const chat=(body=input)=>fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
 let r=await chat(),text=await r.text();assert.equal(r.status,200);assert.match(text,/event: delta/);assert.match(text,/依据/);assert.match(text,/event: done/);assert.doesNotMatch(text,/HIDDEN|secret-token/);
 mode='cut';text=await (await chat()).text();assert.match(text,/event: error/);assert.doesNotMatch(text,/event: done/);
 mode='failure';r=await chat();assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/secret-token/);
 assert.equal((await chat({...input,evidence:[{...input.evidence[0],url:'file:///etc/passwd'}]})).status,400);
 assert.equal((await chat({...input,question:'x'.repeat(4001)})).status,400);
 }finally{await close(s);await close(up);}
});
test('concurrency and timeout remain bounded',async()=>{
 const up=http.createServer(()=>{}),baseURL=await listen(up);
 const s=createApp({config:{enabled:true,protocol:'anthropic',baseURL,token:'test',model:'mock',timeoutMs:80,maxConcurrent:1}}),url=await listen(s);
 const chat=()=>fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 try{const pending=chat();await new Promise(r=>setTimeout(r,20));assert.equal((await chat()).status,429);assert.equal((await pending).status,502);}finally{await close(s);await close(up);}
});

test('published workbench and source corpus are accessible',async()=>{
 const s=createApp({config:{}}),url=await listen(s);try{
 for(const file of ['workspace.html','workspace.js','workspace.css','retrieval-engine.js','corpus.json']){
 const response=await fetch(url+'/'+file);assert.equal(response.status,200,file);assert.ok((await response.text()).length>0,file);
 }
 assert.equal((await fetch(url+'/build_corpus.py')).status,404);
 }finally{await close(s);}
});

test('credentials alone never enable billable requests',async()=>{
 let called=false;const s=createApp({config:{protocol:'anthropic',baseURL:'https://example.org',token:'private',model:'mock'},fetchImpl:async()=>{called=true;throw Error('must not call');}}),url=await listen(s);
 try{const status=await(await fetch(url+'/api/status')).json();assert.equal(status.configured,false);assert.equal(status.configurationPresent,true);assert.equal(status.enabled,false);assert.equal((await fetch(url+'/api/chat',{method:'POST'})).status,503);assert.equal(called,false);}finally{await close(s);}
});
