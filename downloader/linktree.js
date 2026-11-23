const express = require('express');
const { Pool } = require('pg');
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
      `SELECT p.username,p.display_name,p.bio,p.avatar_url,p.cover_url,p.theme,
        COALESCE(json_agg(json_build_object('id',l.id,'title',l.title,'url',l.url,'icon',l.icon,'sort_order',l.sort_order))
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
      `SELECT p.id,p.username,p.display_name,p.bio,p.avatar_url,p.cover_url,p.theme,p.is_published,
       COALESCE(json_agg(json_build_object('id',l.id,'title',l.title,'url',l.url,'icon',l.icon,'sort_order',l.sort_order,'is_active',l.is_active))
       FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS links
       FROM linktree_profiles p LEFT JOIN linktree_links l ON l.profile_id=p.id
       WHERE p.auth_user_id=$1 GROUP BY p.id LIMIT 1`, [req.userId]);
    res.json({ profile: result.rows[0] || null });
  } catch (error) { console.error('Link Tree owner profile:', error.message); res.status(503).json({ error: 'Could not load your profile.' }); }
});

router.put('/profile', requireUser, async (req, res) => {
  const username = cleanUsername(req.body?.username);
  const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
  const bio = String(req.body?.bio || '').trim().slice(0, 280);
  const avatar = String(req.body?.avatar_url || '').trim().slice(0, 1000) || null;
  const cover = String(req.body?.cover_url || '').trim().slice(0, 1000) || null;
  const theme = ['liquid-dark','liquid-light'].includes(req.body?.theme) ? req.body.theme : 'liquid-dark';
  if (!/^[a-z0-9_][a-z0-9_.]{1,29}$/.test(username)) return res.status(400).json({ error: 'Username must be 2–30 characters and use letters, numbers, dots or underscores.' });
  if (!displayName) return res.status(400).json({ error: 'Display name is required.' });
  if (avatar && !validUrl(avatar)) return res.status(400).json({ error: 'Profile picture must be a valid http(s) URL.' });
  if (cover && !validUrl(cover)) return res.status(400).json({ error: 'Cover image must be a valid http(s) URL.' });
  try {
    const result = await database().query(
      `INSERT INTO linktree_profiles(auth_user_id,username,display_name,bio,avatar_url,cover_url,theme)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(auth_user_id) DO UPDATE SET username=EXCLUDED.username,display_name=EXCLUDED.display_name,bio=EXCLUDED.bio,
       avatar_url=EXCLUDED.avatar_url,cover_url=EXCLUDED.cover_url,theme=EXCLUDED.theme,updated_at=NOW()
       RETURNING id,username,display_name,bio,avatar_url,cover_url,theme,is_published`,
      [req.userId,username,displayName,bio,avatar,cover,theme]);
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
  if (!title || !validUrl(url)) return res.status(400).json({ error: 'Enter a title and a valid http(s) URL.' });
  try {
    const profile = await database().query('SELECT id FROM linktree_profiles WHERE auth_user_id=$1',[req.userId]);
    if (!profile.rowCount) return res.status(409).json({ error: 'Create your profile before adding links.' });
    const result = await database().query(
      `INSERT INTO linktree_links(profile_id,title,url,icon,sort_order)
       VALUES($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM linktree_links WHERE profile_id=$1))
       RETURNING id,title,url,icon,sort_order,is_active`,[profile.rows[0].id,title,url,icon]);
    res.status(201).json({ link: result.rows[0] });
  } catch (error) { console.error('Link Tree add link:', error.message); res.status(503).json({ error: 'Could not add this link.' }); }
});

router.patch('/links/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body?.title || '').trim().slice(0,80);
  const url = String(req.body?.url || '').trim();
  const isActive = req.body?.is_active !== false;
  if (!Number.isSafeInteger(id) || id < 1 || !title || !validUrl(url)) return res.status(400).json({ error: 'Invalid link details.' });
  try {
    const result = await database().query(
      `UPDATE linktree_links l SET title=$1,url=$2,is_active=$3,updated_at=NOW()
       FROM linktree_profiles p WHERE l.profile_id=p.id AND p.auth_user_id=$4 AND l.id=$5
       RETURNING l.id,l.title,l.url,l.icon,l.sort_order,l.is_active`,[title,url,isActive,req.userId,id]);
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

module.exports = router;
