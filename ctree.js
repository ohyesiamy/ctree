#!/usr/bin/env node
'use strict';
// ctree — cmux のブラウザペインにディレクトリツリーを表示する自己完結 CLI。
// 外部依存ゼロ。クリックで絶対パスをコピー。詳細: docs/superpowers/specs/2026-07-04-ctree-design.md

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'ctree');
const MAX_WATCHERS = 256;
const MAX_ENTRIES = 2000;
const MAX_CODE_BYTES = 2 * 1024 * 1024;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  heic: 'image/heic', bmp: 'image/bmp', pdf: 'application/pdf',
};

// 拡張子 → highlight.js の言語 id (未知の拡張子は hljs の自動判定に任せる)
const HLJS_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', swift: 'swift',
  sh: 'bash', zsh: 'bash', bash: 'bash', css: 'css', scss: 'scss',
  html: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml', json: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown',
  sql: 'sql', php: 'php', java: 'java', kt: 'kotlin', lua: 'lua',
  pl: 'perl', r: 'r', dockerfile: 'dockerfile', makefile: 'makefile',
};

// ---------------------------------------------------------------- gitignore

function globToRe(glob) {
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { s += '.*'; i++; } else s += '[^/]*';
    } else if (c === '?') s += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) s += '\\' + c;
    else s += c;
  }
  return new RegExp('^' + s + '$');
}

