import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp,makeWorkflow,validateRecipe,validateImageSize} from '../server.mjs';

const recipe={version:1,width:384,height:216,duration:3,fps:24,start:{x:.5,y:.5,zoom:1},end:{x:.5,y:.5,zoom:1.5},easing:'smoothstep'};
test('a camera take keeps the source on a real node path; a look uses actual SDXL sampling',()=>{
  const camera=makeWorkflow({image:'input.png',recipe});assert.deepEqual(camera['20'].inputs.image,['1',0]);assert.equal(camera['20'].class_type,'TakeLabCameraRender');assert.equal(Object.values(camera).some(n=>n.class_type==='KSampler'),false);
  const look=makeWorkflow({image:'input.png',recipe,look:'morning',checkpoint:'sd_xl_base_1.0.safetensors',seed:123});assert.deepEqual(look['20'].inputs.image,['7',0]);assert.equal(look['6'].inputs.seed,123);assert.equal(look['6'].class_type,'KSampler');
});
test('reject malformed, nonfinite, fractional/eccentric and oversized recipe values',()=>{
  for(const r of [null,{...recipe,width:383},{...recipe,fps:60},{...recipe,duration:Infinity},{...recipe,end:{x:1.1,y:.5,zoom:1}},{...recipe,end:{x:.5,y:.5,zoom:.9}},{...recipe,width:'384'}])assert.throws(()=>validateRecipe(r));
  assert.throws(()=>makeWorkflow({image:'../secret.png',recipe}));assert.throws(()=>makeWorkflow({image:'input.png',recipe,look:'__proto__'}));assert.throws(()=>makeWorkflow({image:'input.png',recipe,seed:NaN}));
});

