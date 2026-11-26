const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const router = express.Router();
let pool;
let jwks;
function database() {
  if (!process.env.NEON_DATABASE_URL) throw new Error('Link Tree database is not configured.');
  if (!pool) pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 });
  return pool;
}
function keys() {
  if (!process.env.NEON_AUTH_JWKS_URL) throw new Error('Link Tree authentication is not configured.');
  if (!jwks) jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL));
  return jwks;
}
async function requireUser(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign in to manage your Link Tree.' });
    const { payload } = await jwtVerify(token, keys());
    if (!payload.sub) return res.status(401).json({ error: 'Invalid account session.' });
    req.userId = String(payload.sub);
    req.userEmail = typeof payload.email === 'string' ? payload.email.slice(0,254) : '';
    req.userName = typeof payload.name === 'string' ? payload.name.slice(0,80) : '';
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}
function cleanUsername(value) { return String(value || '').trim().replace(/^@/, '').toLowerCase(); }
function validUrl(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol); } catch { return false; } }

router.get('/public/:username', async (req, res) => {
  try {
    const username = cleanUsername(req.params.username);
    const result = await database().query(
      `SELECT p.username,p.display_name,p.bio,CASE WHEN p.avatar_data IS NOT NULL THEN '/api/linktree/avatar/'||p.username||'?v='||extract(epoch FROM p.updated_at)::bigint ELSE p.avatar_url END AS avatar_url,CASE WHEN p.cover_data IS NOT NULL THEN '/api/linktree/cover/'||p.username||'?v='||extract(epoch FROM p.updated_at)::bigint ELSE p.cover_url END AS cover_url,p.theme,p.appearance,
        COALESCE(json_agg(json_build_object('id',l.id,'title',l.title,'url',l.url,'icon',l.icon,'sort_order',l.sort_order,'category',l.category,'description',l.description,'is_pinned',l.is_pinned,'section_id',l.section_id) ORDER BY l.sort_order,l.id)
        FILTER (WHERE l.id IS NOT NULL AND l.is_active), '[]'::json) AS links
       FROM linktree_profiles p LEFT JOIN linktree_links l ON l.profile_id=p.id
       WHERE p.username=$1 AND p.is_published=TRUE
       GROUP BY p.id LIMIT 1`, [username]);
    if (!result.rowCount) return res.status(404).json({ error: 'This Link Tree does not exist.' });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(result.rows[0]);
  } catch (error) { console.error('Link Tree public profile:', error.message); res.status(503).json({ error: 'Link Tree is temporarily unavailable.' }); }
});

router.get('/me', requireUser, async (req, res) => {
  try {
    const result = await database().query(
      `SELECT p.id,p.username,p.display_name,p.bio,CASE WHEN p.avatar_data IS NOT NULL THEN '/api/linktree/avatar/'||p.username||'?v='||extract(epoch FROM p.updated_at)::bigint ELSE p.avatar_url END AS avatar_url,CASE WHEN p.cover_data IS NOT NULL THEN '/api/linktree/cover/'||p.username||'?v='||extract(epoch FROM p.updated_at)::bigint ELSE p.cover_url END AS cover_url,p.theme,p.appearance,p.is_published,
       COALESCE(json_agg(json_build_object('id',l.id,'title',l.title,'url',l.url,'icon',l.icon,'sort_order',l.sort_order,'is_active',l.is_active,'category',l.category,'description',l.description,'is_pinned',l.is_pinned,'section_id',l.section_id,'schedule_start',l.schedule_start,'schedule_end',l.schedule_end) ORDER BY l.sort_order,l.id)
       FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS links
       FROM linktree_profiles p LEFT JOIN linktree_links l ON l.profile_id=p.id
       WHERE p.auth_user_id=$1 GROUP BY p.id LIMIT 1`, [req.userId]);
    const sections = result.rowCount ? await database().query('SELECT id,title,sort_order FROM linktree_sections WHERE profile_id=$1 ORDER BY sort_order,id',[result.rows[0].id]) : { rows: [] };
    const shortLinks = result.rowCount ? await database().query('SELECT id,link_id,slug,destination_url,is_active,expires_at,created_at FROM linktree_short_links WHERE profile_id=$1 ORDER BY created_at DESC LIMIT 100',[result.rows[0].id]) : { rows: [] };
    res.json({ profile: result.rows[0] ? { ...result.rows[0], sections: sections.rows, short_links: shortLinks.rows } : null });
  } catch (error) { console.error('Link Tree owner profile:', error.message); res.status(503).json({ error: 'Could not load your profile.' }); }
});