// ルート直下の .gitignore を簡易解釈する (否定 ! とネストした .gitignore は非対応)
function makeIgnoreMatcher(root) {
  const pats = [];
  let txt = '';
  try { txt = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch {}
  for (let line of txt.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    let anchored = false;
    if (line.startsWith('/')) { anchored = true; line = line.slice(1); }
    else if (line.includes('/')) anchored = true;
    pats.push({ re: globToRe(line), dirOnly, anchored });
  }
  return function ignored(rel, isDir) {
    const base = rel.split('/').pop();
    if (base === '.git' || base === 'node_modules') return true;
    for (const p of pats) {
      if (p.dirOnly && !isDir) continue;
      if (p.re.test(p.anchored ? rel : base)) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------- fs 列挙

function safeRel(root, q) {
  const abs = path.resolve(root, q || '');
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return path.relative(root, abs).split(path.sep).join('/');
}

function listDir(root, rel, showHidden, ignored) {
  const abs = path.join(root, ...rel.split('/').filter(Boolean));
  const dirents = fs.readdirSync(abs, { withFileTypes: true });
  const out = [];
  let omitted = 0;
  for (const e of dirents) {
    if (!showHidden && e.name.startsWith('.')) continue;
    const isDir = e.isDirectory();
    const r = rel ? rel + '/' + e.name : e.name;
    if (ignored(r, isDir)) continue;
    out.push({ name: e.name, type: isDir ? 'dir' : e.isSymbolicLink() ? 'link' : 'file' });
  }
  out.sort((a, b) =>
    (a.type === 'dir') !== (b.type === 'dir')
      ? (a.type === 'dir' ? -1 : 1)
      : a.name.localeCompare(b.name, 'ja'));
  if (out.length > MAX_ENTRIES) {
    omitted = out.length - MAX_ENTRIES;
    out.length = MAX_ENTRIES;
  }
  return { entries: out, omitted };
}

// ---------------------------------------------------------------- markdown

// 依存ゼロのミニ markdown レンダラ (見出し/リスト/コード/表/引用/強調/リンク)。
// cmux 組み込みビューアが開けない環境 (常駐サーバは cmux socket 認証を通らない) の
// フォールバック表示用
function renderMarkdown(src) {
  const esc = (s) => escapeHtml(s);
  const inline = (s) => {
    // 数式 ($$...$$ / $...$) を先に退避し、markdown 変換・エスケープから守る。
    // 実際の描画はブラウザ側の KaTeX が行う (textContent から元の式を読む)
    const math = [];
    const stash = (tex, display) => '\x00M' + (math.push({ tex, display }) - 1) + '\x00';
    s = s
      .replace(/\$\$([^\n]+?)\$\$/g, (_m, t) => stash(t, true))
      // インライン数式: 区切り $ に空白を隣接させない (通貨表記との誤検出を避ける)
      .replace(/\$(?![ \t])((?:[^$\\]|\\.)+?)(?<![ \t])\$/g, (_m, t) => stash(t, false));
    const html = esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<em>[画像: $1]</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
    return html.replace(/\x00M(\d+)\x00/g, (_m, i) => {
      const { tex, display } = math[+i];
      return `<span class="math${display ? ' math-display' : ''}">${esc(tex)}</span>`;
    });
  };
  const lines = src.split(/\r?\n/);
  const out = [];
  let list = null, quote = false, para = [];
  const closePara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  const closeAll = () => { closePara(); closeList(); closeQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      closeAll();
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      // mermaid はダイアグラムとして描画する (実際のレンダリングは mermaid.js が
      // ブラウザ側で行う)。エスケープしても textContent は復号されるので安全。
      // CDN が読めない / 構文エラー時は元のソースがそのまま可読テキストとして残る
      if (fence[1] === 'mermaid') {
        out.push('<pre class="mermaid">' + esc(buf.join('\n')) + '</pre>');
      } else {
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      }
      continue;
    }
    // ブロック数式: 単独行の $$ で開き、同一行 or 後続行の $$ で閉じる
    if (/^\$\$/.test(line)) {
      closeAll();
      const oneLine = line.match(/^\$\$([\s\S]+?)\$\$\s*$/);
      if (oneLine) {
        out.push('<div class="math math-display">' + esc(oneLine[1].trim()) + '</div>');
        continue;
      }
      const buf = [line.replace(/^\$\$/, '')];
      for (i++; i < lines.length; i++) {
        if (/\$\$\s*$/.test(lines[i])) { buf.push(lines[i].replace(/\$\$\s*$/, '')); break; }
        buf.push(lines[i]);
      }
      out.push('<div class="math math-display">' + esc(buf.join('\n').trim()) + '</div>');
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { closeAll(); const n = h[1].length; out.push(`<h${n}>` + inline(h[2]) + `</h${n}>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeAll(); out.push('<hr>'); continue; }
    if (/^\|.*\|\s*$/.test(line)) {
      closeAll();
      const rows = [];
      for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const cells = (r) => r.replace(/^\||\|\s*$/g, '').split('|').map((c) => inline(c.trim()));
      let html = '<div class="tblwrap"><table>';
      rows.forEach((r, ri) => {
        if (/^\|[\s:|-]+\|$/.test(r.replace(/\s/g, ''))) return; // 区切り行
        const tag = ri === 0 ? 'th' : 'td';
        html += '<tr>' + cells(r).map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      });
      out.push(html + '</table></div>');
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)/);
    if (li) {
      closePara(); closeQuote();
      const want = /^\d+\./.test(li[1]) ? 'ol' : 'ul';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inline(li[2]) + '</li>');
      continue;
    }
    const q = line.match(/^>\s?(.*)/);
    if (q) {
      closePara(); closeList();
      if (!quote) { out.push('<blockquote>'); quote = true; }
      out.push('<p>' + inline(q[1]) + '</p>');
      continue;
    }
    if (!line.trim()) { closeAll(); continue; }
    closeList(); closeQuote();
    para.push(line.trim());
  }
  closeAll();
  return out.join('\n');
}

// ---------------------------------------------------------------- server

function createApp(root) {
  const ignored = makeIgnoreMatcher(root);
  const sseClients = new Set();
  const watchers = new Map(); // rel -> {w, timer}

  function broadcast(rel) {
    const msg = `data: ${JSON.stringify({ dir: rel })}\n\n`;
    for (const res of sseClients) res.write(msg);
  }

  function ensureWatch(rel) {
    if (watchers.has(rel)) return;
    if (watchers.size >= MAX_WATCHERS) {
      const oldest = watchers.keys().next().value;
      watchers.get(oldest).w.close();
      watchers.delete(oldest);
    }
    const abs = path.join(root, ...rel.split('/').filter(Boolean));
    try {
      const w = fs.watch(abs, () => {
        const rec = watchers.get(rel);
        if (!rec) return;
        clearTimeout(rec.timer);
        rec.timer = setTimeout(() => broadcast(rel), 250);
      });
      w.on('error', () => { watchers.delete(rel); });
      watchers.set(rel, { w, timer: null });
    } catch {}
  }

  const server = http.createServer(handler);
  server.on('close', () => {
    for (const { w, timer } of watchers.values()) { clearTimeout(timer); w.close(); }
    watchers.clear();
    for (const res of sseClients) res.end();
    sseClients.clear();
  });

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderHtml(root));
      } else if (url.pathname === '/api/ping') {
        json(res, 200, { ok: true, root });
      } else if (url.pathname === '/api/tree') {
        const rel = safeRel(root, url.searchParams.get('path') || '');
        if (rel === null) return json(res, 403, { error: 'root 外のパスです' });
        const showHidden = url.searchParams.get('hidden') === '1';
        try {
          const r = listDir(root, rel, showHidden, ignored);
          ensureWatch(rel);
          json(res, 200, r);
        } catch (e) {
          json(res, e.code === 'EACCES' ? 403 : 500, { error: readableFsError(e) });
        }
      } else if (url.pathname === '/api/copy' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let p;
          try { p = JSON.parse(body).path; } catch { return json(res, 400, { error: 'bad json' }); }
          const abs = path.resolve(p || '');
          if (abs !== root && !abs.startsWith(root + path.sep)) {
            return json(res, 403, { error: 'root 外のパスです' });
          }
          copyToClipboard(abs, (err) => {
            if (err) json(res, 500, { error: 'クリップボードへのコピーに失敗しました' });
            else json(res, 200, { ok: true });
          });
        });
      } else if (url.pathname === '/md') {
        const rel = safeRel(root, url.searchParams.get('path') || '');
        if (rel === null) return json(res, 403, { error: 'root 外のパスです' });
        try {
          const abs = path.join(root, ...rel.split('/').filter(Boolean));
          const src = fs.readFileSync(abs, 'utf8');
          const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          ensureWatch(parent);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderMdPage(root, rel, renderMarkdown(src)));
        } catch (e) {
          json(res, 500, { error: readableFsError(e) });
        }
      } else if (url.pathname === '/raw') {
        const rel = safeRel(root, url.searchParams.get('path') || '');
        if (rel === null) return json(res, 403, { error: 'root 外のパスです' });
        try {
          const abs = path.join(root, ...rel.split('/').filter(Boolean));
          const ext = (rel.split('.').pop() || '').toLowerCase();
          const buf = fs.readFileSync(abs);
          res.writeHead(200, {
            'content-type': MIME[ext] || 'application/octet-stream',
            'cache-control': 'no-cache',
          });
          res.end(buf);
        } catch (e) {
          json(res, 500, { error: readableFsError(e) });
        }
      } else if (url.pathname === '/img') {
        const rel = safeRel(root, url.searchParams.get('path') || '');
        if (rel === null) return json(res, 403, { error: 'root 外のパスです' });
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        ensureWatch(parent);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderImgPage(root, rel));
      } else if (url.pathname === '/code') {
        const rel = safeRel(root, url.searchParams.get('path') || '');
        if (rel === null) return json(res, 403, { error: 'root 外のパスです' });
        try {
          const abs = path.join(root, ...rel.split('/').filter(Boolean));
          const buf = fs.readFileSync(abs);
          let note = null;
          let text = '';
          if (buf.length > MAX_CODE_BYTES) note = 'ファイルが大きすぎるためプレビューできません (2MB 上限)';
          else if (buf.includes(0)) note = 'バイナリファイルはプレビューできません';
          else text = buf.toString('utf8');
          const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          ensureWatch(parent);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderCodePage(root, rel, text, note));
        } catch (e) {
          json(res, 500, { error: readableFsError(e) });
        }
      } else if (url.pathname === '/edit') {
        const rel = safeRel(root, url.searchParams.get('path') || '');
        if (rel === null) return json(res, 403, { error: 'root 外のパスです' });
        const ext = (rel.split('.').pop() || '').toLowerCase();
        if (!['md', 'mdx', 'markdown'].includes(ext)) return json(res, 400, { error: 'markdown ファイルのみ編集できます' });
        try {
          const abs = path.join(root, ...rel.split('/').filter(Boolean));
          const src = fs.readFileSync(abs, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderEditPage(root, rel, src));
        } catch (e) {
          json(res, 500, { error: readableFsError(e) });
        }
      } else if (url.pathname === '/api/render' && req.method === 'POST') {
        // プレビュー用: 本文を受け取りビューアと同一のレンダラで HTML を返す
        let body = ''; let over = false;
        req.on('data', (c) => { body += c; if (body.length > 5 * 1024 * 1024) { over = true; req.destroy(); } });
        req.on('end', () => {
          if (over) return json(res, 413, { error: 'コンテンツが大きすぎます' });
          let content;
          try { content = JSON.parse(body).content; } catch { return json(res, 400, { error: 'bad json' }); }
          json(res, 200, { html: renderMarkdown(String(content == null ? '' : content)) });
        });
      } else if (url.pathname === '/api/write' && req.method === 'POST') {
        // 保存: root 内 & markdown 拡張子 & 既存ファイルに限定して上書き
        let body = ''; let over = false;
        req.on('data', (c) => { body += c; if (body.length > 5 * 1024 * 1024) { over = true; req.destroy(); } });
        req.on('end', () => {
          if (over) return json(res, 413, { error: 'ファイルが大きすぎます' });
          let p, content;
          try { const j = JSON.parse(body); p = j.path; content = j.content; } catch { return json(res, 400, { error: 'bad json' }); }
          const rel = safeRel(root, p || '');
          if (rel === null) return json(res, 403, { error: 'root 外のパスです' });
          const ext = (rel.split('.').pop() || '').toLowerCase();
          if (!['md', 'mdx', 'markdown'].includes(ext)) return json(res, 400, { error: 'markdown ファイルのみ保存できます' });
          if (typeof content !== 'string') return json(res, 400, { error: 'content が不正です' });
          const abs = path.join(root, ...rel.split('/').filter(Boolean));
          let st;
          try { st = fs.statSync(abs); } catch { return json(res, 404, { error: '対象ファイルが見つかりません' }); }
          if (!st.isFile()) return json(res, 400, { error: 'ファイルではありません' });
          try { fs.writeFileSync(abs, content, 'utf8'); json(res, 200, { ok: true }); }
          catch (e) { json(res, 500, { error: readableFsError(e) }); }
        });
      } else if (url.pathname === '/api/open-md' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let p;
          try { p = JSON.parse(body).path; } catch { return json(res, 400, { error: 'bad json' }); }
          const abs = path.resolve(p || '');
          if (abs !== root && !abs.startsWith(root + path.sep)) {
            return json(res, 403, { error: 'root 外のパスです' });
          }
          if (cmuxCmd(['markdown', 'open', abs]) !== null) json(res, 200, { ok: true });
          else json(res, 500, { error: 'cmux の markdown ビューアを開けませんでした (' + lastCmuxError + ')' });
        });
      } else if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        const ka = setInterval(() => res.write(': ka\n\n'), 30000);
        req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      } else {
        res.writeHead(404); res.end('not found');
      }
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  }
  return server;
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readableFsError(e) {
  if (e.code === 'EACCES') return 'アクセス権限がありません';
  if (e.code === 'ENOENT') return 'ディレクトリが見つかりません';
  return String(e.message || e);
}

function copyToClipboard(text, cb) {
  const cmd = process.env.CTREE_COPY_CMD || 'pbcopy';
  const child = spawn(cmd, [], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', (e) => cb(e));
  child.on('close', (code) => cb(code === 0 ? null : new Error('exit ' + code)));
  child.stdin.end(text);
}

// ---------------------------------------------------------------- state file

function stateFile(root) {
  const h = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, h + '.json');
}

function readState(root) {
  try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ping(port, root) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).root === root); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------- cmux 連携

let lastCmuxError = '';
function cmuxCmd(args) {
  const bin = process.env.CTREE_CMUX_BIN || 'cmux';
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 });
  if (process.env.CTREE_DEBUG) {
    console.error(`[cmux ${args.join(' ')}] -> status=${r.status}` +
      (r.error ? ` error=${r.error.message}` : '') +
      ` out=${JSON.stringify((r.stdout || '').slice(0, 120))}`);
  }
  if (r.error || r.status !== 0) {
    lastCmuxError = r.error ? r.error.message : `exit ${r.status}: ${(r.stderr || '').trim()}`;
    return null;
  }
  return r.stdout;
}

// 現在のウィンドウのブラウザ surface を [{ref, title, url}] で返す (tree 出力から解析)
function browserSurfaces() {
  const tree = cmuxCmd(['tree']);
  if (!tree) return [];
  const out = [];
  for (const line of tree.split('\n')) {
    if (!line.includes('[browser]')) continue;
    const ref = (line.match(/surface (surface:\d+)/) || [])[1];
    const title = (line.match(/"([^"]*)"/) || [])[1] || '';
    const url = (line.match(/(https?:\/\/\S+)\s*$/) || [])[1] || '';
    if (ref) out.push({ ref, title, url });
  }
  return out;
}

// 同 URL のペインがあれば再利用。サーバ再起動で URL が変わった場合は、
// 同タイトル (ctree — <名前>) の旧ペインをナビゲートして流用し、ペインを増やさない
function openPane(url, paneTitle) {
  const origin = url.replace(/\/$/, '');
  const surfaces = browserSurfaces();
  if (surfaces.some((s) => s.url.startsWith(origin))) return 'reused';
  const stale = surfaces.find((s) =>
    s.title === paneTitle && s.url.startsWith('http://127.0.0.1') && !s.url.startsWith(origin));
  if (stale && cmuxCmd(['browser', '--surface', stale.ref, 'goto', url]) !== null) return 'reused';
  if (cmuxCmd(['browser', 'open', url]) !== null) return 'opened';
  return 'failed';
}

// ---------------------------------------------------------------- CLI

const USAGE = `ctree — ディレクトリツリーを cmux のブラウザペインに表示する

使い方:
  ctree [dir]        指定ディレクトリ (省略時はカレント) のツリーを開く
  ctree --if-cmux    cmux 内のときだけ起動する (Claude Code hook 用)
  ctree --no-open    ペインを開かず URL だけ表示する
  ctree --help       このヘルプ

同じディレクトリに対してはサーバと表示ペインを再利用します。`;

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }

  const serveIdx = args.indexOf('--serve');
  if (serveIdx !== -1) return serve(args[serveIdx + 1]);

  if (args.includes('--if-cmux') && !process.env.CMUX_SOCKET_PATH) return 0;
  const noOpen = args.includes('--no-open');
  const dirArg = args.find((a) => !a.startsWith('-'));
  const root = path.resolve(dirArg || process.cwd());

  let st;
  try { st = fs.statSync(root); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    console.error(`ctree: ディレクトリではありません: ${root}`);
    return 1;
  }

  // 既存サーバの再利用、なければ detach 起動
  let state = readState(root);
  let alive = state && state.root === root && pidAlive(state.pid) && (await ping(state.port, root));
  if (!alive) {
    spawn(process.execPath, [__filename, '--serve', root], { detached: true, stdio: 'ignore' }).unref();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      state = readState(root);
      if (state && state.root === root && (await ping(state.port, root))) { alive = true; break; }
    }
    if (!alive) { console.error('ctree: サーバの起動に失敗しました'); return 1; }
  }

  const url = `http://127.0.0.1:${state.port}/`;
  if (noOpen) { console.log(url); return 0; }
  const result = openPane(url, `ctree — ${path.basename(root) || root}`);
  if (result === 'failed') {
    console.log(`ctree: cmux ペインを開けませんでした。ブラウザでどうぞ: ${url}`);
  } else {
    console.log(`ctree: ${url} (${result === 'reused' ? '既存ペインを再利用' : 'ペインを開きました'})`);
  }
  return 0;
}

function serve(root) {
  root = path.resolve(root);
  process.title = 'ctree-server';
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const server = createApp(root);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    fs.writeFileSync(stateFile(root), JSON.stringify({ pid: process.pid, port, root }));
  });
  // 状態ファイルは消さない: 残っていても pid/ping 検査で無害で、
  // 再起動時に旧ポート (旧ペインの流用先特定) の手がかりになる
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  return new Promise(() => {}); // 常駐
}

// ---------------------------------------------------------------- UI

function renderHtml(root) {
  const home = os.homedir();
  const shortRoot = root.startsWith(home) ? '~' + root.slice(home.length) : root;
  const name = path.basename(root) || root;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ctree — ${escapeHtml(name)}</title>
<style>
:root {
  --bg: #101312; --bg-raise: #171b19; --bg-hover: #1e2420;
  --text: #d7dcd3; --dim: #8d968b; --faint: #5c6459;
  --accent: #e2a656; --accent-soft: rgba(226, 166, 86, .14);
  --guide: #232922; --border: #262d27;
  --c-code: #9fc78a; --c-img: #b49ad2; --c-conf: #c9a86e; --c-doc: #8fb3c7;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f2ea; --bg-raise: #ede9de; --bg-hover: #e5e0d2;
    --text: #33372f; --dim: #6d7367; --faint: #9aa090;
    --accent: #a86a1e; --accent-soft: rgba(168, 106, 30, .12);
    --guide: #ddd8c9; --border: #d5cfbf;
    --c-code: #4d7a33; --c-img: #7551a3; --c-conf: #8a6a2c; --c-doc: #3d6d8a;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font-family: ui-monospace, "SF Mono", Menlo, "Hiragino Sans", monospace;
  font-size: 14px; font-weight: 500; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "palt", "calt";
  line-break: strict;
  overflow-x: hidden;
  display: flex; flex-direction: column;
}
body::before { /* 上部の淡い琥珀グロー */
  content: ""; position: fixed; inset: 0 0 auto 0; height: 120px; pointer-events: none;
  background: radial-gradient(60% 100% at 50% 0%, var(--accent-soft), transparent 70%);
  opacity: .6;
}
p { text-wrap: pretty; word-break: auto-phrase; overflow-wrap: normal; }

/* ---- header ---- */
header {
  position: sticky; top: 0; z-index: 2;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--border);
  padding: 10px 12px 8px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
}
.brand { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 140px; }
.brand .app { color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: .12em; }
.brand .root-name {
  font-size: 15px; font-weight: 700; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.brand .root-name:hover { color: var(--accent); }
.root-path {
  flex: 1 1 100%; color: var(--faint); font-size: 12px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left;
}
.tools { display: flex; gap: 4px; }
.tools button {
  appearance: none; background: none; border: 1px solid var(--border); border-radius: 5px;
  color: var(--dim); width: 26px; height: 26px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.tools button:hover { color: var(--accent); border-color: var(--accent); }
.tools button.on { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.tools svg { width: 15px; height: 15px; }

/* ---- tree ---- */
main { flex: 1 1 auto; padding: 6px 6px 12px; min-height: 0; overflow-y: auto; }
ul.tree, ul.tree ul { list-style: none; }
ul.tree ul { margin-left: 15px; border-left: 1px solid var(--guide); padding-left: 4px; }
/* fill-mode を付けない: バックグラウンドの webview はアニメーションを止めるため、
   both だと from (opacity:0) で固まり行が消える */
li { animation: rowIn .18s ease; }
@keyframes rowIn { from { opacity: 0; transform: translateY(-2px); } }
.row {
  display: flex; align-items: center; gap: 4px;
  min-height: 25px; padding: 1px 6px 1px 2px; border-radius: 5px;
  cursor: pointer; min-width: 0;
}
.row:hover { background: var(--bg-hover); }
.row:hover .name { color: var(--accent); }
.row.flash { background: var(--accent-soft); }
.chev {
  flex: 0 0 18px; height: 22px; border: 0; background: none; color: var(--faint);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
}
.chev svg { width: 10px; height: 10px; transition: transform .12s ease; }
li.open > .row .chev svg { transform: rotate(90deg); }
.chev:hover { color: var(--accent); }
span.chev { pointer-events: none; }
.ico { flex: 0 0 16px; display: inline-flex; color: var(--dim); }
.ico svg { width: 14px; height: 14px; }
.row.dir .ico { color: var(--accent); opacity: .85; }
.ico.t-code { color: var(--c-code); } .ico.t-img { color: var(--c-img); }
.ico.t-conf { color: var(--c-conf); } .ico.t-doc { color: var(--c-doc); }
.name {
  flex: 1 1 auto; min-width: 0; font-size: 13.5px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row .copy-hint { flex: 0 0 auto; color: var(--faint); opacity: 0; font-size: 11px; }
.row:hover .copy-hint { opacity: 1; }
.mdbtn {
  flex: 0 0 20px; height: 20px; border: 0; background: none; padding: 0; cursor: pointer;
  color: var(--c-doc); opacity: .55;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 4px;
}
.mdbtn svg { width: 13px; height: 13px; }
.mdbtn:hover { opacity: 1; background: var(--accent-soft); color: var(--accent); }
li.err, li.more { color: var(--dim); font-size: 12.5px; padding: 2px 8px; }
li.err { color: #c96f5e; }

/* ---- usage ---- */
details.usage { border-top: 1px solid var(--border); background: var(--bg-raise); }
details.usage summary {
  cursor: pointer; list-style: none; padding: 9px 12px;
  color: var(--dim); font-size: 13px; font-weight: 600;
  display: flex; align-items: center; gap: 7px;
}
details.usage summary::-webkit-details-marker { display: none; }
details.usage summary .tri { transition: transform .12s ease; font-size: 10px; color: var(--faint); }
details.usage[open] summary .tri { transform: rotate(90deg); }
details.usage summary:hover { color: var(--accent); }
.usage-body { padding: 2px 12px 14px; display: flex; flex-direction: column; gap: 10px;
  max-height: 55vh; overflow-y: auto; }
.usage-body h3 { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: .06em; }
.usage-body p { font-size: 13px; font-weight: 500; color: var(--dim); }
.usage-body .kbd { color: var(--text); background: var(--bg-hover); border: 1px solid var(--border);
  border-radius: 4px; padding: 0 5px; font-size: 12px; white-space: nowrap; }
.usage-body pre {
  background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 9px 11px; overflow-x: auto; font-size: 12.5px; line-height: 1.7;
}
.usage-body pre code { color: var(--text); }
.usage-body pre .cm { color: var(--faint); }
.nb { display: inline-block; white-space: nowrap; }

/* ---- toast ---- */
#toast {
  position: fixed; left: 50%; bottom: 14px; transform: translate(-50%, 6px);
  max-width: min(92vw, 480px); min-width: 0;
  background: var(--bg-raise); border: 1px solid var(--accent); border-radius: 7px;
  padding: 8px 13px; opacity: 0; pointer-events: none;
  transition: opacity .15s ease, transform .15s ease; z-index: 9;
  box-shadow: 0 6px 24px rgba(0,0,0,.35);
}
#toast.show { opacity: 1; transform: translate(-50%, 0); }
#toast .t1 { color: var(--accent); font-size: 12.5px; font-weight: 700; }
#toast.err .t1 { color: #c96f5e; }
#toast .t2 {
  color: var(--dim); font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left;
}

/* ---- 狭ペイン ---- */
@media (max-width: 300px) {
  .brand .app { display: none; }
  header { padding: 8px 8px 6px; }
  main { padding: 4px 3px 10px; }
  ul.tree ul { margin-left: 10px; padding-left: 3px; }
  .usage-body pre { font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  li { animation: none; }
  .chev svg, #toast { transition: none; }
}
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="app">CTREE</span>
    <span class="root-name" id="rootName" title="クリックでルートの絶対パスをコピー">${escapeHtml(name)}</span>
  </div>
  <div class="tools">
    <button id="btnHidden" title="隠しファイルの表示切替" aria-label="隠しファイルの表示切替">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.1"/></svg>
    </button>
    <button id="btnReload" title="再読み込み" aria-label="再読み込み">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3"/></svg>
    </button>
  </div>
  <div class="root-path" title="${escapeHtml(root)}">&lrm;${escapeHtml(shortRoot)}</div>
</header>

<main><ul class="tree" id="tree"></ul></main>

<details class="usage">
  <summary><span class="tri">▶</span>ターミナルでの使い方</summary>
  <div class="usage-body">
    <h3>USAGE</h3>
    <pre><code>ctree [dir]        <span class="cm"># 指定ディレクトリのツリーを cmux ペインで開く</span>
ctree              <span class="cm"># カレントディレクトリを開く</span>
ctree --if-cmux    <span class="cm"># cmux 内のときだけ起動 (hook 用)</span>
ctree --no-open    <span class="cm"># ペインを開かず URL だけ表示</span></code></pre>
    <p>同じ<wbr>ディレクトリに<wbr>対しては、<span class="nb">サーバと</span><wbr><span class="nb">表示ペインを</span><wbr>再利用します。<wbr>何度<wbr>実行しても<wbr>ペインは<wbr>増えません。</p>
    <h3>操作</h3>
    <p><span class="nb">行を</span><wbr><span class="nb">クリック</span>すると<wbr><span class="nb">絶対パスを</span><wbr><span class="nb">コピー。</span><wbr>フォルダは<wbr><span class="kbd">▶</span> で<wbr>開閉。<wbr><span class="nb">右上の</span><wbr><span class="nb">目のアイコンで</span><wbr><span class="nb">隠しファイルを</span><wbr>表示。</p>
    <p><span class="nb">ファイル行の</span><wbr><span class="nb">右端のアイコンで</span><wbr>プレビュー:<wbr><span class="nb">.md は</span><wbr><span class="nb">markdown ビューア、</span><wbr><span class="nb">画像は</span><wbr><span class="nb">画像ビューア、</span><wbr><span class="nb">その他は</span><wbr><span class="nb">コードビューア</span><wbr><span class="nb">(シンタックスハイライト +</span><wbr><span class="nb">word wrap 付き)。</span><wbr><span class="nb">すべて live reload 対応。</span></p>
    <h3>Claude Code hook (自動起動)</h3>
    <p><span class="nb">~/.claude/settings.json</span> に<wbr>追加すると、<wbr><span class="nb">セッション開始時に</span><wbr><span class="nb">作業ディレクトリの</span><wbr><span class="nb">ツリーが</span><wbr><span class="nb">自動で</span><wbr>開きます:</p>
    <pre><code>{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
                     "command": "ctree --if-cmux" } ] }
    ]
  }
}</code></pre>
  </div>
</details>

<div id="toast"><div class="t1" id="toastMsg"></div><div class="t2" id="toastPath"></div></div>

<script>
const ROOT = ${JSON.stringify(root)};
const $tree = document.getElementById('tree');
let showHidden = false;
const expanded = new Map();   // rel -> ul
const liByRel = new Map();    // rel -> li

const SVG = {
  chev: '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M2.5 1l5 4-5 4z"/></svg>',
  dir: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 4a1 1 0 0 1 1-1h3.2l1.4 1.7h6.4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6L12.5 4.5v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>',
  code: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/></svg>',
  img: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1"/><circle cx="5.4" cy="6" r="1.1"/><path d="M2 11.5l3.5-3 3 2.6 2.5-2.1 3 2.5"/></svg>',
  conf: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 2.5c-1.4.4-2 1-2 2.4 0 1.7-.4 2.4-2 3.1 1.6.7 2 1.4 2 3.1 0 1.4.6 2 2 2.4M10 2.5c1.4.4 2 1 2 2.4 0 1.7.4 2.4 2 3.1-1.6.7-2 1.4-2 3.1 0 1.4-.6 2-2 2.4"/></svg>',
  doc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6L12.5 4.5v10h-9z"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3"/></svg>',
  link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6.5 9.5l3-3M5 7.5L3.5 9a2.5 2.5 0 0 0 3.5 3.5L8.5 11M11 8.5L12.5 7A2.5 2.5 0 0 0 9 3.5L7.5 5"/></svg>',
  book: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 3.5C6.8 2.4 5 2 2.5 2v11c2.5 0 4.3.4 5.5 1.5 1.2-1.1 3-1.5 5.5-1.5V2C11 2 9.2 2.4 8 3.5z"/><path d="M8 3.5v11"/></svg>',
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.1"/></svg>'
};
const CODE_EXT = new Set(['js','mjs','cjs','ts','tsx','jsx','vue','py','rb','go','rs','c','h','cpp','swift','sh','zsh','bash','sql','css','scss','html']);
const IMG_EXT = new Set(['png','jpg','jpeg','gif','svg','webp','ico','heic','pdf']);
const CONF_EXT = new Set(['json','yml','yaml','toml','plist','lock','env','ini','conf']);
const DOC_EXT = new Set(['md','mdx','txt','rst','org']);
const MD_EXT = new Set(['md','mdx','markdown']);

function iconFor(e) {
  if (e.type === 'dir') return ['', SVG.dir];
  if (e.type === 'link') return ['', SVG.link];
  const ext = (e.name.split('.').pop() || '').toLowerCase();
  if (CODE_EXT.has(ext)) return ['t-code', SVG.code];
  if (IMG_EXT.has(ext)) return ['t-img', SVG.img];
  if (CONF_EXT.has(ext)) return ['t-conf', SVG.conf];
  if (DOC_EXT.has(ext)) return ['t-doc', SVG.doc];
  return ['', SVG.file];
}

async function fetchDir(rel) {
  const r = await fetch('/api/tree?path=' + encodeURIComponent(rel) + '&hidden=' + (showHidden ? 1 : 0));
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

function makeRow(e, parentRel) {
  const rel = parentRel ? parentRel + '/' + e.name : e.name;
  const li = document.createElement('li');
  liByRel.set(rel, li);
  const row = document.createElement('div');
  row.className = 'row ' + e.type;
  if (e.type === 'dir') {
    const b = document.createElement('button');
    b.className = 'chev'; b.innerHTML = SVG.chev;
    b.title = '開閉'; b.setAttribute('aria-label', e.name + ' を開閉');
    b.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(li, rel); });
    row.appendChild(b);
  } else {
    const s = document.createElement('span'); s.className = 'chev'; row.appendChild(s);
  }
  const [cls, svg] = iconFor(e);
  const ico = document.createElement('span'); ico.className = 'ico ' + cls; ico.innerHTML = svg;
  row.appendChild(ico);
  const name = document.createElement('span'); name.className = 'name';
  name.textContent = e.name; name.title = e.name;
  row.appendChild(name);
  if (e.type === 'file') {
    const ext = (e.name.split('.').pop() || '').toLowerCase();
    const isMd = MD_EXT.has(ext), isImg = IMG_EXT.has(ext), isPdf = ext === 'pdf';
    const vb = document.createElement('button');
    vb.className = 'mdbtn';
    vb.innerHTML = isMd ? SVG.book : (isImg || isPdf) ? SVG.img : SVG.eye;
    vb.title = isMd ? 'markdown ビューアで開く' : (isImg || isPdf) ? '画像を表示' : 'コードを表示';
    vb.setAttribute('aria-label', e.name + ' をプレビュー');
    vb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (isMd) openMd(rel);
      else if (isPdf) location.href = '/raw?path=' + encodeURIComponent(rel);
      else if (isImg) location.href = '/img?path=' + encodeURIComponent(rel);
      else location.href = '/code?path=' + encodeURIComponent(rel);
    });
    row.appendChild(vb);
  }
  const hint = document.createElement('span'); hint.className = 'copy-hint'; hint.textContent = 'copy';
  row.appendChild(hint);
  row.addEventListener('click', () => copyPath(rel, row));
  li.appendChild(row);
  return li;
}

function renderInto(ul, rel, data) {
  ul.textContent = '';
  for (const e of data.entries) ul.appendChild(makeRow(e, rel));
  if (data.omitted > 0) {
    const li = document.createElement('li'); li.className = 'more';
    li.textContent = '… 他 ' + data.omitted + ' 件 (表示上限)';
    ul.appendChild(li);
  }
}

async function toggle(li, rel) {
  const cur = li.querySelector(':scope > ul');
  if (cur) {
    cur.remove(); li.classList.remove('open');
    for (const k of [...expanded.keys()]) if (k === rel || k.startsWith(rel + '/')) expanded.delete(k);
    return;
  }
  const ul = document.createElement('ul');
  li.appendChild(ul); li.classList.add('open');
  expanded.set(rel, ul);
  try { renderInto(ul, rel, await fetchDir(rel)); }
  catch (err) { ul.innerHTML = '<li class="err">' + esc(err.message) + '</li>'; }
}

async function refreshDir(rel) {
  const ul = rel === '' ? $tree : expanded.get(rel);
  if (!ul) return;
  const desc = [...expanded.keys()]
    .filter((k) => k !== rel && (rel === '' || k.startsWith(rel + '/')))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  for (const k of desc) expanded.delete(k);
  try { renderInto(ul, rel, await fetchDir(rel)); }
  catch (err) { ul.innerHTML = '<li class="err">' + esc(err.message) + '</li>'; return; }
  for (const k of desc) {
    const li = liByRel.get(k);
    if (li && li.isConnected) await toggle(li, k);
  }
}

async function copyPath(rel, row) {
  const abs = rel ? ROOT + '/' + rel : ROOT;
  let ok = false;
  try {
    const r = await fetch('/api/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: abs })
    });
    ok = r.ok;
  } catch {}
  toast(ok ? 'コピーしました' : 'コピーに失敗しました', abs, !ok);
  if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 450); }
}

