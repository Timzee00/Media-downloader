'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('built page contains exactly one visible footer and history button', () => {
  const html = fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
  assert.equal((html.match(/id="openHistory"/g)||[]).length,1);
  assert.match(html, /aria-controls="historyPanel"/);
  const header=html.slice(html.indexOf('<header>'),html.indexOf('</header>')+9);
  assert.match(header, /id="openHistory"/);
  assert.equal((html.match(/class="site-footer"/g)||[]).length,1);
  assert.equal((html.match(/class="brand-footer"/g)||[]).length,0);
  assert.match(html, /\.history-toggle\{position:static/);
});
test('source failures display official Audiomack guidance',()=>{
  const html = fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
  assert.match(html,/Audiomack did not return/);
  assert.match(html,/audiomack\.zendesk\.com/);
  assert.match(html,/const active=stages\.find\(s=>s\.classList\.contains\('failed'\)\)/);
});
test('built handler separates failed Audiomack providers from a missing song audio stream',()=>{
  const server=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  assert.match(server,/AUDIOMACK_PROVIDER_UNAVAILABLE/);
  assert.match(server,/INVALID_PROVIDER_MEDIA/);
});
