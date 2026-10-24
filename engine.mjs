// Camera-conditioned diffusion, based on the official Comfy Wan camera example.
// This graph deliberately contains no TakeLabCameraRender/crop-animation output.
export const MODEL={id:'wan21-camera-1.3b',name:'Wan 2.1 Fun Camera v1.1 · 1.3B',license:'Apache-2.0',
  source:'https://huggingface.co/alibaba-pai/Wan2.1-Fun-V1.1-1.3B-Control-Camera',
  files:{UNETLoader:['unet_name','wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors'],CLIPLoader:['clip_name','umt5_xxl_fp8_e4m3fn_scaled.safetensors'],VAELoader:['vae_name','wan_2.1_vae.safetensors'],CLIPVisionLoader:['clip_name','clip_vision_h.safetensors']}};
export const MOVES={
  still:{label:'고정 촬영',pose:'Static',hint:'카메라는 고정하고 장면 속 동작을 생성합니다.'},
  push:{label:'다가가기',pose:'Zoom In',hint:'카메라가 장면 안으로 전진하도록 조건을 줍니다.'},
  reveal:{label:'물러나며 드러내기',pose:'Zoom Out',hint:'카메라가 뒤로 이동하며 주변을 생성합니다.'},
  left:{label:'왼쪽으로 이동',pose:'Pan Left',hint:'카메라를 왼쪽으로 이동시켜 시점 변화를 유도합니다.'},
  right:{label:'오른쪽으로 이동',pose:'Pan Right',hint:'카메라를 오른쪽으로 이동시켜 시점 변화를 유도합니다.'},
  up:{label:'위로 이동',pose:'Pan Up',hint:'높이를 올리는 카메라 조건입니다.'},
  down:{label:'아래로 이동',pose:'Pan Down',hint:'높이를 낮추는 카메라 조건입니다.'}
};
export function validateSettings(s){
  if(!s||typeof s!=='object'||Array.isArray(s))throw Error('생성 설정이 필요합니다.');
  const number=(v,min,max,integer=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v)))throw Error('생성 설정 범위를 확인하세요.');return v;};
  const r={version:2,prompt:typeof s.prompt==='string'?s.prompt.trim():'',width:number(s.width,256,640,true),height:number(s.height,256,640,true),frames:number(s.frames,17,81,true),fps:16,steps:number(s.steps,12,30,true),seed:number(s.seed,0,4294967295,true),speed:number(s.speed,.1,1.5)};
  if(s.version!==2||r.prompt.length<5||r.prompt.length>1200||r.width%16||r.height%16||r.width*r.height>512*512||(r.frames-1)%4||s.fps!==16)throw Error('장면 설명과 영상 규격을 확인하세요.');
  return r;
}
export function buildWorkflow({image,move,settings,prefix='motion-takes/take',dynamicVideo=true}){
  const s=validateSettings(settings);
  if(typeof image!=='string'||!/^takelab-[a-f0-9-]+\.(png|jpg|webp)$/.test(image))throw Error('업로드된 입력 이미지가 필요합니다.');
  if(!Object.hasOwn(MOVES,move))throw Error('지원하는 카메라 움직임을 고르세요.');
  if(typeof prefix!=='string'||!/^motion-takes\/[a-z0-9-]+$/.test(prefix))throw Error('출력 이름이 잘못되었습니다.');
  const n=(class_type,inputs)=>({class_type,inputs});
  const graph={
    '1':n('LoadImage',{image}),
    '2':n('UNETLoader',{unet_name:MODEL.files.UNETLoader[1],weight_dtype:'default'}),
    '3':n('ModelSamplingSD3',{model:['2',0],shift:8}),
    '4':n('CLIPLoader',{clip_name:MODEL.files.CLIPLoader[1],type:'wan',device:'default'}),
    '5':n('CLIPTextEncode',{clip:['4',0],text:s.prompt}),
    '6':n('CLIPTextEncode',{clip:['4',0],text:'overexposed, blurry, low quality, watermark, text, subtitles, deformed objects, distorted architecture, flicker, abrupt cuts'}),
    '7':n('VAELoader',{vae_name:MODEL.files.VAELoader[1]}),
    '8':n('CLIPVisionLoader',{clip_name:MODEL.files.CLIPVisionLoader[1]}),
    '9':n('CLIPVisionEncode',{clip_vision:['8',0],image:['1',0],crop:'none'}),
    '10':n('WanCameraEmbedding',{camera_pose:MOVES[move].pose,width:s.width,height:s.height,length:s.frames,speed:s.speed,fx:.5,fy:.5,cx:.5,cy:.5}),
    '11':n('WanCameraImageToVideo',{positive:['5',0],negative:['6',0],vae:['7',0],clip_vision_output:['9',0],start_image:['1',0],camera_conditions:['10',0],width:['10',1],height:['10',2],length:['10',3],batch_size:1}),
    '12':n('KSampler',{model:['3',0],positive:['11',0],negative:['11',1],latent_image:['11',2],seed:s.seed,steps:s.steps,cfg:6,sampler_name:'uni_pc',scheduler:'simple',denoise:1}),
    '13':n('VAEDecodeTiled',{samples:['12',0],vae:['7',0],tile_size:256,overlap:64,temporal_size:16,temporal_overlap:4}),
    '14':n('CreateVideo',{images:['13',0],fps:s.fps}),
    '15':n('SaveVideo',{video:['14',0],filename_prefix:prefix,format:'mp4',...(dynamicVideo?{'format.codec':'h264'}:{codec:'h264'})})
  };
  return graph;
}
export const REQUIRED_NODES=['LoadImage','UNETLoader','ModelSamplingSD3','CLIPLoader','CLIPTextEncode','VAELoader','CLIPVisionLoader','CLIPVisionEncode','WanCameraEmbedding','WanCameraImageToVideo','KSampler','VAEDecodeTiled','CreateVideo','SaveVideo'];