router.put('/profile/avatar', requireUser, express.raw({ type: ['image/jpeg','image/png','image/webp'], limit: '2mb' }), async (req, res) => {
  const mime = req.get('content-type') || '';
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Choose an image smaller than 2 MB.' });
  const valid = mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mime === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' : false;
  if (!valid) return res.status(415).json({ error: 'The uploaded file is not a valid JPG, PNG or WebP image.' });
  try {
    const result = await database().query(
      `UPDATE linktree_profiles SET avatar_data=$1,avatar_mime=$2,avatar_url=NULL,updated_at=NOW()
       WHERE auth_user_id=$3 RETURNING username`, [bytes,mime,req.userId]);
    if (!result.rowCount) return res.status(409).json({ error: 'Save your profile before uploading a photo.' });
    res.json({ avatar_url: '/api/linktree/avatar/' + result.rows[0].username });
  } catch (error) { console.error('Link Tree avatar upload:', error.message); res.status(503).json({ error: 'Could not save your profile photo.' }); }
});

router.get('/avatar/:username', async (req, res) => {
  try {
    const result = await database().query(
      'SELECT avatar_data,avatar_mime FROM linktree_profiles WHERE username=$1 AND is_published=TRUE AND avatar_data IS NOT NULL',
      [cleanUsername(req.params.username)]);
    if (!result.rowCount) return res.status(404).end();
    res.set({ 'Content-Type': result.rows[0].avatar_mime, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.send(result.rows[0].avatar_data);
  } catch (error) { console.error('Link Tree avatar fetch:', error.message); res.status(503).end(); }
});


router.put('/profile/cover', requireUser, express.raw({ type: ['image/jpeg','image/png','image/webp'], limit: '5mb' }), async (req, res) => {
  const mime = req.get('content-type') || '';
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Choose a cover image smaller than 5 MB.' });
  const valid = mime === 'image/jpeg' ? bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mime === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' : false;
  if (!valid) return res.status(415).json({ error: 'The uploaded file is not a valid JPG, PNG or WebP image.' });
  try {
    const result = await database().query(
      `UPDATE linktree_profiles SET cover_data=$1,cover_mime=$2,cover_url=NULL,updated_at=NOW()
       WHERE auth_user_id=$3 RETURNING username`, [bytes,mime,req.userId]);
    if (!result.rowCount) return res.status(409).json({ error: 'Save your profile before uploading a cover photo.' });
    res.json({ cover_url: '/api/linktree/cover/' + result.rows[0].username });
  } catch (error) { console.error('Link Tree cover upload:', error.message); res.status(503).json({ error: 'Could not save your cover photo.' }); }
});

router.get('/cover/:username', async (req, res) => {
  try {
    const result = await database().query(
      'SELECT cover_data,cover_mime FROM linktree_profiles WHERE username=$1 AND is_published=TRUE AND cover_data IS NOT NULL',
      [cleanUsername(req.params.username)]);
    if (!result.rowCount) return res.status(404).end();
    res.set({ 'Content-Type': result.rows[0].cover_mime, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.send(result.rows[0].cover_data);
  } catch (error) { console.error('Link Tree cover fetch:', error.message); res.status(503).end(); }
});

router.put('/profile', requireUser, async (req, res) => {
  const username = cleanUsername(req.body?.username);
  const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
  const bio = String(req.body?.bio || '').trim().slice(0, 280);
  const avatar = String(req.body?.avatar_url || '').trim().slice(0, 1000) || null;
  const cover = String(req.body?.cover_url || '').trim().slice(0, 1000) || null;
  const theme = ['liquid-dark','liquid-light'].includes(req.body?.theme) ? req.body.theme : 'liquid-dark';
  const appearance = req.body?.appearance && typeof req.body.appearance === 'object' && !Array.isArray(req.body.appearance) ? req.body.appearance : {};
  if (appearance.fontData !== undefined && (typeof appearance.fontData !== 'string' || appearance.fontData.length > 700000 || !/^data:font\/(?:woff2?|ttf|otf);base64,[A-Za-z0-9+/=]+$/i.test(appearance.fontData))) return res.status(400).json({ error: 'Custom font data must be a supported font file no larger than 500 KB.' });
  if (appearance.qrLogo !== undefined && (typeof appearance.qrLogo !== 'string' || appearance.qrLogo.length > 250000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(appearance.qrLogo))) return res.status(400).json({ error: 'QR logo must be a PNG, JPG or WebP image no larger than 180 KB.' });
  if (!/^[a-z0-9_][a-z0-9_.]{1,29}$/.test(username)) return res.status(400).json({ error: 'Username must be 2–30 characters and use letters, numbers, dots or underscores.' });
  if (!displayName) return res.status(400).json({ error: 'Display name is required.' });
  if (avatar && !validUrl(avatar)) return res.status(400).json({ error: 'Profile picture must be a valid http(s) URL.' });
  if (cover && !validUrl(cover)) return res.status(400).json({ error: 'Cover image must be a valid http(s) URL.' });
  try {
    const result = await database().query(
      `INSERT INTO linktree_profiles(auth_user_id,username,display_name,bio,avatar_url,cover_url,theme,appearance)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(auth_user_id) DO UPDATE SET username=EXCLUDED.username,display_name=EXCLUDED.display_name,bio=EXCLUDED.bio,
       avatar_url=COALESCE(EXCLUDED.avatar_url,linktree_profiles.avatar_url),cover_url=COALESCE(EXCLUDED.cover_url,linktree_profiles.cover_url),theme=EXCLUDED.theme,appearance=EXCLUDED.appearance,updated_at=NOW()
       RETURNING id,username,display_name,bio,
        CASE WHEN avatar_data IS NOT NULL THEN '/api/linktree/avatar/'||username||'?v='||extract(epoch FROM updated_at)::bigint ELSE avatar_url END AS avatar_url,
        CASE WHEN cover_data IS NOT NULL THEN '/api/linktree/cover/'||username||'?v='||extract(epoch FROM updated_at)::bigint ELSE cover_url END AS cover_url,
        theme,appearance,is_published`,
      [req.userId,username,displayName,bio,avatar,cover,theme,JSON.stringify(appearance)]);
    res.json({ profile: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    console.error('Link Tree profile save:', error.message); res.status(503).json({ error: 'Could not save your profile.' });
  }
});

router.post('/links', requireUser, async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0,80);
  const url = String(req.body?.url || '').trim();
  const icon = String(req.body?.icon || 'link').trim().slice(0,40);
  const category = ['social','website','video','music','contact','business','general'].includes(req.body?.category) ? req.body.category : 'general';
  const description = String(req.body?.description || '').trim().slice(0,180);
  if (!title || !validUrl(url)) return res.status(400).json({ error: 'Enter a title and a valid http(s) URL.' });
  try {
    const profile = await database().query('SELECT id FROM linktree_profiles WHERE auth_user_id=$1',[req.userId]);
    if (!profile.rowCount) return res.status(409).json({ error: 'Create your profile before adding links.' });
    const result = await database().query(
      `INSERT INTO linktree_links(profile_id,title,url,icon,sort_order,category,description,is_pinned)
       VALUES($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM linktree_links WHERE profile_id=$1),$5,$6,COALESCE($7,FALSE))
       RETURNING id,title,url,icon,sort_order,is_active,category,description,is_pinned,section_id`,[profile.rows[0].id,title,url,icon,category,description,req.body?.is_pinned===true]);
    res.status(201).json({ link: result.rows[0] });
  } catch (error) { console.error('Link Tree add link:', error.message); res.status(503).json({ error: 'Could not add this link.' }); }
});

router.patch('/links/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body?.title || '').trim().slice(0,80);
  const url = String(req.body?.url || '').trim();
  const isActive = req.body?.is_active !== false;
  const icon = String(req.body?.icon || 'link').trim().slice(0,40);
  const category = ['social','website','video','music','contact','business','general'].includes(req.body?.category) ? req.body.category : 'general';
  const description = String(req.body?.description || '').trim().slice(0,180);
  const isPinned = req.body?.is_pinned === true;
  const sectionId = req.body?.section_id ? Number(req.body.section_id) : null;
  if (!Number.isSafeInteger(id) || id < 1 || !title || !validUrl(url)) return res.status(400).json({ error: 'Invalid link details.' });
  try {
    const result = await database().query(
      `UPDATE linktree_links l SET title=$1,url=$2,icon=$3,is_active=$4,category=$5,description=$6,is_pinned=$7,section_id=$8,updated_at=NOW()
       FROM linktree_profiles p WHERE l.profile_id=p.id AND p.auth_user_id=$9 AND l.id=$10
       AND ($8::bigint IS NULL OR EXISTS(SELECT 1 FROM linktree_sections s WHERE s.id=$8 AND s.profile_id=p.id))
       RETURNING l.id,l.title,l.url,l.icon,l.sort_order,l.is_active,l.category,l.description,l.is_pinned,l.section_id`,[title,url,icon,isActive,category,description,isPinned,Number.isSafeInteger(sectionId)?sectionId:null,req.userId,id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Link not found.' });
    res.json({ link: result.rows[0] });
  } catch (error) { console.error('Link Tree update link:', error.message); res.status(503).json({ error: 'Could not update this link.' }); }
});

router.delete('/links/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid link.' });
  try {
    const result = await database().query(
      `DELETE FROM linktree_links l USING linktree_profiles p
       WHERE l.profile_id=p.id AND p.auth_user_id=$1 AND l.id=$2 RETURNING l.id`,[req.userId,id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Link not found.' });
    res.json({ ok: true });
  } catch (error) { console.error('Link Tree delete link:', error.message); res.status(503).json({ error: 'Could not delete this link.' }); }
});


router.post('/sections', requireUser, async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0,60);
  if (!title) return res.status(400).json({ error: 'Give this section a name.' });
  try {
    const result = await database().query(
      `INSERT INTO linktree_sections(profile_id,title,sort_order)
       SELECT id,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM linktree_sections WHERE profile_id=linktree_profiles.id)
       FROM linktree_profiles WHERE auth_user_id=$1 RETURNING id,title,sort_order`, [req.userId,title]);
    if (!result.rowCount) return res.status(409).json({ error: 'Create your profile first.' });
    res.status(201).json({ section: result.rows[0] });
  } catch (error) { console.error('Link Tree section:',error.message); res.status(503).json({ error: 'Could not create this section.' }); }
});

router.patch('/sections/:id', requireUser, async (req,res) => {
  const id=Number(req.params.id), title=String(req.body?.title||'').trim().slice(0,60);
  if (!Number.isSafeInteger(id)||id<1||!title) return res.status(400).json({error:'Enter a valid section name.'});
  try {
    const result=await database().query(`UPDATE linktree_sections s SET title=$1,updated_at=NOW()
      FROM linktree_profiles p WHERE s.profile_id=p.id AND p.auth_user_id=$2 AND s.id=$3 RETURNING s.id,s.title,s.sort_order`,[title,req.userId,id]);
    if(!result.rowCount)return res.status(404).json({error:'Section not found.'});
    res.json({section:result.rows[0]});
  } catch(error){res.status(503).json({error:'Could not update this section.'});}
});

router.delete('/sections/:id', requireUser, async (req,res) => {
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Invalid section.'});
  try {
    const result=await database().query(`DELETE FROM linktree_sections s USING linktree_profiles p
      WHERE s.profile_id=p.id AND p.auth_user_id=$1 AND s.id=$2 RETURNING s.id`,[req.userId,id]);
    if(!result.rowCount)return res.status(404).json({error:'Section not found.'});
    res.json({ok:true});
  } catch(error){res.status(503).json({error:'Could not delete this section.'});}
});

router.put('/links/reorder', requireUser, async (req,res) => {
  const ids=req.body?.ids;
  if(!Array.isArray(ids)||ids.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<1)||new Set(ids.map(Number)).size!==ids.length)
    return res.status(400).json({error:'Send a valid ordered list of link IDs.'});
  const client=await database().connect();
  try{
    await client.query('BEGIN');
    const owned=await client.query('SELECT id FROM linktree_links WHERE profile_id=(SELECT id FROM linktree_profiles WHERE auth_user_id=$1) ORDER BY id',[req.userId]);
    const expected=owned.rows.map(row=>Number(row.id)).sort((a,b)=>a-b), supplied=ids.map(Number).sort((a,b)=>a-b);
    if(expected.length!==supplied.length||expected.some((id,index)=>id!==supplied[index])){await client.query('ROLLBACK');return res.status(400).json({error:'Refresh your links and try again.'});}
    await client.query(`UPDATE linktree_links l SET sort_order=x.position,updated_at=NOW()
      FROM unnest($1::bigint[]) WITH ORDINALITY AS x(id,position) WHERE l.id=x.id`,[ids.map(Number)]);
    await client.query('COMMIT');res.json({ok:true});
  }catch(error){await client.query('ROLLBACK');res.status(503).json({error:'Could not reorder links.'});}
  finally{client.release();}
});

router.post('/short-links', requireUser, async (req,res) => {
  const destination=String(req.body?.destination_url||'').trim(), linkId=req.body?.link_id?Number(req.body.link_id):null;
  if(!validUrl(destination))return res.status(400).json({error:'Enter a valid http(s) destination.'});
  const slug=crypto.randomBytes(5).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8);
  try{
    const result=await database().query(`INSERT INTO linktree_short_links(profile_id,link_id,slug,destination_url)
      SELECT p.id,$2,$3,$4 FROM linktree_profiles p WHERE p.auth_user_id=$1
      AND ($2::bigint IS NULL OR EXISTS(SELECT 1 FROM linktree_links l WHERE l.id=$2 AND l.profile_id=p.id))
      RETURNING id,link_id,slug,destination_url,is_active,expires_at,created_at`,[req.userId,linkId,slug,destination]);
    if(!result.rowCount)return res.status(409).json({error:'Create your profile and select one of your own links.'});
    res.status(201).json({short_link:{...result.rows[0],url:req.protocol+'://'+req.get('host')+'/api/linktree/r/'+slug}});
  }catch(error){console.error('Short link create:',error.message);res.status(503).json({error:'Could not create the short link.'});}
});