let toastTimer;
function toast(msg, sub, isErr) {
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  document.getElementById('toastPath').textContent = '\\u200e' + sub;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

async function openMd(rel) {
  const abs = rel ? ROOT + '/' + rel : ROOT;
  let ok = false;
  try {
    const r = await fetch('/api/open-md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: abs })
    });
    ok = r.ok;
  } catch {}
  if (ok) toast('cmux のビューアで開きました', abs, false);
  else location.href = '/md?path=' + encodeURIComponent(rel); // フォールバック: 内蔵ビューア
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

document.getElementById('rootName').addEventListener('click', () => copyPath('', null));
document.getElementById('btnReload').addEventListener('click', () => refreshDir(''));
document.getElementById('btnHidden').addEventListener('click', (ev) => {
  showHidden = !showHidden;
  ev.currentTarget.classList.toggle('on', showHidden);
  refreshDir('');
});

const es = new EventSource('/api/events');
es.onmessage = (ev) => {
  try {
    const { dir } = JSON.parse(ev.data);
    if (dir === '' || expanded.has(dir)) refreshDir(dir);
  } catch {}
};

refreshDir('');
</script>
</body>
</html>`;
}

// markdown ビューア/エディタで共有するテーマ変数 + リセット
const MD_THEME_CSS = `:root {
  --bg: #101312; --bg-raise: #171b19; --text: #d7dcd3; --dim: #8d968b;
  --faint: #5c6459; --accent: #e2a656; --accent-soft: rgba(226,166,86,.14);
  --border: #262d27;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f5f2ea; --bg-raise: #ede9de; --text: #33372f; --dim: #6d7367;
    --faint: #9aa090; --accent: #a86a1e; --accent-soft: rgba(168,106,30,.12); --border: #d5cfbf; }
}
* { box-sizing: border-box; margin: 0; padding: 0; }`;

// レンダリング済み markdown の見た目 (ビューアとエディタのプレビューで共有)
const MD_ARTICLE_CSS = `article { max-width: 760px; padding: 22px 18px 60px; margin: 0 auto;
  font-family: var(--md-font, "Hiragino Sans", ui-monospace, "SF Mono", Menlo, sans-serif); }
article h1, article h2, article h3, article h4 {
  text-wrap: balance; word-break: auto-phrase; overflow-wrap: normal;
  color: var(--text); margin: 1.4em 0 .5em; line-height: 1.4;
}
article h1 { font-size: 21px; font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: .35em; }
article h2 { font-size: 18px; font-weight: 700; color: var(--accent); }
article h3 { font-size: 15.5px; font-weight: 700; }
article p, article li, article blockquote {
  text-wrap: pretty; word-break: auto-phrase; overflow-wrap: normal;
}
article p { margin: .6em 0; }
article ul, article ol { margin: .6em 0; padding-left: 1.5em; }
article code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13.5px;
  background: var(--bg-raise); border: 1px solid var(--border);
  border-radius: 4px; padding: 0 4px;
}
article pre {
  background: var(--bg-raise); border: 1px solid var(--border); border-radius: 7px;
  padding: 12px 14px; overflow-x: auto; margin: .8em 0;
}
article pre code { background: none; border: 0; padding: 0; font-size: 13px; line-height: 1.7; }
article pre.mermaid {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px;
  line-height: 1.7; white-space: pre-wrap; color: var(--dim);
}
article pre.mermaid[data-processed] {
  background: none; border: 0; padding: 8px 0; text-align: center;
  white-space: normal; line-height: 1.5; overflow-x: auto;
}
article pre.mermaid[data-processed] svg { max-width: 100%; height: auto; }
.math-display { display: block; text-align: center; margin: .9em 0; overflow-x: auto; overflow-y: hidden; }
.katex { color: var(--text); }
.katex-error { color: var(--accent) !important; }
article blockquote { border-left: 3px solid var(--accent); padding: 2px 0 2px 14px; color: var(--dim); margin: .8em 0; }
article hr { border: 0; border-top: 1px solid var(--border); margin: 1.6em 0; }
article a { color: var(--accent); }
.tblwrap { overflow-x: auto; margin: .8em 0; }
article table { border-collapse: collapse; font-size: 13.5px; min-width: 320px; }
article th, article td { border: 1px solid var(--border); padding: 6px 11px; text-align: left; }
article th { background: var(--bg-raise); font-weight: 700; }
@media (max-width: 340px) { article { padding: 16px 12px 50px; } body { font-size: 14px; } }`;

// mermaid + KaTeX を必要時に CDN からロードし、渡した要素内を描画する共通処理。
// window.__mdEnhance(root) は複数回呼べる (エディタのライブプレビュー用)。
// CDN 不達 / 構文エラー時は元テキストが残る (graceful fallback)
const MD_ENHANCE_JS = `<script>
(function () {
  var dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
  var MER = dark
    ? { background:'#101312', primaryColor:'#1c2320', primaryBorderColor:'#e2a656', primaryTextColor:'#e7ece3',
        secondaryColor:'#20262a', secondaryBorderColor:'#8fb3c7', secondaryTextColor:'#e7ece3',
        tertiaryColor:'#241f2b', tertiaryBorderColor:'#d2a8e0', tertiaryTextColor:'#e7ece3',
        lineColor:'#8d968b', textColor:'#d7dcd3', titleColor:'#e2a656', nodeTextColor:'#e7ece3',
        mainBkg:'#1c2320', nodeBorder:'#e2a656', clusterBkg:'#171b19', clusterBorder:'#262d27',
        edgeLabelBackground:'#171b19', labelBackground:'#171b19', actorBkg:'#1c2320', actorBorder:'#e2a656',
        actorTextColor:'#e7ece3', signalColor:'#8d968b', signalTextColor:'#e7ece3', labelBoxBkgColor:'#1c2320',
        labelBoxBorderColor:'#e2a656', labelTextColor:'#e7ece3', loopTextColor:'#e7ece3', noteBkgColor:'#241f2b',
        noteBorderColor:'#d2a8e0', noteTextColor:'#e7ece3', pie1:'#e2a656', pie2:'#8fb3c7', pie3:'#d2a8e0',
        pieTitleTextColor:'#e7ece3', pieSectionTextColor:'#e7ece3', pieStrokeColor:'#101312' }
    : { background:'#f5f2ea', primaryColor:'#ece7d8', primaryBorderColor:'#a86a1e', primaryTextColor:'#25281f',
        secondaryColor:'#e2ebe6', secondaryBorderColor:'#3d6d8a', secondaryTextColor:'#25281f',
        tertiaryColor:'#ece3ee', tertiaryBorderColor:'#7551a3', tertiaryTextColor:'#25281f',
        lineColor:'#6d7367', textColor:'#33372f', titleColor:'#a86a1e', nodeTextColor:'#25281f',
        mainBkg:'#ece7d8', nodeBorder:'#a86a1e', clusterBkg:'#ede9de', clusterBorder:'#d5cfbf',
        edgeLabelBackground:'#ede9de', labelBackground:'#ede9de', actorBkg:'#ece7d8', actorBorder:'#a86a1e',
        actorTextColor:'#25281f', signalColor:'#6d7367', signalTextColor:'#25281f', labelBoxBkgColor:'#ece7d8',
        labelBoxBorderColor:'#a86a1e', labelTextColor:'#25281f', loopTextColor:'#25281f', noteBkgColor:'#ece3ee',
        noteBorderColor:'#7551a3', noteTextColor:'#25281f', pie1:'#a86a1e', pie2:'#3d6d8a', pie3:'#7551a3',
        pieTitleTextColor:'#25281f', pieSectionTextColor:'#25281f', pieStrokeColor:'#f5f2ea' };
  var mermaidP = null, katexP = null;
  function loadJs(src){ return new Promise(function(res,rej){ var s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
  function loadCss(href){ var l=document.createElement('link'); l.rel='stylesheet'; l.href=href; document.head.appendChild(l); }
  window.__mdEnhance = function (root) {
    root = root || document;
    var mer = root.querySelectorAll('pre.mermaid');
    if (mer.length) {
      if (!mermaidP) mermaidP = loadJs('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js').then(function () {
        if (typeof mermaid !== 'undefined') mermaid.initialize({ startOnLoad:false, securityLevel:'strict',
          fontFamily:'"Hiragino Sans", ui-monospace, "SF Mono", Menlo, sans-serif', theme:'base', themeVariables: MER });
      });
      mermaidP.then(function () { try { if (typeof mermaid !== 'undefined') mermaid.run({ nodes: mer }); } catch (e) {} });
    }
    var math = root.querySelectorAll('.math');
    if (math.length) {
      if (!katexP) { loadCss('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css'); katexP = loadJs('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js'); }
      katexP.then(function () {
        if (typeof katex === 'undefined') return;
        math.forEach(function (el) { try { katex.render(el.textContent, el, { displayMode: el.classList.contains('math-display'), throwOnError:false, errorColor:'var(--accent)' }); } catch (e) {} });
      });
    }
  };
})();
</script>`;

// in-page markdown ビューアページ (ネイティブビューアが使えない時のフォールバック)
function renderMdPage(root, rel, bodyHtml) {
  const name = rel.split('/').pop();
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — ctree</title>
<style>
${MD_THEME_CSS}
body {
  background: var(--bg); color: var(--text);
  font-family: "Hiragino Sans", ui-monospace, "SF Mono", Menlo, sans-serif;
  font-size: 15px; font-weight: 500; line-height: 1.85;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "palt", "calt"; line-break: strict;
  overflow-x: hidden;
}
.bar {
  position: sticky; top: 0; display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; background: color-mix(in srgb, var(--bg) 90%, transparent);
  backdrop-filter: blur(6px); border-bottom: 1px solid var(--border);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px;
}
.bar a { color: var(--accent); text-decoration: none; font-weight: 700; white-space: nowrap; }
.bar .fn { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
${MD_ARTICLE_CSS}
/* --- フォント切り替え: article に --md-font を適用 (コード/数式は等幅を保つ) --- */
article { font-family: var(--md-font, "Hiragino Sans", ui-monospace, "SF Mono", Menlo, sans-serif); }
html[data-mdfont="mincho"]   { --md-font: "Hiragino Mincho ProN", "YuMincho", "Yu Mincho", serif; }
html[data-mdfont="yugothic"] { --md-font: "YuGothic", "Yu Gothic", "Hiragino Sans", sans-serif; }
html[data-mdfont="mono"]     { --md-font: ui-monospace, "SF Mono", Menlo, "Hiragino Sans", monospace; }
/* --- 縦書き: article 本文のみ縦組みにし、図表・コード・数式は横組みに戻す --- */
html.vertical article {
  writing-mode: vertical-rl; text-orientation: mixed;
  max-width: none; margin: 0; height: calc(100vh - 42px);
  padding: 26px 22px; overflow-x: auto; overflow-y: hidden;
  line-height: 2.05; letter-spacing: .02em;
}
html.vertical article pre,
html.vertical article .tblwrap,
html.vertical article table,
html.vertical article .math-display,
html.vertical article pre.mermaid { writing-mode: horizontal-tb; text-orientation: mixed; }
html.vertical article h1 { border-bottom: 0; border-left: 2px solid var(--border); padding: 0 0 0 .35em; }
html.vertical article hr { border-top: 0; border-right: 1px solid var(--border); width: 0; height: auto; margin: 0 1.4em; }
/* 縦書きは横スクロールで読むので、ペインで隠れがちな横バーを常時見せる */
html.vertical article { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
html.vertical article::-webkit-scrollbar { height: 10px; }
html.vertical article::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; }
html.vertical article::-webkit-scrollbar-thumb:hover { background: var(--faint); }
html.vertical article::-webkit-scrollbar-track { background: transparent; }
/* --- ツールバーの切替コントロール --- */
.bar .ctl { margin-left: auto; display: flex; gap: 6px; align-items: center; flex: none; }
.bar select, .bar button {
  font: inherit; font-size: 12px; color: var(--text);
  background: var(--bg-raise); border: 1px solid var(--border);
  border-radius: 5px; padding: 3px 6px; cursor: pointer;
}
.bar select { max-width: 92px; }
.bar button { min-width: 32px; font-weight: 700; }
.bar button.on { color: var(--accent); border-color: var(--accent); }
</style>
<script>
// 保存済みの表示設定を描画前に適用 (リロード時のちらつき防止)
(function () {
  try {
    var d = document.documentElement;
    var f = localStorage.getItem('ctree.mdfont');
    if (f && f !== 'gothic') d.setAttribute('data-mdfont', f);
    if (localStorage.getItem('ctree.vertical') === '1') d.classList.add('vertical');
  } catch (e) {}
})();
</script>
</head>
<body>
<div class="bar"><a href="/">← ツリー</a><span class="fn" title="${escapeHtml(rel)}">${escapeHtml(name)}</span><span class="ctl"><a href="/edit?path=${encodeURIComponent(rel)}" title="このファイルを編集">編集</a><select id="fontsel" title="フォント" aria-label="フォント"><option value="gothic">ゴシック</option><option value="mincho">明朝</option><option value="yugothic">游ゴシック</option><option value="mono">等幅</option></select><button id="vtoggle" type="button" title="縦書きにする">縦</button></span></div>
<article>${bodyHtml}</article>
<script>
// 縦書き / フォント切り替え (状態は localStorage に保存し、リロードをまたいで保持)
(function () {
  const d = document.documentElement;
  const art = document.querySelector('article');
  const sel = document.getElementById('fontsel');
  const vt = document.getElementById('vtoggle');
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  // 縦書き-rl は読み始めが右端なので、有効時はスクロールを右へ寄せる
  const alignStart = (on) => { if (on) art.scrollLeft = art.scrollWidth; };
  const setV = (on) => {
    d.classList.toggle('vertical', on);
    vt.classList.toggle('on', on);
    vt.textContent = on ? '横' : '縦';
    vt.title = on ? '横書きに戻す' : '縦書きにする';
    alignStart(on);
  };
  sel.value = d.getAttribute('data-mdfont') || 'gothic';
  setV(d.classList.contains('vertical'));
  sel.addEventListener('change', () => {
    if (sel.value === 'gothic') d.removeAttribute('data-mdfont');
    else d.setAttribute('data-mdfont', sel.value);
    save('ctree.mdfont', sel.value);
    alignStart(d.classList.contains('vertical'));
  });
  vt.addEventListener('click', () => {
    const on = !d.classList.contains('vertical');
    setV(on);
    save('ctree.vertical', on ? '1' : '0');
  });

  // --- 縦書き時の横スクロール手段 ---
  // scrollLeft の RTL 符号は Chromium 版で揺れるため方向仮定を避ける:
  //   先頭へ = scrollWidth 代入 / 末尾へ = -scrollWidth 代入 (どちらもクランプで両規約に耐える)
  //   読み進める(次の列=左) = scrollLeft を減算
  const vertical = () => d.classList.contains('vertical');

  // ① 縦ホイール / トラックパッドの縦ジェスチャを横スクロールに変換。
  //    横入力(トラックパッドの横スワイプ)はブラウザ標準に任せる
  window.addEventListener('wheel', (e) => {
    if (!vertical()) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? art.clientWidth : 1; // 行/ページ単位を px 換算
    art.scrollLeft -= e.deltaY * k;
    e.preventDefault();
  }, { passive: false });

  // ② キーボード: ← / Space / PageDown で読み進め、→ / PageUp で戻る、Home/End で端へ
  window.addEventListener('keydown', (e) => {
    if (!vertical()) return;
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const step = Math.max(80, art.clientWidth * 0.9);
    if (e.key === 'ArrowLeft' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { art.scrollLeft -= step; }
    else if (e.key === 'ArrowRight' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { art.scrollLeft += step; }
    else if (e.key === 'Home') { art.scrollLeft = art.scrollWidth; }
    else if (e.key === 'End') { art.scrollLeft = -art.scrollWidth; }
    else return;
    e.preventDefault();
  });
})();
</script>
${MD_ENHANCE_JS}
<script>window.__mdEnhance(document);</script>
<script>
// 同ディレクトリの変更でライブ更新
const PARENT = ${JSON.stringify(parent)};
new EventSource('/api/events').onmessage = (ev) => {
  try { if (JSON.parse(ev.data).dir === PARENT) location.reload(); } catch {}
};
</script>
</body>
</html>`;
}

// markdown エディタページ (左=編集 / 右=ライブプレビュー、Cmd+S で保存)
function renderEditPage(root, rel, src) {
  const name = rel.split('/').pop();
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — 編集 — ctree</title>
<style>
${MD_THEME_CSS}
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font-family: "Hiragino Sans", ui-monospace, "SF Mono", Menlo, sans-serif;
  font-size: 15px; font-weight: 500; -webkit-font-smoothing: antialiased;
  display: flex; flex-direction: column; overflow: hidden;
}
.bar {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; background: color-mix(in srgb, var(--bg) 90%, transparent);
  border-bottom: 1px solid var(--border);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px;
}
.bar a { color: var(--accent); text-decoration: none; font-weight: 700; white-space: nowrap; }
.bar .fn { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.bar .dirty { color: var(--accent); font-weight: 700; visibility: hidden; }
.bar .sp { margin-left: auto; }
.bar button {
  font: inherit; font-size: 12px; color: var(--text);
  background: var(--bg-raise); border: 1px solid var(--border);
  border-radius: 5px; padding: 3px 10px; cursor: pointer; font-weight: 700;
}
.bar button:disabled { opacity: .45; cursor: default; }
.bar button.save { color: var(--accent); border-color: var(--accent); }
.edit-wrap { flex: 1; display: flex; min-height: 0; }
.pane { flex: 1 1 50%; min-width: 0; min-height: 0; overflow: auto; }
.pane.editor { border-right: 1px solid var(--border); display: flex; }
#src {
  flex: 1; width: 100%; resize: none; border: 0; outline: none;
  background: var(--bg); color: var(--text);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13.5px; line-height: 1.75;
  padding: 16px 16px 60px; tab-size: 2; white-space: pre-wrap; overflow-wrap: normal;
}
.pane.preview { background: var(--bg); }
${MD_ARTICLE_CSS}
.pane.preview article { max-width: none; margin: 0; padding: 16px 20px 60px; }
.toast {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
  background: var(--bg-raise); border: 1px solid var(--border); color: var(--text);
  padding: 8px 16px; border-radius: 8px; font-size: 13px; opacity: 0;
  transition: opacity .2s; pointer-events: none; z-index: 5;
}
.toast.show { opacity: 1; }
.toast.err { border-color: var(--accent); color: var(--accent); }
@media (max-width: 640px) {
  .edit-wrap { flex-direction: column; }
  .pane.editor { border-right: 0; border-bottom: 1px solid var(--border); }
}
</style>
</head>
<body>
<div class="bar">
  <a href="/">← ツリー</a>
  <span class="fn" title="${escapeHtml(rel)}">${escapeHtml(name)}</span>
  <span class="dirty" id="dirty" title="未保存の変更">●</span>
  <span class="sp"></span>
  <a href="/md?path=${encodeURIComponent(rel)}" title="ビューアで開く">プレビュー画面</a>
  <button class="save" id="save" type="button" disabled>保存 <span style="opacity:.7">⌘S</span></button>
</div>
<div class="edit-wrap">
  <div class="pane editor"><textarea id="src" spellcheck="false"></textarea></div>
  <div class="pane preview"><article id="preview"></article></div>
</div>
<div class="toast" id="toast"></div>
${MD_ENHANCE_JS}
<script>
const RAW = ${JSON.stringify(src)};
const REL = ${JSON.stringify(rel)};
const ta = document.getElementById('src');
const pv = document.getElementById('preview');
const saveBtn = document.getElementById('save');
const dirtyDot = document.getElementById('dirty');
const toastEl = document.getElementById('toast');
let saved = RAW;
let toastTimer = null;
ta.value = RAW;

function toast(msg, err) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('err', !!err);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}
function setDirty() {
  const d = ta.value !== saved;
  dirtyDot.style.visibility = d ? 'visible' : 'hidden';
  saveBtn.disabled = !d;
}

let renderTimer = null;
async function render() {
  try {
    const r = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: ta.value }) });
    const j = await r.json();
    pv.innerHTML = j.html || '';
    window.__mdEnhance(pv);
  } catch (e) {}
}
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 250); }

