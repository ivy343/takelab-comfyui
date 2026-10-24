import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkflow,validateSettings,MOVES} from '../engine.mjs';
const settings={version:2,prompt:'A quiet room with warm daylight.',width:384,height:256,frames:33,fps:16,steps:20,seed:42,speed:.7};
const image='takelab-550e8400-e29b-41d4-a716-446655440000.webp';
test('every motion conditions real diffusion and keeps all other settings identical',()=>{
  let reference;
  for(const move of Object.keys(MOVES)){
    const g=buildWorkflow({image,move,settings});
    assert.equal(g['10'].inputs.camera_pose,MOVES[move].pose);
    assert.deepEqual(g['11'].inputs.camera_conditions,['10',0]);
    assert.deepEqual(g['12'].inputs.positive,['11',0]);
    assert.equal(g['12'].class_type,'KSampler');
    assert.equal(g['15'].class_type,'SaveVideo');
    assert.equal(g['15'].inputs['format.codec'],'h264');
    assert.ok(!Object.values(g).some(x=>x.class_type==='TakeLabCameraRender'));
    const normalized=structuredClone(g);normalized['10'].inputs.camera_pose='SAME';
    if(reference)assert.deepEqual(normalized,reference);else reference=normalized;
  }
});
test('reject impossible temporal dimensions, excessive allocations and unsafe filenames',()=>{
  for(const bad of [{frames:32},{frames:85},{fps:24},{width:640,height:640},{width:383},{seed:-1},{speed:NaN},{version:1},{steps:2},{prompt:''}])assert.throws(()=>validateSettings({...settings,...bad}));
  for(const name of ['../image.png','C:input.png','input.png','takelab-aa.png/../../x'])assert.throws(()=>buildWorkflow({image:name,move:'push',settings}));
  assert.throws(()=>buildWorkflow({image,move:'orbit',settings}));
  assert.throws(()=>buildWorkflow({image,move:'push',settings,prefix:'../../outside'}));
});
test('fixed settings are deterministic and never mutated',()=>{
  const before=JSON.stringify(settings),a=buildWorkflow({image,move:'push',settings}),b=buildWorkflow({image,move:'push',settings});
  assert.deepEqual(a,b);assert.equal(JSON.stringify(settings),before);
  assert.equal(a['10'].inputs.length,settings.frames);assert.deepEqual(a['11'].inputs.length,['10',3]);
  assert.equal(a['14'].inputs.fps,16);
});
