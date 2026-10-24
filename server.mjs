import http from 'node:http';
import {readFile,writeFile,mkdir,readdir,stat,rename,rm} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.join(ROOT,'data');
const PUBLIC=path.join(ROOT,'public');
const MAX_UPLOAD=15*1024*1024;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp4':'video/mp4','.svg':'image/svg+xml'};
export const LOOKS={
  original:{label:'원본 유지',prompt:'',denoise:0},
  morning:{label:'아침의 빛',prompt:'cinematic interior photography, soft warm morning sunlight, airy natural materials, beautiful detailed environment, preserve the room layout',denoise:.3},
  bluehour:{label:'블루 아워',prompt:'cinematic interior photography at blue hour, cool evening window light, warm practical lamps, atmospheric soft shadows, preserve the room layout',denoise:.34},
  film:{label:'필름 스틸',prompt:'cinematic film still, soft diffused light, muted analogue color palette, detailed natural textures, preserve the room layout',denoise:.28}
};
export function validateRecipe(value){
  const keys=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
  if(!keys(value,['version','width','height','fps','duration','start','end','easing'])||value.version!==1||!keys(value.start,['x','y','zoom'])||!keys(value.end,['x','y','zoom']))throw new Error('카메라 레시피 v1 필드를 확인하세요.');
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('카메라 레시피가 필요합니다.');
  const num=(v,min,max,integer=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v))) throw new Error('카메라 설정 범위를 확인하세요.');return v;};
  const point=p=>({x:num(p?.x,0,1),y:num(p?.y,0,1),zoom:num(p?.zoom,1,3)});
  const r={version:1,width:num(value.width,128,1280,true),height:num(value.height,128,1280,true),fps:num(value.fps,1,30,true),duration:num(value.duration,.5,8),start:point(value.start),end:point(value.end),easing:value.easing};
  if(r.width%2||r.height%2||Math.round(r.duration*r.fps)>240||!['linear','smoothstep'].includes(r.easing)) throw new Error('짝수 해상도, 240프레임 이하, 지원하는 easing을 선택하세요.');
  return r;
}
export function makeWorkflow({image,recipe,look='original',seed=42,checkpoint=''}){
  const r=validateRecipe(recipe);
  if(typeof image!=='string'||!image||image.length>200||(image.includes('..')||image.includes(':'))||/[\\\x00-\x1f]/.test(image)||path.posix.isAbsolute(image)) throw new Error('유효한 업로드 이미지가 필요합니다.');
  if(!Object.hasOwn(LOOKS,look)) throw new Error('지원하지 않는 룩입니다.');
  if(!Number.isSafeInteger(seed)||seed<0) throw new Error('시드는 0 이상의 안전한 정수여야 합니다.');
  const graph={'1':{class_type:'LoadImage',inputs:{image}}};
  let pixels=['1',0];
  if(look!=='original'){
    if(typeof checkpoint!=='string'||!checkpoint||checkpoint.length>250) throw new Error('설치된 SDXL 체크포인트를 선택하세요.');
    Object.assign(graph,{
      '2':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:checkpoint}},
      '3':{class_type:'CLIPTextEncode',inputs:{text:LOOKS[look].prompt,clip:['2',1]}},
      '4':{class_type:'CLIPTextEncode',inputs:{text:'text, watermark, logo, people, distorted architecture, low quality, blurry',clip:['2',1]}},
      '5':{class_type:'VAEEncode',inputs:{pixels:['1',0],vae:['2',2]}},
      '6':{class_type:'KSampler',inputs:{model:['2',0],positive:['3',0],negative:['4',0],latent_image:['5',0],seed,steps:20,cfg:6,sampler_name:'euler',scheduler:'normal',denoise:LOOKS[look].denoise}},
      '7':{class_type:'VAEDecode',inputs:{samples:['6',0],vae:['2',2]}},
      '8':{class_type:'SaveImage',inputs:{images:['7',0],filename_prefix:'takelab/look'}}
    });
    pixels=['7',0];
  }
  graph['20']={class_type:'TakeLabCameraRender',inputs:{image:pixels,recipe:JSON.stringify(r),filename_prefix:'takelab/take'}};
  return graph;
}
const safeDescriptor=d=>d&&typeof d.filename==='string'&&['.png','.jpg','.jpeg','.webp','.mp4','.json'].includes(path.extname(d.filename).toLowerCase())&&typeof d.filename==='string'&&d.filename.length>0&&d.filename.length<300&&!d.filename.includes(':')&&!/[\\/\x00-\x1f]/.test(d.filename)&&!d.filename.includes('..')&&typeof d.subfolder==='string'&&d.subfolder.length<500&&!d.subfolder.includes(':')&&!d.subfolder.split('/').includes('..')&&!/[\\\x00-\x1f]/.test(d.subfolder)&&!path.posix.isAbsolute(d.subfolder)&&d.type==='output';
function outputsFrom(history){
  const result=[];
  for(const output of Object.values(history.outputs||{})) for(const kind of ['videos','images','takelab_recipe']) for(const descriptor of output[kind]||[]){
    if(!safeDescriptor(descriptor))continue;
    const extension=path.extname(descriptor.filename).toLowerCase();
    if(!['.png','.jpg','.jpeg','.webp','.mp4','.json'].includes(extension))continue;
    if(!result.some(x=>x.filename===descriptor.filename&&x.subfolder===descriptor.subfolder&&x.type===descriptor.type)) result.push({...descriptor,kind:extension==='.mp4'?'video':extension==='.json'?'recipe':'image'});
  }
  return result;
}
function sendJSON(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}
async function readBody(req,limit){const chunks=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>limit){const e=new Error('파일이 너무 큽니다. 최대 15MB 이미지로 줄여주세요.');e.status=413;req.resume();throw e;}chunks.push(chunk);}return Buffer.concat(chunks);}
function imageType(bytes){if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return ['image/png','.png'];if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return ['image/jpeg','.jpg'];if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return ['image/webp','.webp'];throw new Error('PNG, JPEG, WebP 이미지 파일을 선택하세요.');}
async function readJSON(req){
  if(req.headers['content-type']?.split(';')[0].trim()!=='application/json'){const e=new Error('application/json 요청이 필요합니다.');e.status=415;throw e;}
  const value=JSON.parse((await readBody(req,20000)).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('JSON 객체가 필요합니다.');
  return value;
}
// Header checks bound allocation before Comfy decodes; Comfy remains the pixel decoder.
export function validateImageSize(b,mime){
  let w=0,h=0;
  if(mime==='image/png'&&b.length>=33&&b.toString('ascii',12,16)==='IHDR'){
    w=b.readUInt32BE(16);h=b.readUInt32BE(20);
    for(let o=8;o+12<=b.length;){const n=b.readUInt32BE(o);if(o+12+n>b.length)throw new Error('이미지 PNG 데이터가 잘렸습니다.');if(b.toString('ascii',o+4,o+8)==='acTL')throw new Error('이미지 애니메이션은 지원하지 않습니다.');o+=12+n;}
  }else if(mime==='image/jpeg'){
    for(let o=2;o+4<=b.length;){if(b[o++]!==255)break;while(b[o]===255)o++;const marker=b[o++];if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;const n=b.readUInt16BE(o);if(n<2||o+n>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&n>=8){h=b.readUInt16BE(o+3);w=b.readUInt16BE(o+5);break;}o+=n;}
  }else if(mime==='image/webp'&&b.length>=20&&b.readUInt32LE(4)+8===b.length){
    const kind=b.toString('ascii',12,16);
    if(kind==='VP8X'&&b.length>=30){if(b[20]&2)throw new Error('이미지 애니메이션은 지원하지 않습니다.');w=1+b.readUIntLE(24,3);h=1+b.readUIntLE(27,3);}
    else if(kind==='VP8 '&&b.length>=30&&b[23]===157&&b[24]===1&&b[25]===42){w=b.readUInt16LE(26)&16383;h=b.readUInt16LE(28)&16383;}
    else if(kind==='VP8L'&&b.length>=25&&b[20]===47){const bits=b.readUInt32LE(21);w=(bits&16383)+1;h=((bits>>>14)&16383)+1;}
  }
  if(!w||!h||w>65536||h>65536||w*h>16777216)throw new Error('이미지 크기를 확인하세요. 최대 16,777,216픽셀의 정지 이미지를 지원합니다.');
  return {width:w,height:h};
}
export async function createApp({comfyURL=process.env.COMFY_URL||'http://127.0.0.1:8188',dataDir=DATA}={}){
  const target=new URL(comfyURL);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash||target.pathname!=='/') throw new Error('COMFY_URL은 인증정보 없는 Comfy 서버의 루트 URL이어야 합니다.');
  const jobs=new Map(),uploads=new Map();
  let accepting=false;
  await mkdir(path.join(dataDir,'jobs'),{recursive:true});
  await mkdir(path.join(dataDir,'uploads'),{recursive:true});
  for(const name of await readdir(path.join(dataDir,'jobs'))){if(!/^[a-f0-9-]+\.json$/.test(name))continue;try{const j=JSON.parse(await readFile(path.join(dataDir,'jobs',name),'utf8'));if(j.state==='submitting'){j.state='unknown';j.error='접수 중 앱이 다시 시작됐습니다. ComfyUI 큐를 먼저 확인하세요.';}if(j.id&&j.workflow)jobs.set(j.id,j);}catch{}}
  for(const name of await readdir(path.join(dataDir,'uploads'))){if(!name.endsWith('.json'))continue;try{const u=JSON.parse(await readFile(path.join(dataDir,'uploads',name),'utf8'));if(u.id&&u.comfyName)uploads.set(u.id,u);}catch{}}
  const save=async job=>{const file=path.join(dataDir,'jobs',job.id+'.json'),temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(job,null,2));await rename(temp,file);}finally{await rm(temp,{force:true});}};
  async function comfy(route,options={},timeout=10000){const response=await fetch(new URL(route,target),{...options,signal:AbortSignal.timeout(timeout)});if(!response.ok){const err=new Error(response.status===400?'ComfyUI가 워크플로를 거절했습니다. 노드·모델 설정을 확인하세요.':'ComfyUI 서버 응답을 확인할 수 없습니다.');err.status=502;err.upstreamStatus=response.status;await response.body?.cancel();throw err;}return response;}
  async function comfyJSON(route,options,timeout){const response=await comfy(route,options,timeout);const length=Number(response.headers.get('content-length')||0);if(length>8*1024*1024)throw new Error('Comfy 응답 크기가 너무 큽니다.');const reader=response.body.getReader();let size=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024){await reader.cancel();throw new Error('Comfy 응답 크기가 너무 큽니다.');}chunks.push(Buffer.from(value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  const syncing=new Map();
  function syncJob(job){if(syncing.has(job.id))return syncing.get(job.id);const pending=syncJobOnce(job).finally(()=>syncing.delete(job.id));syncing.set(job.id,pending);return pending;}
  async function syncJobOnce(job){
    if(!job.promptId||['completed','failed'].includes(job.state))return job;
    try{
      const history=await comfyJSON('/history/'+encodeURIComponent(job.promptId));
      const item=history[job.promptId];
      if(item){
        if(item.status?.status_str==='error'){job.state='failed';job.error='ComfyUI 실행이 실패했습니다. Comfy 서버 로그와 설치된 모델을 확인하세요.';}
        else if(item.status?.completed){job.outputs=outputsFrom(item);job.state=job.outputs.some(x=>x.kind==='video')?'completed':'failed';if(job.state==='failed')job.error='작업은 끝났지만 MP4 출력을 찾지 못했습니다.';}
        else job.state='running';
      }else{
        const queue=await comfyJSON('/queue');
        if((queue.queue_running||[]).some(x=>x[1]===job.promptId))job.state='running';
        else if((queue.queue_pending||[]).some(x=>x[1]===job.promptId))job.state='queued';
        else {job.state='unknown';job.error='큐와 기록에서 작업을 찾지 못했습니다. 중복 실행을 막기 위해 자동 재접수하지 않습니다.';}
      }
      job.connectionLost=false;await save(job);
    }catch{job.connectionLost=true;}
    return job;
  }
  const publicJob=j=>({id:j.id,state:j.state,look:j.look,seed:j.seed,checkpoint:j.checkpoint,recipe:j.recipe,createdAt:j.createdAt,connectionLost:!!j.connectionLost,error:j.error||null,outputs:(j.outputs||[]).map((d,i)=>({kind:d.kind,filename:d.filename,url:`/api/media/${j.id}/${i}`})),workflowURL:`/api/jobs/${j.id}/workflow`,recipeURL:`/api/jobs/${j.id}/recipe`});
  const server=http.createServer(async(req,res)=>{
    try{
      res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
      const host=req.headers.host||'';
      if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))return sendJSON(res,403,{error:'로컬 주소로 앱을 열어주세요.'});
      if(req.headers.origin&&req.headers.origin!==`http://${host}`)return sendJSON(res,403,{error:'같은 앱 화면에서 다시 시도하세요.'});
      const url=new URL(req.url,`http://${host}`),p=url.pathname;
      if(req.method==='GET'&&p==='/api/status'){
        try{const [stats,info,loader]=await Promise.all([comfyJSON('/system_stats'),comfyJSON('/object_info/TakeLabCameraRender'),comfyJSON('/object_info/CheckpointLoaderSimple')]);
          return sendJSON(res,200,{connected:true,cameraNode:!!info.TakeLabCameraRender,checkpoints:loader.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]||[],version:stats.system?.comfyui_version||'unknown',looks:LOOKS});
        }catch{return sendJSON(res,200,{connected:false,cameraNode:false,checkpoints:[],looks:LOOKS,error:'ComfyUI에 연결되지 않았습니다. 서버를 켠 뒤 연결 확인을 누르세요.'});}
      }
      if(req.method==='GET'&&p==='/api/examples'){
        try{return sendJSON(res,200,JSON.parse(await readFile(path.join(PUBLIC,'assets','manifest.json'),'utf8')));}catch{return sendJSON(res,200,[]);}
      }
      if(req.method==='POST'&&p==='/api/upload'){
        const bytes=await readBody(req,MAX_UPLOAD),[mime,ext]=imageType(bytes);validateImageSize(bytes,mime);
        if(req.headers['content-type']?.split(';')[0]!==mime)throw new Error('이미지 파일 형식과 전송 형식이 다릅니다.');
        const id=randomUUID(),name=`takelab-${id}${ext}`;
        const form=new FormData();form.set('image',new Blob([bytes],{type:mime}),name);form.set('type','input');form.set('overwrite','false');
        let result;try{result=await comfyJSON('/upload/image',{method:'POST',body:form},30000);}catch{const e=new Error('이미지를 ComfyUI에 올리지 못했습니다. 연결 상태를 확인하세요.');e.status=503;throw e;}
        if(!result.name||typeof result.name!=='string'||(result.name.includes('..')||result.name.includes(':'))||/[\\/\x00-\x1f]/.test(result.name)||result.subfolder)throw new Error('ComfyUI 업로드 응답을 확인할 수 없습니다.');
        const entry={id,comfyName:result.name,mime,sha256:createHash('sha256').update(bytes).digest('hex')};
        await writeFile(path.join(dataDir,'uploads',id+ext),bytes);await writeFile(path.join(dataDir,'uploads',id+'.json'),JSON.stringify(entry));uploads.set(id,entry);
        return sendJSON(res,201,{id,sha256:entry.sha256});
      }
      if(req.method==='POST'&&p==='/api/jobs'){
        const body=await readJSON(req);
        const uploaded=uploads.get(body.image);if(!uploaded)throw new Error('먼저 이미지를 ComfyUI에 올려주세요.');
        const uncertain=[...jobs.values()].find(x=>x.state==='unknown');
        if(uncertain)return sendJSON(res,409,{error:'이전 작업의 접수 여부가 불확실합니다. ComfyUI 큐·기록을 먼저 확인하세요. 중복 실행 방지를 위해 새 접수를 보류합니다.',job:publicJob(uncertain)});
        if(accepting||[...jobs.values()].some(x=>['submitting','queued','running','unknown'].includes(x.state)))return sendJSON(res,409,{error:'진행 중인 TakeLab 작업이 있습니다. 완료 후 다음 테이크를 만드세요.'});
        accepting=true;
        try{
        const recipe=validateRecipe(body.recipe),look=body.look||'original',seed=body.seed??42,checkpoint=body.checkpoint||'';
        const info=await comfyJSON('/object_info/TakeLabCameraRender');if(!info.TakeLabCameraRender)throw new Error('TakeLabCameraRender 노드를 설치하고 ComfyUI를 다시 시작하세요.');
        if(look!=='original'){const info=await comfyJSON('/object_info/CheckpointLoaderSimple');const available=info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]||[];if(!available.includes(checkpoint))throw new Error('ComfyUI에 설치된 체크포인트를 선택하세요.');}
        const workflow=makeWorkflow({image:uploaded.comfyName,recipe,look,seed,checkpoint});
        const job={id:randomUUID(),state:'submitting',createdAt:new Date().toISOString(),recipe,look,seed,checkpoint,workflow,inputSHA256:uploaded.sha256,outputs:[]};jobs.set(job.id,job);await save(job);
        try{const receipt=await comfyJSON('/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:workflow,client_id:'takelab-'+job.id})},30000);
          if(typeof receipt.prompt_id!=='string')throw new Error('missing prompt ID');job.promptId=receipt.prompt_id;job.state='queued';
        }catch(e){if(e.upstreamStatus===400){job.state='failed';job.error='ComfyUI가 워크플로 접수를 거절했습니다. 노드·모델 설정을 확인하세요.';await save(job);return sendJSON(res,422,publicJob(job));}job.state='unknown';job.error='접수 여부를 확인할 수 없습니다. ComfyUI 큐를 확인하세요. 자동 재접수하지 않습니다.';await save(job);return sendJSON(res,202,publicJob(job));}
        await save(job);return sendJSON(res,202,publicJob(job));
        }finally{accepting=false;}
      }
      const jm=p.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(workflow|recipe))?$/);
      if(req.method==='GET'&&jm){const job=jobs.get(jm[1]);if(!job)return sendJSON(res,404,{error:'작업이 없습니다.'});if(jm[2]){res.setHeader('content-disposition',`attachment; filename="takelab-${jm[2]}-${job.id}.json"`);return sendJSON(res,200,jm[2]==='workflow'?job.workflow:{...job.recipe,look:job.look,seed:job.seed,checkpoint:job.checkpoint,inputSHA256:job.inputSHA256,createdAt:job.createdAt});}return sendJSON(res,200,publicJob(await syncJob(job)));}
      const mm=p.match(/^\/api\/media\/([a-f0-9-]+)\/(\d+)$/);
      if(req.method==='GET'&&mm){const job=jobs.get(mm[1]),d=job?.outputs?.[Number(mm[2])];if(!safeDescriptor(d))return sendJSON(res,404,{error:'출력 파일이 없습니다.'});const query=new URLSearchParams({filename:d.filename,subfolder:d.subfolder,type:d.type});const response=await comfy('/view?'+query,{},30000);res.writeHead(200,{'content-type':MIME[path.extname(d.filename).toLowerCase()]||'application/octet-stream','cache-control':'private, max-age=3600','content-disposition':`inline; filename="${d.filename.replace(/[^a-zA-Z0-9_.-]/g,'_')}"`});await pipeline(response.body,res);return;}
      if(req.method!=='GET'&&req.method!=='HEAD')return sendJSON(res,405,{error:'지원하지 않는 요청입니다.'});
      let decoded;try{decoded=decodeURIComponent(p);}catch{return sendJSON(res,400,{error:'주소를 확인하세요.'});}
      if(decoded.includes('..')||decoded.includes('\\')||decoded.includes('\0'))return sendJSON(res,403,{error:'허용되지 않는 경로입니다.'});
      const file=path.join(PUBLIC,decoded==='/'?'index.html':decoded),ext=path.extname(file);
      if(!MIME[ext])return sendJSON(res,404,{error:'파일이 없습니다.'});
      try{const st=await stat(file);if(!st.isFile())throw new Error();res.writeHead(200,{'content-type':MIME[ext],'cache-control':ext==='.html'?'no-cache':'public, max-age=3600','content-length':st.size});res.end(req.method==='HEAD'?undefined:await readFile(file));}catch{return sendJSON(res,404,{error:'파일이 없습니다.'});}
    }catch(error){if(!res.headersSent)sendJSON(res,error.status||400,{error:error instanceof SyntaxError?'요청 형식을 확인하세요.':error.message?.startsWith('Comfy')||error.status||/레시피|카메라|시드|룩|이미지|체크포인트|먼저|노드|해상도|전송/.test(error.message)?error.message:'요청을 처리하지 못했습니다. 입력과 연결 상태를 확인하세요.'});else res.destroy();}
  });
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=await createApp();const port=Number(process.env.PORT||4317);server.listen(port,'127.0.0.1',()=>console.log(`TakeLab http://127.0.0.1:${port}`));
}