router.get('/r/:slug', async (req,res) => {
  try{
    const result=await database().query(`SELECT id,profile_id,link_id,destination_url FROM linktree_short_links
      WHERE slug=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1`,[String(req.params.slug).slice(0,32)]);
    if(!result.rowCount)return res.status(404).send('This short link is unavailable.');
    const row=result.rows[0];
    await database().query(`INSERT INTO linktree_analytics_events(profile_id,link_id,event_type,visitor_hash,referrer_host,device_type)
      VALUES($1,$2,'link_click',$3,$4,$5)`,[row.profile_id,row.link_id,visitorHash(req),referrerHost(req),deviceType(req)]);
    res.redirect(302,row.destination_url);
  }catch(error){res.status(503).send('Short link is temporarily unavailable.');}
});

function visitorHash(req){const ip=String(req.ip||'').replace(/\d+$/,'0');return crypto.createHash('sha256').update(ip+'|'+String(req.get('user-agent')||'').slice(0,180)+'|'+String(process.env.ANALYTICS_SALT||'clipora')).digest('hex');}
function referrerHost(req){try{return req.get('referer')?new URL(req.get('referer')).hostname.slice(0,255):null;}catch{return null;}}
function deviceType(req){const ua=String(req.get('user-agent')||'').toLowerCase();return /tablet|ipad/.test(ua)?'tablet':/mobile|android|iphone/.test(ua)?'mobile':ua?'desktop':'unknown';}

