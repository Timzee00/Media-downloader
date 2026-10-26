'use strict';
// Resolve official TikTok short-link redirects; do not invent media IDs or follow unrelated hosts.
const SHORT_HOSTS=new Set(['vt.tiktok.com','vm.tiktok.com']);
function isTikTokHost(host){const s=String(host||'').toLowerCase();return s==='tiktok.com'||s.endsWith('.tiktok.com');}
function isTikTokMediaUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&isTikTokHost(u.hostname)&&/\/(?:@[^/]+\/)?(?:video|photo)\/\d+(?:\/|$)/.test(u.pathname);}catch{return false;}
}
function isTikTokHomeUrl(value){try{const u=new URL(value);return isTikTokHost(u.hostname)&&(u.pathname==='/'||u.pathname==='');}catch{return false;}}
async function resolveTikTokShareUrl(value,{request=fetch,validateUrl=async()=>true,timeoutMs=7000}={}){
  let input;try{input=new URL(value);}catch{return {url:value,status:'unchanged'};}
  if(!SHORT_HOSTS.has(input.hostname.toLowerCase()))return {url:value,status:'unchanged'};
  const agents=[
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'facebookexternalhit/1.1'
  ];
  const timeout=Math.max(1000,Math.min(15000,Number(timeoutMs)||7000));
  let homepage=false;
  for(const agent of agents){
    let current=value;
    for(let hop=0;hop<5;hop++){
      let target;try{target=new URL(current);}catch{break;}
      if(target.protocol!=='https:'||!isTikTokHost(target.hostname))break;
      if(!(await validateUrl(current)))break;
      let response;
      try{response=await request(current,{method:'GET',redirect:'manual',headers:{'User-Agent':agent,Accept:'text/html,*/*;q=0.8'},signal:AbortSignal.timeout(timeout)});}
      catch{break;}
      const location=response.headers?.get?.('location');
      if(response.body?.cancel)try{await response.body.cancel();}catch{}
      if(![301,302,303,307,308].includes(response.status)||!location)break;
      let redirected;try{redirected=new URL(location,current);}catch{break;}
      if(redirected.protocol!=='https:'||!isTikTokHost(redirected.hostname))break;
      if(isTikTokMediaUrl(redirected.href))return {url:redirected.href,status:'resolved'};
      if(isTikTokHomeUrl(redirected.href)){homepage=true;break;}
      current=redirected.href;
    }
  }
  return {url:value,status:homepage?'homepage':'unresolved'};
}
module.exports={isTikTokHost,isTikTokMediaUrl,isTikTokHomeUrl,resolveTikTokShareUrl};
