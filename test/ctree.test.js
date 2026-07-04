'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeIgnoreMatcher, listDir, safeRel, createApp, renderMarkdown } = require('../ctree.js');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctree-test-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'README.md'), '');
  fs.writeFileSync(path.join(root, '.hidden'), '');
  fs.writeFileSync(path.join(root, 'debug.log'), '');
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n*.log\n# comment\n\n');
  return root;
}

test('listDir: dir先行ソート・常時除外・gitignore・隠しファイル', () => {
  const root = makeFixture();
  const ignored = makeIgnoreMatcher(root);
  const { entries } = listDir(root, '', false, ignored);
  const names = entries.map((e) => e.name);
  assert.deepStrictEqual(names, ['src', 'README.md']); // dist/.git/node_modules/*.log/dotfile は除外
  assert.strictEqual(entries[0].type, 'dir');

  const withHidden = listDir(root, '', true, ignored).entries.map((e) => e.name);
  assert.ok(withHidden.includes('.hidden'));
  assert.ok(withHidden.includes('.gitignore'));
  assert.ok(!withHidden.includes('.git'));
});

test('makeIgnoreMatcher: dirOnly は dir のみ、glob 展開', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctree-test-'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n*.tmp\nsrc/*.gen.js\n');
  const ig = makeIgnoreMatcher(root);
  assert.strictEqual(ig('build', true), true);
  assert.strictEqual(ig('build', false), false); // dirOnly
  assert.strictEqual(ig('a.tmp', false), true);
  assert.strictEqual(ig('deep/a.tmp', false), true); // 非アンカーは basename 一致
  assert.strictEqual(ig('src/x.gen.js', false), true);
  assert.strictEqual(ig('other/x.gen.js', false), false); // アンカー付き
  assert.strictEqual(ig('node_modules', true), true); // 常時除外
});

test('safeRel: root 外は null', () => {
  const root = '/tmp/ctree-root';
  assert.strictEqual(safeRel(root, ''), '');
  assert.strictEqual(safeRel(root, 'a/b'), 'a/b');
  assert.strictEqual(safeRel(root, '../etc'), null);
  assert.strictEqual(safeRel(root, '/etc/passwd'), null);
});

test('renderMarkdown: 主要要素の変換と HTML エスケープ', () => {
  const html = renderMarkdown([
    '# 見出し1', '## 見出し2', '',
    '本文 **強調** と `code` と [リンク](https://x.jp)。',
    '', '- 項目A', '- 項目B', '', '1. 一', '2. 二', '',
    '> 引用文', '', '---', '',
    '```js', 'const x = 1 < 2;', '```', '',
    '| A | B |', '|---|---|', '| 1 | <s> |',
  ].join('\n'));
  assert.ok(html.includes('<h1>見出し1</h1>'));
  assert.ok(html.includes('<h2>見出し2</h2>'));
  assert.ok(html.includes('<strong>強調</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<a href="https://x.jp"'));
  assert.ok(html.includes('<ul>') && html.includes('<li>項目A</li>'));
  assert.ok(html.includes('<ol>') && html.includes('<li>一</li>'));
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('const x = 1 &lt; 2;')); // フェンス内エスケープ
  assert.ok(html.includes('<th>A</th>') && html.includes('<td>&lt;s&gt;</td>')); // 表 + エスケープ
});

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test('HTTP API: ping / tree / 403 / copy', async () => {
  const root = makeFixture();
  // copy は pbcopy の代わりにファイルへ書くコマンドで検証
  const sink = path.join(root, 'clip.txt');
  const copyCmd = path.join(root, 'fakecopy.sh');
  fs.writeFileSync(copyCmd, `#!/bin/sh\ncat > "${sink}"\n`);
  fs.chmodSync(copyCmd, 0o755);
  process.env.CTREE_COPY_CMD = copyCmd;

  const server = createApp(root);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ping = await req(port, 'GET', '/api/ping');
  assert.strictEqual(ping.status, 200);
  assert.strictEqual(JSON.parse(ping.body).root, root);

  const tree = await req(port, 'GET', '/api/tree?path=src');
  assert.strictEqual(tree.status, 200);
  assert.deepStrictEqual(JSON.parse(tree.body).entries.map((e) => e.name), ['index.js']);

  const out = await req(port, 'GET', '/api/tree?path=..%2F..');
  assert.strictEqual(out.status, 403);

  const target = path.join(root, 'README.md');
  const cp = await req(port, 'POST', '/api/copy', { path: target });
  assert.strictEqual(cp.status, 200);
  assert.strictEqual(fs.readFileSync(sink, 'utf8'), target);

  const cpBad = await req(port, 'POST', '/api/copy', { path: '/etc/passwd' });
  assert.strictEqual(cpBad.status, 403);

  // open-md は cmux CLI の代わりに引数を記録するコマンドで検証
  const mdSink = path.join(root, 'cmux-args.txt');
  const fakeCmux = path.join(root, 'fakecmux.sh');
  fs.writeFileSync(fakeCmux, `#!/bin/sh\necho "$@" > "${mdSink}"\n`);
  fs.chmodSync(fakeCmux, 0o755);
  process.env.CTREE_CMUX_BIN = fakeCmux;
  const mdTarget = path.join(root, 'README.md');
  const md = await req(port, 'POST', '/api/open-md', { path: mdTarget });
  assert.strictEqual(md.status, 200);
  assert.strictEqual(fs.readFileSync(mdSink, 'utf8').trim(), `markdown open ${mdTarget}`);
  const mdBad = await req(port, 'POST', '/api/open-md', { path: '/etc/hosts' });
  assert.strictEqual(mdBad.status, 403);
  delete process.env.CTREE_CMUX_BIN;

  const html = await req(port, 'GET', '/');
  assert.strictEqual(html.status, 200);
  assert.ok(html.body.includes('ターミナルでの使い方'));
  assert.ok(html.body.includes('ctree --if-cmux'));

  // 内蔵 markdown ビューア
  fs.writeFileSync(path.join(root, 'README.md'), '# Hello\n\n本文です。\n');
  const mdPage = await req(port, 'GET', '/md?path=README.md');
  assert.strictEqual(mdPage.status, 200);
  assert.ok(mdPage.body.includes('<h1>Hello</h1>'));
  assert.ok(mdPage.body.includes('← ツリー'));
  const mdOut = await req(port, 'GET', '/md?path=..%2Fetc');
  assert.strictEqual(mdOut.status, 403);

  server.close();
  delete process.env.CTREE_COPY_CMD;
});