router.post('/events', async (req,res) => {
  const username=cleanUsername(req.body?.username),event=req.body?.event_type,linkId=req.body?.link_id?Number(req.body.link_id):null;
  if(!username||!['page_view','link_click'].includes(event))return res.status(400).json({error:'Invalid analytics event.'});
  try{
    const result=await database().query(`INSERT INTO linktree_analytics_events(profile_id,link_id,event_type,visitor_hash,referrer_host,device_type)
      SELECT p.id,$2,$3,$4,$5,$6 FROM linktree_profiles p
      WHERE p.username=$1 AND p.is_published=TRUE
      AND ($2::bigint IS NULL OR EXISTS(SELECT 1 FROM linktree_links l WHERE l.id=$2 AND l.profile_id=p.id AND l.is_active=TRUE))
      RETURNING id`,[username,linkId,event,visitorHash(req),referrerHost(req),deviceType(req)]);
    if(!result.rowCount)return res.status(404).json({error:'Profile or link not found.'});
    res.status(202).json({ok:true});
  }catch(error){console.error('Analytics event:',error.message);res.status(503).json({error:'Analytics is temporarily unavailable.'});}
});

router.get('/analytics', requireUser, async (req,res) => {
  const days=Math.max(1,Math.min(90,Number(req.query.days)||30));
  try{
    const result=await database().query(`SELECT event_type,COUNT(*)::int AS events,
      COUNT(DISTINCT visitor_hash)::int AS unique_visitors,
      date_trunc('day',created_at)::date AS day
      FROM linktree_analytics_events WHERE profile_id=(SELECT id FROM linktree_profiles WHERE auth_user_id=$1)
      AND created_at>=NOW()-($2::text||' days')::interval GROUP BY event_type,day ORDER BY day`,[req.userId,String(days)]);
    const top=await database().query(`SELECT l.id,l.title,COUNT(e.id)::int AS clicks FROM linktree_links l
      LEFT JOIN linktree_analytics_events e ON e.link_id=l.id AND e.event_type='link_click'
      AND e.created_at>=NOW()-($2::text||' days')::interval
      WHERE l.profile_id=(SELECT id FROM linktree_profiles WHERE auth_user_id=$1)
      GROUP BY l.id ORDER BY clicks DESC,l.sort_order LIMIT 10`,[req.userId,String(days)]);
    res.json({days,series:result.rows,top_links:top.rows});
  }catch(error){console.error('Analytics summary:',error.message);res.status(503).json({error:'Could not load analytics.'});}
});


