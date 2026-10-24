import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,mkdir,readdir,rename,rm,stat,realpath} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {MODEL,MOVES,REQUIRED_NODES,validateSettings,buildWorkflow} from './engine.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4'};
const busy=s=>['submitting','queued','running','unknown'].includes(s);
function error(message,status=400){return Object.assign(new Error(message),{status});}
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
async function body(req,max){let size=0;const out=[];for await(const b of req.iterator({destroyOnReturn:false})){size+=b.length;if(size>max){req.resume();throw error('입력 용량이 너무 큽니다.',413);}out.push(b);}return Buffer.concat(out);}
async function readJSON(req){if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw error('JSON 요청이 필요합니다.',415);const v=JSON.parse((await body(req,16000)).toString());if(!v||typeof v!=='object'||Array.isArray(v))throw error('JSON 객체가 필요합니다.');return v;}
function validatePNG(b){
  if(b.length<45||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||b.toString('ascii',12,16)!=='IHDR')throw error('PNG 이미지를 준비해주세요.');
  const w=b.readUInt32BE(16),h=b.readUInt32BE(20);if(!w||!h||w>2048||h>2048||w*h>2048*2048)throw error('이미지를 2048픽셀 이하로 준비해주세요.');
  let ended=false;for(let o=8;o+12<=b.length;){const n=b.readUInt32BE(o),kind=b.toString('ascii',o+4,o+8);if(o+12+n>b.length)throw error('잘린 이미지입니다.');if(kind==='acTL')throw error('정지 이미지가 필요합니다.');o+=n+12;if(kind==='IEND'){ended=o===b.length;break;}}
  if(!ended)throw error('PNG 파일 끝을 확인할 수 없습니다.');return {width:w,height:h};
}
const safeOutput=(d,takeId)=>d&&d.type==='output'&&d.subfolder==='motion-takes'&&typeof d.filename==='string'&&new RegExp('^'+takeId+'_[0-9]+_\\.mp4$').test(d.filename);
export async function createApp({comfyURL=process.env.COMFY_URL||'http://127.0.0.1:8188',dataDir=path.join(ROOT,'data'),publicDir=path.join(ROOT,'public'),tickMs=1800}={}){
  const target=new URL(comfyURL);if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw error('COMFY_URL은 인증 정보 없는 서버 루트여야 합니다.');
  await mkdir(path.join(dataDir,'uploads'),{recursive:true});await mkdir(path.join(dataDir,'boards'),{recursive:true});
  const boards=new Map(),uploads=new Map();let pumping=false,accepting=false,closed=false,preflightCache=null;
  const atomic=async(file,value)=>{const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value,null,2));await rename(temp,file);}finally{await rm(temp,{force:true});}};
  const save=b=>atomic(path.join(dataDir,'boards',b.id+'.json'),b);
  for(const name of await readdir(path.join(dataDir,'uploads'))){if(!name.endsWith('.json'))continue;try{const u=JSON.parse(await readFile(path.join(dataDir,'uploads',name),'utf8'));if(ID.test(u.id)&&u.comfyName===`takelab-${u.id}.png`)uploads.set(u.id,u);}catch{}}
  for(const name of await readdir(path.join(dataDir,'boards'))){if(!name.endsWith('.json'))continue;try{const b=JSON.parse(await readFile(path.join(dataDir,'boards',name),'utf8'));if(!ID.test(b.id)||b.version!==2||!Array.isArray(b.takes)||b.takes.some(t=>!ID.test(t.id)))continue;for(const t of b.takes)if(t.state==='submitting'){t.state='unknown';t.error='앱 재시작 중 접수 여부를 잃었습니다. Comfy 큐·기록을 확인해주세요.';}boards.set(b.id,b);}catch{}}
  async function call(route,options={},timeout=15000){const r=await fetch(new URL(route,target),{...options,signal:AbortSignal.timeout(timeout)});if(!r.ok){await r.body?.cancel();throw Object.assign(error('ComfyUI 응답을 확인해주세요.',502),{upstream:r.status});}return r;}
  async function data(route,options,timeout){const r=await call(route,options,timeout);let size=0;const out=[];for await(const chunk of r.body){size+=chunk.length;if(size>12*1024*1024)throw error('ComfyUI 응답이 너무 큽니다.',502);out.push(chunk);}return JSON.parse(Buffer.concat(out).toString());}
  async function preflight(force=false){
    if(!force&&preflightCache&&Date.now()-preflightCache.time<10000)return preflightCache;
    const [info,stats]=await Promise.all([data('/object_info'),data('/system_stats')]);const missingNodes=REQUIRED_NODES.filter(n=>!info[n]),missingModels=[];
    for(const [node,[field,name]] of Object.entries(MODEL.files)){const spec=info[node]?.input?.required?.[field],values=Array.isArray(spec?.[0])?spec[0]:spec?.[1]?.options||[];if(!values.includes(name))missingModels.push(name);}
    preflightCache={time:Date.now(),connected:true,ready:!missingNodes.length&&!missingModels.length,missingNodes,missingModels,model:MODEL.name,version:stats.system?.comfyui_version||'unknown',dynamicVideo:info.SaveVideo?.input?.required?.format?.[0]==='COMFY_DYNAMICCOMBO_V3'};return preflightCache;
  }
  const outputFrom=(item,id)=>Object.values(item.outputs||{}).flatMap(o=>[...(o.images||[]),...(o.videos||[])]).find(d=>safeOutput(d,id));
  async function sync(b,t){
    if(!t.promptId||!['queued','running','unknown'].includes(t.state))return;
    try{const h=await data('/history/'+encodeURIComponent(t.promptId)),item=h[t.promptId];
      if(item?.status?.status_str==='error'){t.state='failed';t.error='생성에 실패했습니다. ComfyUI 로그를 확인하고 이 테이크만 다시 실행할 수 있습니다.';}
      else if(item?.status?.completed){const output=outputFrom(item,t.id);if(output){t.output=output;t.state='completed';t.finishedAt=new Date().toISOString();t.error=null;}else{t.state='failed';t.error='생성 기록에 확인 가능한 MP4가 없습니다.';}}
      else{const q=await data('/queue');if(q.queue_running?.some(x=>x[1]===t.promptId))t.state='running';else if(q.queue_pending?.some(x=>x[1]===t.promptId))t.state='queued';else{t.state='unknown';t.error='큐와 기록에서 접수 결과를 확인하지 못했습니다. 자동으로 다시 제출하지 않습니다.';}}
      t.connectionLost=false;await save(b);
    }catch{t.connectionLost=true;}
  }
  async function pump(){
    if(pumping||closed)return;pumping=true;
    try{
      for(const b of boards.values())for(const t of b.takes)if(busy(t.state))await sync(b,t);
      if(closed||[...boards.values()].some(b=>b.takes.some(t=>busy(t.state))))return;
      for(const b of boards.values()){
        const t=b.takes.find(t=>t.state==='waiting');if(!t)continue;
        let ready;try{ready=await preflight();if(!ready.ready){t.state='failed';t.error='필요한 모델·노드가 없습니다. 연결 상태를 확인해주세요.';await save(b);return;}}catch{t.connectionLost=true;return;}
        const q=await data('/queue');if(closed||t.state!=='waiting'||q.queue_running?.length||q.queue_pending?.length)return;
        t.workflow=buildWorkflow({image:b.comfyName,move:t.move,settings:b.settings,prefix:'motion-takes/'+t.id,dynamicVideo:ready.dynamicVideo});
        t.state='submitting';t.startedAt=new Date().toISOString();t.error=null;await save(b);
        try{const receipt=await data('/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:t.workflow,client_id:'motion-takes-'+t.id})},30000);if(typeof receipt.prompt_id!=='string'||!receipt.prompt_id)throw Error('missing receipt');t.promptId=receipt.prompt_id;t.state='queued';}
        catch(e){t.state=e.upstream===400?'failed':'unknown';t.error=e.upstream===400?'ComfyUI가 그래프를 거부했습니다. 모델·노드 버전을 확인해주세요.':'접수 응답이 불확실합니다. Comfy 큐를 확인할 때까지 다음 테이크를 제출하지 않습니다.';}
        await save(b);return;
      }
    }catch{/* Preserve submitting/unknown rather than risking a duplicate. */}finally{pumping=false;}
  }
  const publicBoard=b=>({id:b.id,createdAt:b.createdAt,model:MODEL.name,inputSHA256:b.inputSHA256,settings:b.settings,takes:b.takes.map(t=>({id:t.id,move:t.move,label:MOVES[t.move]?.label,state:t.state,error:t.error||null,connectionLost:!!t.connectionLost,startedAt:t.startedAt,finishedAt:t.finishedAt,videoURL:t.output?`/api/media/${b.id}/${t.id}`:null,workflowURL:t.workflow?`/api/boards/${b.id}/${t.id}/workflow`:null})),recipeURL:`/api/boards/${b.id}/recipe`});
  const server=http.createServer(async(req,res)=>{
    try{
      res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
      const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))return json(res,403,{error:'로컬 주소로 앱을 열어주세요.'});if(req.headers.origin&&req.headers.origin!==`http://${host}`)return json(res,403,{error:'같은 앱 화면에서 요청해주세요.'});
      const p=new URL(req.url,`http://${host}`).pathname;
      if(req.method==='GET'&&p==='/api/status'){try{return json(res,200,{...await preflight(),moves:MOVES});}catch{return json(res,200,{connected:false,ready:false,model:MODEL.name,moves:MOVES,error:'ComfyUI에 연결할 수 없습니다.'});}}
      if(req.method==='GET'&&p==='/api/boards')return json(res,200,[...boards.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(publicBoard));
      if(req.method==='POST'&&p==='/api/upload'){
        if(req.headers['content-type']?.split(';')[0]!=='image/png')throw error('PNG 이미지가 필요합니다.');const bytes=await body(req,8*1024*1024),dimensions=validatePNG(bytes),id=randomUUID(),name=`takelab-${id}.png`;
        const form=new FormData();form.set('image',new Blob([bytes],{type:'image/png'}),name);form.set('type','input');form.set('overwrite','false');
        const result=await data('/upload/image',{method:'POST',body:form},30000);if(result.name!==name||result.subfolder)throw error('업로드 응답이 일치하지 않습니다.',502);
        const u={id,comfyName:name,sha256:createHash('sha256').update(bytes).digest('hex'),...dimensions};await writeFile(path.join(dataDir,'uploads',name),bytes,{flag:'wx'});await atomic(path.join(dataDir,'uploads',id+'.json'),u);uploads.set(id,u);return json(res,201,{id,sha256:u.sha256});
      }
      if(req.method==='POST'&&p==='/api/boards'){
        const v=await readJSON(req),u=uploads.get(v.image);if(!u)throw error('이미지를 먼저 올려주세요.');const settings=validateSettings(v.settings);
        if(!Array.isArray(v.moves)||v.moves.length<1||v.moves.length>3||new Set(v.moves).size!==v.moves.length||v.moves.some(m=>!Object.hasOwn(MOVES,m)))throw error('서로 다른 카메라 조건을 1~3개 선택해주세요.');
        if(accepting||[...boards.values()].some(b=>b.takes.some(t=>busy(t.state)||t.state==='waiting')))throw error('이전 생성 또는 접수 확인이 진행 중입니다.',409);
        accepting=true;try{const status=await preflight(true);if(!status.ready)throw error('필요한 모델·노드를 먼저 준비해주세요.',409);const b={version:2,id:randomUUID(),createdAt:new Date().toISOString(),comfyName:u.comfyName,inputSHA256:u.sha256,settings,takes:v.moves.map(move=>({id:randomUUID(),move,state:'waiting'}))};await save(b);boards.set(b.id,b);json(res,202,publicBoard(b));void pump();return;}finally{accepting=false;}
      }
      const match=p.match(/^\/api\/boards\/([a-f0-9-]+)(?:\/(recipe|cancel|[a-f0-9-]+)(?:\/(workflow|retry))?)?$/);
      if(match){const b=boards.get(match[1]);if(!b)return json(res,404,{error:'비교 작업이 없습니다.'});
        if(req.method==='GET'&&!match[2])return json(res,200,publicBoard(b));
        if(req.method==='GET'&&match[2]==='recipe'){res.setHeader('content-disposition',`attachment; filename="motion-takes-${b.id}.json"`);return json(res,200,{version:2,model:MODEL,settings:b.settings,inputSHA256:b.inputSHA256,takes:b.takes.map(t=>({id:t.id,move:t.move,state:t.state}))});}
        const t=b.takes.find(t=>t.id===match[2]);
        if(req.method==='GET'&&t&&match[3]==='workflow'&&t.workflow){res.setHeader('content-disposition',`attachment; filename="motion-take-${t.id}.json"`);return json(res,200,t.workflow);}
        if(req.method==='POST'&&match[2]==='cancel'){await readJSON(req);for(const t of b.takes)if(t.state==='waiting')t.state='cancelled';await save(b);return json(res,200,publicBoard(b));}
        if(req.method==='POST'&&t&&match[3]==='retry'){await readJSON(req);if(t.state!=='failed')throw error('실패한 테이크만 다시 실행할 수 있습니다.',409);if(accepting||[...boards.values()].some(b=>b.takes.some(t=>busy(t.state)||t.state==='waiting')))throw error('다른 실행이 끝난 뒤 시도해주세요.',409);const next={id:randomUUID(),move:t.move,state:'waiting',retryOf:t.id};b.takes.push(next);await save(b);json(res,202,publicBoard(b));void pump();return;}
      }
      const media=p.match(/^\/api\/media\/([a-f0-9-]+)\/([a-f0-9-]+)$/);
      if(req.method==='GET'&&media){const t=boards.get(media[1])?.takes.find(t=>t.id===media[2]);if(!safeOutput(t?.output,t?.id))throw error('출력이 없습니다.',404);const q=new URLSearchParams(t.output);const r=await call('/view?'+new URLSearchParams({filename:t.output.filename,subfolder:t.output.subfolder,type:'output'}),{},30000);res.writeHead(200,{'content-type':'video/mp4','cache-control':'private, max-age=3600','content-disposition':`inline; filename="${t.output.filename}"`});await pipeline(r.body,res);return;}
      if(p.startsWith('/api/'))return json(res,404,{error:'API를 찾을 수 없습니다.'});
      if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'허용하지 않는 요청입니다.'});
      const decoded=decodeURIComponent(p);if(decoded.includes('..')||/[\\\x00-\x1f:]/.test(decoded))throw error('허용하지 않는 경로입니다.',403);
      const file=path.join(publicDir,decoded==='/'?'index.html':decoded),ext=path.extname(file);if(!MIME[ext])throw error('파일이 없습니다.',404);
      try{const [root,real]=await Promise.all([realpath(publicDir),realpath(file)]);if(!real.startsWith(root+path.sep))throw Error();const s=await stat(real);if(!s.isFile())throw Error();res.writeHead(200,{'content-type':MIME[ext],'content-length':s.size,'cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:await readFile(real));}catch{if(!res.headersSent)json(res,404,{error:'파일이 없습니다.'});else res.destroy();}
    }catch(e){if(!res.headersSent)json(res,e.status||400,{error:e instanceof SyntaxError?'요청 형식을 확인해주세요.':e.status?e.message:'입력과 연결 상태를 확인해주세요.'});else res.destroy();}
  });
  const timer=setInterval(()=>void pump(),tickMs);timer.unref();server.on('close',()=>{closed=true;clearInterval(timer);});server.pump=pump;
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const server=await createApp();server.listen(Number(process.env.PORT||4318),'127.0.0.1',()=>console.log('Motion Takes http://127.0.0.1:'+(process.env.PORT||4318)));}
