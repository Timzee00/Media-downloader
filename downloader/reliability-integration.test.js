'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const reliability = require('./reliability-core');

function handlerSource() {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf('async function processJob(id) {');
  const end = source.indexOf('\n// ---------- Job/history ----------', start);
  assert.ok(start >= 0 && end > start, 'Generated server includes the final job handler');
  return '(' + source.slice(start, end).trim() + ')';
}
async function exercise({type='audio',output='valid',mediaHost='audiomack.com'}={}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timzee-controller-'));
  const id = 'e2e-simulated-job';
  const job = {id, type, url:`https://${mediaHost}/artist/song/test`, quality:'best', status:'processing', stage:'validate', progress:5};
  const stages=[];
  let resolverInvocations=0;
  const context = {
    URL,path, DOWNLOAD_DIR:dir, MAX_DOWNLOAD_BYTES:5000000, reliability,
    QUALITY_FORMATS:{best:'bestvideo+bestaudio/best'},
    getJob:()=>job,
    upsertJob:async j=>{Object.assign(job,j);},
    updateJobStage:async(jid,stage,percent,message)=>{assert.equal(jid,id);stages.push(stage);Object.assign(job,{stage,progress:percent,stageMessage:message});},
    isTikTokHost:hostname=>hostname==='tiktok.com',
    tryResolveTikTokPhoto:async()=>{resolverInvocations++;throw new Error('Unrelated photo resolver executed');},
    downloadJobQueue:{add:async(fn)=>fn()},
    safeHost:url=>new URL(url).hostname,
    providerRouter:{classifyPlatform:()=>mediaHost==='audiomack.com'?'generic':'mock'},
    diagLog:()=>{},
    compactDetail:text=>String(text).slice(0,300),
    runYtDlp:async args=>{
      if(args.includes('-j'))return {stdout:JSON.stringify({title:'Demo downloadable media',extractor:'audiomack',uploader:'Demo'})};
      const template=args[args.indexOf('-o')+1];
      assert.ok(template.includes('%(ext)s'));
      if(output==='missing')return {stdout:''};
      const ext=type==='audio'?'wav':'mp4';
      const file=template.replace('%(ext)s',ext);
      if(output==='corrupt')fs.writeFileSync(file,'not playable media');
      else if(type==='audio')await reliability.runMediaTool('ffmpeg',['-f','lavfi','-i','sine=frequency=440:duration=1','-y',file]);
      else await reliability.runMediaTool('ffmpeg',['-f','lavfi','-i','color=size=120x80:rate=10:duration=1','-c:v','mpeg4','-y',file]);
      return {stdout:file+'\n'};
    }
  };
  try {
    const processJob=vm.runInNewContext(handlerSource(), context, {timeout:3000});
    let error=null;
    try {await processJob(id);}catch(e){error=e;}
    return {status:job.status,stage:job.stage,progress:job.progress,stages,filename:job.filePath,fileSize:job.fileSize,error:error?.message || null,errorCode:error?.code || null,resolverInvocations,verified:job.filePath?await reliability.probeMedia(path.join(dir,job.filePath)):null};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test('end-to-end simulated Audiomack song -> verified MP3 job with actual file',async()=>{
 const r=await exercise({type:'audio'});
 assert.equal(r.error,null);assert.equal(r.status,'done');assert.equal(r.filename,'e2e-simulated-job.mp3');
 assert.ok(r.fileSize>1000);assert.equal(r.verified.audio,true);
 assert.equal(r.resolverInvocations,0);
 assert.deepEqual(r.stages,['validate','read_info','download','process','finalize']);
});
test('end-to-end video job -> verified playable video',async()=>{
 const r=await exercise({type:'video'});assert.equal(r.error,null);assert.equal(r.status,'done');
 assert.equal(r.verified.video,true);assert.equal(r.filename,'e2e-simulated-job.mp4');
});
test('completed subprocess without a file never marks the job as done',async()=>{
 const r=await exercise({output:'missing'});assert.equal(r.errorCode,'NO_MEDIA_OUTPUT');assert.equal(r.status,'processing');assert.ok(!r.filename);
});
test('corrupted output cannot reach 100%',async()=>{
 const r=await exercise({output:'corrupt'});assert.ok(r.error);assert.notEqual(r.progress,100);assert.notEqual(r.status,'done');
});