async function save() {
  if (ta.value === saved) return;
  saveBtn.disabled = true;
  try {
    const r = await fetch('/api/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: REL, content: ta.value }) });
    const j = await r.json();
    if (r.ok && j.ok) { saved = ta.value; setDirty(); toast('保存しました'); }
    else { toast(j.error || '保存に失敗しました', true); setDirty(); }
  } catch (e) { toast('保存に失敗しました', true); setDirty(); }
}

ta.addEventListener('input', () => { setDirty(); scheduleRender(); });
// Tab はインデント挿入 (フォーカス移動を抑止)
ta.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const s = ta.selectionStart, en = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
  ta.selectionStart = ta.selectionEnd = s + 2;
  setDirty(); scheduleRender();
});
saveBtn.addEventListener('click', save);
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => {
  if (ta.value !== saved) { e.preventDefault(); e.returnValue = ''; }
});

render();
setDirty();
</script>
</body>
</html>`;
}

// ビューアページ共通の外殻 (バー + テーマ変数)
function viewerShell(rel, title, extraHead, bodyHtml) {
  const name = rel.split('/').pop();
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: #101312; --bg-raise: #171b19; --text: #d7dcd3; --dim: #8d968b;
  --faint: #5c6459; --accent: #e2a656; --accent-soft: rgba(226,166,86,.14);
  --border: #262d27;
  --tok-kw: #e2a656; --tok-str: #9fc78a; --tok-num: #d2a8e0; --tok-com: #5c6459;
  --tok-fn: #8fb3c7; --tok-attr: #c9a86e;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f5f2ea; --bg-raise: #ede9de; --text: #33372f; --dim: #6d7367;
    --faint: #9aa090; --accent: #a86a1e; --accent-soft: rgba(168,106,30,.12); --border: #d5cfbf;
    --tok-kw: #a86a1e; --tok-str: #4d7a33; --tok-num: #7551a3; --tok-com: #9aa090;
    --tok-fn: #3d6d8a; --tok-attr: #8a6a2c; }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--text);
  font-family: ui-monospace, "SF Mono", Menlo, "Hiragino Sans", monospace;
  font-size: 14px; font-weight: 500; line-height: 1.65;
  -webkit-font-smoothing: antialiased; overflow-x: hidden;
}
.bar {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; background: color-mix(in srgb, var(--bg) 90%, transparent);
  backdrop-filter: blur(6px); border-bottom: 1px solid var(--border); font-size: 13px;
}
.bar a { color: var(--accent); text-decoration: none; font-weight: 700; white-space: nowrap; }
.bar .fn { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.bar .meta { margin-left: auto; color: var(--faint); font-size: 12px; white-space: nowrap; }
${extraHead}
</style>
</head>
<body>
<div class="bar"><a href="/">← ツリー</a><span class="fn" title="${escapeHtml(rel)}">${escapeHtml(name)}</span><span class="meta" id="meta"></span></div>
${bodyHtml}
<script>
const PARENT = ${JSON.stringify(parent)};
new EventSource('/api/events').onmessage = (ev) => {
  try { if (JSON.parse(ev.data).dir === PARENT) location.reload(); } catch {}
};
</script>
</body>
</html>`;
}