// ---------- Clipora monetisation and owner administration ----------
const OWNER_WHATSAPP = String(process.env.CLIPORA_OWNER_WHATSAPP || '2349060512980').replace(/\D/g, '');
function requireAdmin(req, res, next) {
  const ownerId = String(process.env.CLIPORA_ADMIN_USER_ID || '').trim();
  if (!ownerId) return res.status(503).json({ error: 'Admin access is not configured yet. Set CLIPORA_ADMIN_USER_ID in the Render environment to the owner account ID.' });
  if (req.userId !== ownerId) return res.status(403).json({ error: 'This account is not authorised to access the Clipora Admin Center.' });
  next();
}
async function auditAdmin(userId, action, entityType, entityId, details = {}) {
  await database().query(
    'INSERT INTO clipora_admin_audit(admin_user_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',
    [userId, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details)]
  );
}

router.get('/plans', async (req, res) => {
  try {
    const result = await database().query(
      "SELECT id,slug,name,description,price_minor,currency,billing_interval,features FROM clipora_plans WHERE is_active=TRUE ORDER BY sort_order,id"
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ plans: result.rows });
  } catch (error) {
    console.error('Clipora plans:', error.message);
    res.status(503).json({ error: 'Plans are temporarily unavailable.' });
  }
});

router.post('/plan-requests', requireUser, async (req, res) => {
  const planId = Number(req.body?.plan_id);
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!Number.isSafeInteger(planId) || planId < 1) return res.status(400).json({ error: 'Choose a valid plan.' });
  try {
    const result = await database().query(
      `INSERT INTO clipora_plan_requests(auth_user_id,profile_id,plan_id,plan_snapshot,customer_name,customer_email,message)
       SELECT $1,p.id,pl.id,jsonb_build_object('slug',pl.slug,'name',pl.name,'price_minor',pl.price_minor,'currency',pl.currency,'billing_interval',pl.billing_interval,'features',pl.features),
         COALESCE(NULLIF(p.display_name,''),$2),$3,$4
       FROM clipora_plans pl LEFT JOIN linktree_profiles p ON p.auth_user_id=$1
       WHERE pl.id=$5 AND pl.is_active=TRUE
       RETURNING id,plan_snapshot,customer_name,customer_email,message,status,created_at`,
      [req.userId, req.userName || '', req.userEmail || '', message, planId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'That plan is unavailable.' });
    const request = result.rows[0];
    const planName = request.plan_snapshot.name || 'Clipora plan';
    const whatsappText = [
      'Clipora monetisation request',
      'Request: ' + request.id,
      'Plan: ' + planName,
      'Customer: ' + (request.customer_name || 'Not provided'),
      'Email: ' + (request.customer_email || 'Not provided'),
      'User ID: ' + req.userId,
      request.message ? 'Message: ' + request.message : ''
    ].filter(Boolean).join('\n');
    const whatsappUrl = 'https://wa.me/' + OWNER_WHATSAPP + '?text=' + encodeURIComponent(whatsappText);
    res.status(201).json({ request, whatsapp_url: whatsappUrl });
  } catch (error) {
    console.error('Clipora plan request:', error.message);
    res.status(503).json({ error: 'Could not submit your plan request.' });
  }
});