let fake,app,dir,base,postCount=0,mode='normal',history={};
async function start(){
  dir=await mkdtemp(path.join(os.tmpdir(),'takelab-test-'));
  fake=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('content-type','application/json');
    if(url.pathname==='/system_stats')return res.end(JSON.stringify({system:{comfyui_version:'test'}}));
    if(url.pathname==='/object_info/TakeLabCameraRender')return res.end(JSON.stringify({TakeLabCameraRender:{}}));
    if(url.pathname==='/object_info/CheckpointLoaderSimple')return res.end(JSON.stringify({CheckpointLoaderSimple:{input:{required:{ckpt_name:[['test.safetensors']]}}}}));
    if(url.pathname==='/upload/image')return res.end(JSON.stringify({name:'verified.png',subfolder:''}));
    if(url.pathname==='/prompt'){postCount++;if(mode==='reject'){res.writeHead(400);res.end('{}');return;}if(mode==='uncertain'){res.end('{broken');return;}await new Promise(r=>setTimeout(r,30));return res.end(JSON.stringify({prompt_id:'prompt-'+postCount}));}
    if(url.pathname.startsWith('/history/'))return res.end(JSON.stringify(history));
    if(url.pathname==='/queue')return res.end(JSON.stringify({queue_running:[[0,'prompt-1']],queue_pending:[]}));
    if(url.pathname==='/view'){res.setHeader('content-type','video/mp4');return res.end('video-fixture');}
    res.writeHead(404);res.end('{}');
  });await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
  app=await createApp({comfyURL:`http://127.0.0.1:${fake.address().port}`,dataDir:dir});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.address().port}`;
}
after(async()=>{await Promise.all([app&&new Promise(r=>app.close(r)),fake&&new Promise(r=>fake.close(r))]);if(dir)await rm(dir,{recursive:true,force:true});});
test('end-to-end HTTP: safe upload, exactly one submit, poll, allowlisted artifacts, workflow and unknown receipt',async()=>{
  await start();const request=(p,o)=>fetch(base+p,o);const json=async(p,o)=>{const r=await request(p,o);return [r,await r.json()];};
  let [r,status]=await json('/api/status');assert.equal(status.connected,true);assert.equal(status.cameraNode,true);
  [r]=await json('/api/upload',{method:'POST',headers:{'content-type':'image/png',origin:'https://evil.example'},body:'bad'});assert.equal(r.status,403);
  [r]=await json('/api/upload',{method:'POST',headers:{'content-type':'image/png'},body:'not a png'});assert.equal(r.status,400);
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
  const [,upload]=await json('/api/upload',{method:'POST',headers:{'content-type':'image/png'},body:bytes});assert.ok(upload.id);assert.equal(upload.sha256.length,64);
  const submit=()=>json('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:upload.id,recipe})});
  const pair=await Promise.all([submit(),submit()]);assert.deepEqual(pair.map(x=>x[0].status).sort(),[202,409]);const job=pair.find(x=>x[0].status===202)[1];assert.equal(job.state,'queued');assert.equal(postCount,1);
  [r]=await submit();assert.equal(r.status,409);assert.equal(postCount,1);
  const [,running]=await json('/api/jobs/'+job.id);assert.equal(running.state,'running');
  history={'prompt-1':{status:{completed:true,status_str:'success'},outputs:{'20':{videos:[{filename:'take.mp4',subfolder:'takelab/take1',type:'output'},{filename:'secret.mp4',subfolder:'../private',type:'output'}],images:[{filename:'preview.png',subfolder:'takelab/take1',type:'output'}]}}}};
  history['prompt-1'].outputs['20'].videos.push(...[
    {filename:'stream.mp4:secret',subfolder:'takelab',type:'output'},
    {filename:'hidden.mp4',subfolder:'C:/private',type:'output'},
    {filename:'temp.mp4',subfolder:'takelab',type:'temp'},
    {filename:'payload.html',subfolder:'takelab',type:'output'}
  ]);
  const [,done]=await json('/api/jobs/'+job.id);assert.equal(done.state,'completed');assert.equal(done.outputs.length,2);
  assert.equal((await request(done.outputs[0].url)).status,200);assert.equal((await request('/api/media/'+job.id+'/99')).status,404);
  const [,workflow]=await json(done.workflowURL);assert.equal(workflow['20'].class_type,'TakeLabCameraRender');
  mode='reject';const [rejected,failed]=await submit();assert.equal(rejected.status,422);assert.equal(failed.state,'failed');assert.equal(postCount,2);
  mode='uncertain';const [,unknown]=await submit();assert.equal(unknown.state,'unknown');assert.equal(postCount,3);await json('/api/jobs/'+unknown.id);assert.equal(postCount,3);
  assert.equal((await submit())[0].status,409);assert.equal(postCount,3);
  assert.equal((await request('/api/media/'+unknown.id+'/0')).status,404);
  assert.equal((await request('/api/media/0000/0')).status,404);
  assert.equal((await request('/%2e%2e%2fserver.mjs')).status,403);
  assert.equal((await request('/server.mjs')).status,404);
  const badHostStatus=await new Promise((resolve,reject)=>{http.get(base+'/api/status',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(badHostStatus,403);
  for(const body of ['null','[]','{bad'])assert.equal((await request('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body})).status,400);
  assert.equal((await request('/api/jobs',{method:'POST',body:'{}'})).status,415);
  assert.equal((await request('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(21000)})).status,413);
  await new Promise(r=>app.close(r));
  await writeFile(path.join(dir,'jobs','aaaa.json'),JSON.stringify({id:'aaaa',state:'submitting',workflow:{},outputs:[]}));
  await writeFile(path.join(dir,'jobs','bbbb.json'),JSON.stringify({id:'bbbb',state:'queued',promptId:'prompt-1',workflow:{},outputs:[]}));
  app=await createApp({comfyURL:`http://127.0.0.1:${fake.address().port}`,dataDir:dir});await new Promise(r=>app.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.address().port}`;
  assert.equal((await json('/api/jobs/aaaa'))[1].state,'unknown');
  assert.equal((await json('/api/jobs/bbbb'))[1].state,'completed');
  assert.equal((await json('/api/jobs/'+job.id))[1].state,'completed');
  assert.equal((await submit())[0].status,409);assert.equal(postCount,3);
});

test('recipe contract is strict v1, including point fields and half-up boundaries',()=>{
  for(const r of [{...recipe,version:2},{...recipe,version:true},{...recipe,extra:1},{...recipe,start:{...recipe.start,z:1}},{...recipe,version:undefined}])assert.throws(()=>validateRecipe(r));
  assert.equal(Math.round(validateRecipe({...recipe,duration:.5,fps:1}).duration),1);
});
test('upload dimensions reject header-only, huge and animated inputs before decoding',()=>{
  assert.throws(()=>validateImageSize(Buffer.alloc(8),'image/png'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
  assert.deepEqual(validateImageSize(png,'image/png'),{width:1,height:1});
  const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);assert.throws(()=>validateImageSize(huge,'image/png'));
  const webp=Buffer.alloc(30);webp.writeUInt32LE(22,4);webp.write('VP8X',12);webp[20]=2;assert.throws(()=>validateImageSize(webp,'image/webp'));
  webp[20]=0;assert.deepEqual(validateImageSize(webp,'image/webp'),{width:1,height:1});
  const jpeg=Buffer.from([255,216,255,192,0,8,8,0,2,0,3,0]);assert.deepEqual(validateImageSize(jpeg,'image/jpeg'),{width:3,height:2});
});