// 画像ビューア
function renderImgPage(root, rel) {
  const name = rel.split('/').pop();
  const css = `
main { display: flex; align-items: center; justify-content: center; min-height: calc(100vh - 42px); padding: 20px; }
.frame {
  background:
    repeating-conic-gradient(color-mix(in srgb, var(--text) 7%, transparent) 0% 25%, transparent 0% 50%)
    0 0 / 18px 18px;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px; max-width: 100%;
}
.frame img { display: block; max-width: 100%; height: auto; }`;
  const body = `
<main><div class="frame"><img id="im" src="/raw?path=${encodeURIComponent(rel)}" alt="${escapeHtml(name)}"></div></main>
<script>
document.getElementById('im').addEventListener('load', function () {
  document.getElementById('meta').textContent = this.naturalWidth + ' × ' + this.naturalHeight;
});
</script>`;
  return viewerShell(rel, `${name} — ctree`, css, body);
}

// コードビューア: word wrap 常時有効。シンタックスハイライトは highlight.js を
// CDN から読み込み (190+ 言語)、オフライン等で読めない場合はプレーン表示のまま。
// 配色は hljs の CSS ではなく自前のテーマ変数で定義する
function renderCodePage(root, rel, text, note) {
  const name = rel.split('/').pop();
  const base = name.toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : base; // Dockerfile / Makefile 対応
  const lang = HLJS_LANG[ext] || '';
  const css = `
main { padding: 14px 0 40px; }
pre.code {
  white-space: pre-wrap;           /* word wrap */
  overflow-wrap: anywhere;
  font-size: 13px; line-height: 1.7; font-weight: 500;
  padding: 6px 16px;
}
.note { color: var(--dim); padding: 30px 16px; }
/* highlight.js トークン → 自前パレット */
.hljs-keyword, .hljs-literal, .hljs-selector-tag, .hljs-built_in, .hljs-doctag { color: var(--tok-kw); }
.hljs-string, .hljs-regexp, .hljs-addition { color: var(--tok-str); }
.hljs-number, .hljs-symbol, .hljs-bullet { color: var(--tok-num); }
.hljs-comment, .hljs-quote, .hljs-deletion, .hljs-meta { color: var(--tok-com); font-style: italic; }
.hljs-title, .hljs-section, .hljs-name, .hljs-function { color: var(--tok-fn); }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable,
.hljs-type, .hljs-selector-class, .hljs-selector-attr, .hljs-params { color: var(--tok-attr); }
.hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 700; }`;
  const body = note
    ? `<main><p class="note">${escapeHtml(note)}</p></main>`
    : `
<main><pre class="code"><code id="c"${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(text)}</code></pre></main>
<script>
(function () {
  var lines = ${JSON.stringify(text ? String(text.split('\n').length) : '0')};
  document.getElementById('meta').textContent = lines + ' 行';
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js';
  s.onload = function () {
    try { window.hljs && hljs.highlightElement(document.getElementById('c')); } catch (e) {}
  };
  s.onerror = function () {}; // オフライン時はプレーン表示のまま (word wrap は効いている)
  document.head.appendChild(s);
})();
</script>`;
  return viewerShell(rel, `${name} — ctree`, css, body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- entry

module.exports = { makeIgnoreMatcher, globToRe, listDir, safeRel, createApp, renderHtml, renderMarkdown, renderEditPage };

if (require.main === module) {
  main(process.argv).then((code) => { if (code) process.exitCode = code; });
}