router.get('/admin/whoami', requireUser, (req, res) => {
  res.json({ user_id: req.userId, configured: Boolean(String(process.env.CLIPORA_ADMIN_USER_ID || '').trim()), authorised: Boolean(String(process.env.CLIPORA_ADMIN_USER_ID || '').trim()) && req.userId === String(process.env.CLIPORA_ADMIN_USER_ID).trim() });
});

router.get('/admin/overview', requireUser, requireAdmin, async (req, res) => {
  try {
    const [counts, requests, plans, audit] = await Promise.all([
      database().query(`SELECT
        (SELECT COUNT(*)::int FROM clipora_plan_requests) AS total_requests,
        (SELECT COUNT(*)::int FROM clipora_plan_requests WHERE status='pending') AS pending_requests,
        (SELECT COUNT(*)::int FROM clipora_plans WHERE is_active=TRUE) AS active_plans,
        (SELECT COUNT(DISTINCT auth_user_id)::int FROM linktree_profiles) AS creators`),
      database().query(`SELECT r.id,r.auth_user_id,r.customer_name,r.customer_email,r.message,r.status,r.admin_notes,r.created_at,r.plan_snapshot,
        p.username FROM clipora_plan_requests r LEFT JOIN linktree_profiles p ON p.id=r.profile_id
        ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 100`),
      database().query('SELECT id,slug,name,description,price_minor,currency,billing_interval,features,is_active,sort_order FROM clipora_plans ORDER BY sort_order,id'),
      database().query('SELECT id,action,entity_type,entity_id,details,created_at FROM clipora_admin_audit ORDER BY created_at DESC LIMIT 20')
    ]);
    res.json({ stats: counts.rows[0], requests: requests.rows, plans: plans.rows, audit: audit.rows });
  } catch (error) {
    console.error('Clipora admin overview:', error.message);
    res.status(503).json({ error: 'Could not load the Admin Center.' });
  }
});

