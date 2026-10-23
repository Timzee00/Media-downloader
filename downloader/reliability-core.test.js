'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {progressArgs,parseProgress,fallbackOutputName,selectCandidate,runMediaTool,probeMedia,finalizeMedia}=require('./reliability-core');
const fresh=()=>fs.mkdtempSync(path.join(os.tmpdir(),'timzee-test-'));
const tempJob=async(fn)=>{const dir=fresh();try{await fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}};
test('yt-dlp progress is parsed without invented speed and ETA',()=>{
 assert.equal(progressArgs().includes('--newline'),true);
 const x=parseProgress('TIMZEE_PROGRESS|1024|2048|NA|512|3');
 assert.equal(x.percent,50);assert.equal(x.speedBytesPerSec,512);
 assert.equal(parseProgress('nothing'),null);
 assert.equal(parseProgress('TIMZEE_PROGRESS|500|NA|NA|NA|NA').percent,null);
});
test('You-Get fallback basename never inherits %(ext)s',()=>{
 assert.equal(fallbackOutputName('/data/downloads/a1234567.%(ext)s'),'a1234567-fallback');
 assert.throws(()=>fallbackOutputName('/tmp/not-valid.%(title)s'));
});
test('candidate selection ignores partial, foreign and zero-byte files',async()=>tempJob(async dir=>{
 fs.writeFileSync(path.join(dir,'abc12345.mp3.part'),'partial');
 fs.writeFileSync(path.join(dir,'abc123456.mp3'),'foreign');
 fs.writeFileSync(path.join(dir,'abc12345.mp3'),'');
 fs.writeFileSync(path.join(dir,'abc12345-fallback'),'raw');
 assert.equal(selectCandidate(dir,'abc12345','audio').selected.name,'abc12345-fallback');
}));
test('missing file produces diagnostic code',async()=>tempJob(async dir=>{
 await assert.rejects(finalizeMedia({dir,id:'abc12345',type:'audio'}),e=>e.code==='NO_MEDIA_OUTPUT');
}));
test('simulated yt-dlp completed WAV becomes verified MP3',async()=>tempJob(async dir=>{
 const id='abc12345';
 await runMediaTool('ffmpeg',['-f','lavfi','-i','sine=frequency=440:duration=2','-y',path.join(dir,id+'.wav')]);
 const r=await finalizeMedia({dir,id,type:'audio'});
 assert.equal(r.filePath,id+'.mp3');assert.ok(r.fileSize>1000);
 assert.equal((await probeMedia(path.join(dir,r.filePath))).audio,true);
 assert.equal(fs.existsSync(path.join(dir,id+'.wav')),false);
}));
test('You-Get extensionless audio fallback converts to MP3',async()=>tempJob(async dir=>{
 const id='abc12345';
 await runMediaTool('ffmpeg',['-f','lavfi','-i','sine=frequency=330:duration=1','-y',path.join(dir,id+'-fallback.m4a')]);
 fs.renameSync(path.join(dir,id+'-fallback.m4a'),path.join(dir,id+'-fallback'));
 const r=await finalizeMedia({dir,id,type:'audio'});
 assert.equal(r.filePath,id+'.mp3');
 assert.equal((await probeMedia(path.join(dir,r.filePath))).audio,true);
}));
test('falsely named audio is rejected, not reported as success',async()=>tempJob(async dir=>{
 fs.writeFileSync(path.join(dir,'abc12345.mp3'),'not audio');
 await assert.rejects(finalizeMedia({dir,id:'abc12345',type:'audio'}));
}));
test('simulated video output is probed and validated',async()=>tempJob(async dir=>{
 const id='abc12345';
 await runMediaTool('ffmpeg',['-f','lavfi','-i','color=size=120x80:rate=10:duration=1','-c:v','mpeg4','-y',path.join(dir,id+'.mp4')]);
 const r=await finalizeMedia({dir,id,type:'video'});
 assert.equal(r.filePath,id+'.mp4');
 assert.equal((await probeMedia(path.join(dir,r.filePath))).video,true);
}));
test('video cannot be mislabeled as audio-only',async()=>tempJob(async dir=>{
 const id='abc12345';
 await runMediaTool('ffmpeg',['-f','lavfi','-i','color=size=120x80:rate=10:duration=1','-c:v','mpeg4','-y',path.join(dir,id+'.mp4')]);
 await assert.rejects(finalizeMedia({dir,id,type:'audio'}),/no playable audio file/);
}));
test('output cap is enforced',async()=>tempJob(async dir=>{
 const id='abc12345';fs.writeFileSync(path.join(dir,id+'.mp3'),Buffer.alloc(1024));
 await assert.rejects(finalizeMedia({dir,id,type:'audio',maxBytes:1}),/size limit/);
}));

test('a file mislabeled MP3 with another audio codec is converted into actual MP3',async()=>tempJob(async dir=>{
 const id='abc12345';const src=path.join(dir,id+'.flac');
 await runMediaTool('ffmpeg',['-f','lavfi','-i','sine=frequency=300:duration=1','-c:a','flac','-y',src]);
 fs.renameSync(src,path.join(dir,id+'.mp3'));
 const before=await probeMedia(path.join(dir,id+'.mp3'));
 assert.equal(before.audioCodec,'flac');
 const result=await finalizeMedia({dir,id,type:'audio'});
 assert.equal(result.filePath,id+'.mp3');
 assert.equal((await probeMedia(path.join(dir,result.filePath))).audioCodec,'mp3');
}));

test('provider audio validation distinguishes a silent video from actual audio', async()=>tempJob(async dir=>{
 const id='abc12345';
 await runMediaTool('ffmpeg',['-f','lavfi','-i','color=size=120x80:rate=10:duration=1','-c:v','mpeg4','-y',path.join(dir,id+'-fallback.mp4')]);
 await assert.rejects(finalizeMedia({dir,id,type:'audio'}), err => err.code === 'INVALID_PROVIDER_MEDIA' && /provider returned no playable audio/i.test(err.message));
}));
