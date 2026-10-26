'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const recovery=require('./url-recovery'),router=require('./provider-router');
const redirected=(location,status=302)=>({status,headers:{get:()=>location},body:{cancel:async()=>{}}});
test('TikTok media paths differ from homepage redirects',()=>{
  assert.equal(recovery.isTikTokMediaUrl('https://www.tiktok.com/@user/video/123456'),true);
  assert.equal(recovery.isTikTokMediaUrl('https://www.tiktok.com/@user/photo/123456'),true);
  assert.equal(recovery.isTikTokMediaUrl('https://www.tiktok.com/?_r=1'),false);
  assert.equal(recovery.isTikTokHomeUrl('https://www.tiktok.com/?_r=1'),true);
});
test('TikTok short redirect resolves canonical media path',async()=>{
  const actual=await recovery.resolveTikTokShareUrl('https://vt.tiktok.com/ZLink/',{
    validateUrl:async()=>true,request:async()=>redirected('https://www.tiktok.com/@user/video/123456')
  });
  assert.equal(actual.status,'resolved');
  assert.equal(actual.url,'https://www.tiktok.com/@user/video/123456');
});
test('Homepage redirect is not treated as downloaded media',async()=>{
  const actual=await recovery.resolveTikTokShareUrl('https://vt.tiktok.com/ZLink/',{
    validateUrl:async()=>true,request:async()=>redirected('https://www.tiktok.com/?_r=1')
  });
  assert.equal(actual.status,'homepage');
  assert.equal(actual.url,'https://vt.tiktok.com/ZLink/');
});
test('Redirect chains cannot escape TikTok to private services',async()=>{
  let calls=0;
  const actual=await recovery.resolveTikTokShareUrl('https://vt.tiktok.com/ZLink/',{
    validateUrl:async()=>true,request:async()=>{calls++;return redirected('http://127.0.0.1/admin');}
  });
  assert.equal(actual.status,'unresolved');assert.equal(calls,2);
});
test('Each redirect hop runs URL safety validation',async()=>{
  let calls=0;
  await recovery.resolveTikTokShareUrl('https://vt.tiktok.com/ZLink/',{
    validateUrl:async u=>!u.includes('/unsafe/'),request:async()=>{calls++;return redirected('https://www.tiktok.com/unsafe/');}
  });
  assert.equal(calls,2);
});
test('Already canonical and unrelated links are unchanged',async()=>{
  const link='https://www.tiktok.com/@user/video/123456';
  assert.deepEqual(await recovery.resolveTikTokShareUrl(link),{url:link,status:'unchanged'});
  const other='https://www.youtube.com/watch?v=abc';
  assert.deepEqual(await recovery.resolveTikTokShareUrl(other),{url:other,status:'unchanged'});
});
test('Platform routing covers short links, Pinterest, Spotify without host spoofing',()=>{
  assert.equal(router.classifyPlatform('https://vt.tiktok.com/ZLink'),'tiktok');
  assert.equal(router.classifyPlatform('https://pin.it/abc123'),'pinterest');
  assert.equal(router.classifyPlatform('https://www.pinterest.com/pin/123'),'pinterest');
  assert.equal(router.classifyPlatform('https://open.spotify.com/track/123'),'spotify');
  assert.equal(router.classifyPlatform('https://pinterest.com.evil.test/pin/123'),'generic');
});
test('TikTok gets one browser-impersonation retry before fallback',async()=>{
  const calls=[];
  const result=await router.runProviderPlan({url:'https://vt.tiktok.com/ZLink',args:['-j','https://vt.tiktok.com/ZLink'],operation:'metadata',
    runEngine:async (_engine,args)=>{calls.push(args);if(calls.length===1)throw Error('default failed');return {stdout:'ok'};}
  });
  assert.equal(result.stdout,'ok');
  assert.deepEqual(calls[1].slice(0,2),['--impersonate','chrome']);
});
test('Other platforms do not receive impersonation retry',async()=>{
  let calls=0;
  await assert.rejects(router.runProviderPlan({url:'https://www.pinterest.com/pin/1',
    args:['https://www.pinterest.com/pin/1'],operation:'metadata',runEngine:async()=>{calls++;throw Error('unavailable');}
  }),/unavailable/);
  assert.equal(calls,1);
});
