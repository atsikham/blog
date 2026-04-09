import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.mjs');

async function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, SMOKE_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let resolvedPort = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`seo smoke server did not start\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)), 5000);
    child.stdout.on('data', () => {
      const match = stdout.match(/SMOKE_SERVER_READY:(\d+)/);
      if (match) {
        resolvedPort = Number(match[1]);
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`seo smoke server exited early: ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });

  return { child, baseUrl: `http://127.0.0.1:${resolvedPort}` };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function fetchText(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} -> ${res.status}`);
  return await res.text();
}

function match1(re, s, label) {
  const m = s.match(re);
  assert.ok(m, `missing ${label}`);
  return m[1];
}

function assertHasSeo(html, { expectCanonicalIncludes }) {
  const title = match1(/<title>([^<]+)<\/title>/i, html, 'title');
  assert.ok(title.length > 0);

  const desc = match1(/<meta\s+name="description"\s+content="([^"]+)"/i, html, 'meta description');
  assert.ok(desc.length >= 50);

  const canonical = match1(/<link\s+rel="canonical"\s+href="([^"]+)"/i, html, 'canonical');
  assert.ok(
    canonical.includes(expectCanonicalIncludes),
    `canonical mismatch: ${canonical}`
  );

  const ogTitle = match1(/<meta\s+property="og:title"\s+content="([^"]+)"/i, html, 'og:title');
  const ogUrl = match1(/<meta\s+property="og:url"\s+content="([^"]+)"/i, html, 'og:url');
  assert.ok(ogTitle.length > 0);
  assert.ok(ogUrl.includes(expectCanonicalIncludes), `og:url mismatch: ${ogUrl}`);

  const twTitle = match1(/<meta\s+name="twitter:title"\s+content="([^"]+)"/i, html, 'twitter:title');
  assert.ok(twTitle.length > 0);

  assert.ok(html.includes('application/ld+json') && html.includes('jsonld-article'), 'missing JSON-LD script tag');
}

test('SEO: index.html contains required tags (base document)', async () => {
  const { child: server, baseUrl } = await startServer();
  try {
    const html = await fetchText(`${baseUrl}/index.html`);
    // Accept both with and without trailing slash.
    // (Search engines typically normalize; Lighthouse doesn't require the slash.)
    assertHasSeo(html, { expectCanonicalIncludes: 'https://tikho.me' });
  } finally {
    await stopServer(server);
  }
});

test('SEO: each prerendered post HTML has static tags (article documents)', async () => {
  // Read manifest to discover posts
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(await readFile(path.join(root, 'src/posts/manifest.json'), 'utf8'));
  const posts = Array.isArray(manifest) ? manifest : (manifest.posts || []);

  const { child: server, baseUrl } = await startServer();
  try {
    for (const p of posts) {
      const html = await fetchText(`${baseUrl}/posts/${encodeURIComponent(p.id)}.html`);
      assertHasSeo(html, { expectCanonicalIncludes: `/posts/${encodeURIComponent(p.id)}.html` });
    }
  } finally {
    await stopServer(server);
  }
});
