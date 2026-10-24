import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {MODEL,REQUIRED_NODES} from '../engine.mjs';
const settings={version:2,prompt:'A quiet room in soft daylight.',width:384,height:256,frames:17,fps:16,steps:20,seed:42,speed:.7};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'motion-takes-test-'));
  const state={posts:[],history:{},pending:[],running:[],reject:false,drop:false,missing:false};
  const info=Object.fromEntries(REQUIRED_NODES.map(n=>[n,{input:{required:{}}}]));
  for(const [n,[f,v]] of Object.entries(MODEL.files))info[n].input.required[f]=[[v]];
  info.SaveVideo.input.required.format=['COMFY_DYNAMICCOMBO_V3'];
  const mock=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const b=Buffer.concat(chunks);
    const send=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
    if(req.url==='/object_info')return send(state.missing?{}:info);
    if(req.url==='/system_stats')return send({system:{comfyui_version:'test'}});
    if(req.url==='/upload/image')return send({name:b.toString().match(/filename="([^"]+)"/)[1],subfolder:'',type:'input'});
    if(req.url==='/queue')return send({queue_running:state.running,queue_pending:state.pending});
    if(req.url.startsWith('/history/'))return send(state.history);
    if(req.url==='/prompt'){const p=JSON.parse(b);state.posts.push(p);if(state.reject)return send({error:'invalid'},400);if(state.drop){res.destroy();return;}const id='prompt-'+state.posts.length;state.pending=[[0,id]];return send({prompt_id:id});}
    if(req.url.startsWith('/view?')){res.writeHead(200,{'content-type':'video/mp4'});return res.end('video');}
    return send({},404);
  });
  const comfyURL=await listen(mock);let app=await createApp({comfyURL,dataDir:root,tickMs:3600000});let url=await listen(app);
  t.after(async()=>{await close(app);await close(mock);await rm(root,{recursive:true,force:true});});
  const api=async(route,body,headers={})=>{const r=await fetch(url+route,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json',...headers},body:Buffer.isBuffer(body)?body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const uploaded=await api('/api/upload',png,{'content-type':'image/png'});assert.equal(uploaded.status,201);
  const idle=async()=>{for(let i=0;i<50;i++){const files=await api('/api/boards');if(!files.data.some(b=>b.takes.some(t=>t.state==='waiting'||t.state==='submitting')))return;await new Promise(r=>setTimeout(r,10));}};
  const create=async(moves=['left'])=>{const r=await api('/api/boards',{image:uploaded.data.id,settings,moves});await idle();return r;};
  return {root,state,api,create,get app(){return app;},async restart(){await close(app);app=await createApp({comfyURL,dataDir:root,tickMs:3600000});url=await listen(app);},async complete(board,index=0,unsafe=false){const take=(await api('/api/boards/'+board.id)).data.takes[index];state.pending=[];state.history['prompt-'+(index+1)]={status:{completed:true,status_str:'success'},outputs:{15:{images:[{type:'output',subfolder:unsafe?'../private':'motion-takes',filename:take.id+'_00001_.mp4'}]}}};await app.pump();}};
}
test('sequential comparison survives restart and only exposes allowlisted output',async t=>{
  const f=await fixture(t);const r=await f.create(['left','reveal']);assert.equal(r.status,202);assert.equal(f.state.posts.length,1);
  assert.equal((await f.api('/api/boards',{image:'nope',settings,moves:['left']})).status,400);
  await f.restart();await f.app.pump();assert.equal(f.state.posts.length,1);
  await f.complete(r.data);assert.equal(f.state.posts.length,2);
  let b=(await f.api('/api/boards/'+r.data.id)).data;assert.equal(b.takes[0].state,'completed');assert.equal(b.takes[1].state,'queued');
  const recipe=await f.api(b.recipeURL);assert.equal(recipe.data.inputSHA256,r.data.inputSHA256);
  const workflow=await f.api(b.takes[0].workflowURL);assert.equal(workflow.data['10'].inputs.camera_pose,'Pan Left');
  await f.complete(r.data,1,true);b=(await f.api('/api/boards/'+r.data.id)).data;assert.equal(b.takes[1].state,'failed');assert.equal(b.takes[1].videoURL,null);
  assert.equal((await f.api('/api/media/'+b.id+'/'+b.takes[1].id)).status,404);
});
test('uncertain receipt blocks resubmission across restart',async t=>{
  const f=await fixture(t);f.state.drop=true;const r=await f.create();assert.equal((await f.api('/api/boards/'+r.data.id)).data.takes[0].state,'unknown');
  await f.restart();await f.app.pump();assert.equal(f.state.posts.length,1);
  const u=await f.api('/api/upload',png,{'content-type':'image/png'});
  assert.equal((await f.api('/api/boards',{image:u.data.id,settings,moves:['left']})).status,409);
  assert.equal((await f.api('/api/boards/'+r.data.id+'/'+r.data.takes[0].id+'/retry',{})).status,409);
});
test('explicit Comfy 400 fails, retry creates a new take while preserving old result',async t=>{
  const f=await fixture(t);f.state.reject=true;const r=await f.create();let b=(await f.api('/api/boards/'+r.data.id)).data;assert.equal(b.takes[0].state,'failed');
  f.state.reject=false;assert.equal((await f.api('/api/boards/'+b.id+'/'+b.takes[0].id+'/retry',{})).status,202);
  await new Promise(r=>setTimeout(r,30));b=(await f.api('/api/boards/'+b.id)).data;assert.equal(b.takes.length,2);assert.notEqual(b.takes[0].id,b.takes[1].id);assert.equal(b.takes[0].state,'failed');
});
test('concurrent board admission, foreign queue, cancellation and invalid upload',async t=>{
  const f=await fixture(t);f.state.pending=[[9,'other-user']];const u=await f.api('/api/upload',png,{'content-type':'image/png'});
  const results=await Promise.all([f.api('/api/boards',{image:u.data.id,settings,moves:['left','right']}),f.api('/api/boards',{image:u.data.id,settings,moves:['reveal']})]);
  assert.deepEqual(results.map(x=>x.status).sort(),[202,409]);await f.app.pump();assert.equal(f.state.posts.length,0);
  const b=results.find(x=>x.status===202).data;assert.equal((await f.api('/api/boards/'+b.id+'/cancel',{})).status,200);assert.ok((await f.api('/api/boards/'+b.id)).data.takes.every(x=>x.state==='cancelled'));
  assert.equal((await f.api('/api/upload',Buffer.from('fake'),{'content-type':'image/png'})).status,400);
  assert.equal((await f.api('/api/boards',{}, {origin:'https://unrelated.example'})).status,403);
});