router.post('/admin/plans', requireUser, requireAdmin, async (req, res) => {
  const slug = String(req.body?.slug || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim().slice(0,60);
  const description = String(req.body?.description || '').trim().slice(0,240);
  const price = Number(req.body?.price_naira);
  const interval = ['monthly','yearly','one_time'].includes(req.body?.billing_interval) ? req.body.billing_interval : 'monthly';
  const features = Array.isArray(req.body?.features) ? req.body.features.map(x => String(x).trim().slice(0,100)).filter(Boolean).slice(0,20) : [];
  if (!/^[a-z0-9-]{2,40}$/.test(slug) || !name || !Number.isSafeInteger(price) || price < 0 || price > 100000000) return res.status(400).json({ error: 'Enter a valid plan name, slug and whole-naira price.' });
  try {
    const result = await database().query(
      `INSERT INTO clipora_plans(slug,name,description,price_minor,billing_interval,features,sort_order)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,(SELECT COALESCE(MAX(sort_order),0)+1 FROM clipora_plans))
       RETURNING id,slug,name,description,price_minor,currency,billing_interval,features,is_active,sort_order`,
      [slug,name,description,price*100,interval,JSON.stringify(features)]
    );
    await auditAdmin(req.userId,'plan.created','plan',result.rows[0].id,{slug,name});
    res.status(201).json({ plan: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That plan slug already exists.' });
    console.error('Clipora plan create:', error.message);
    res.status(503).json({ error: 'Could not create the plan.' });
  }
});

router.patch('/admin/plans/:id', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const active = req.body?.is_active;
  const price = req.body?.price_naira;
  if (!Number.isSafeInteger(id) || id < 1 || (active === undefined && price === undefined)) return res.status(400).json({ error: 'Invalid plan update.' });
  if (price !== undefined && (!Number.isSafeInteger(Number(price)) || Number(price) < 0 || Number(price) > 100000000)) return res.status(400).json({ error: 'Enter a valid whole-naira price.' });
  try {
    const result = await database().query(
      `UPDATE clipora_plans SET is_active=COALESCE($1,is_active),price_minor=COALESCE($2,price_minor),updated_at=NOW()
       WHERE id=$3 RETURNING id,slug,name,description,price_minor,currency,billing_interval,features,is_active,sort_order`,
      [typeof active === 'boolean' ? active : null, price === undefined ? null : Number(price)*100, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Plan not found.' });
    await auditAdmin(req.userId,'plan.updated','plan',id,{is_active:active,price_naira:price});
    res.json({ plan: result.rows[0] });
  } catch (error) {
    console.error('Clipora plan update:', error.message);
    res.status(503).json({ error: 'Could not update the plan.' });
  }
});

router.patch('/admin/requests/:id', requireUser, requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  const status = req.body?.status;
  const notes = String(req.body?.admin_notes || '').trim().slice(0,2000);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !['pending','approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid request update.' });
  try {
    const result = await database().query(
      `UPDATE clipora_plan_requests SET status=$1,admin_notes=$2,reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW()
       WHERE id=$4 RETURNING id,status,admin_notes,reviewed_at`,
      [status,notes,req.userId,id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Request not found.' });
    await auditAdmin(req.userId,'plan_request.'+status,'plan_request',id,{admin_notes:notes});
    res.json({ request: result.rows[0] });
  } catch (error) {
    console.error('Clipora request update:', error.message);
    res.status(503).json({ error: 'Could not update this request.' });
  }
});


module.exports = router;
