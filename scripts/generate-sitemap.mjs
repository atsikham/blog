import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const MANIFEST = path.join(ROOT, 'src/posts/manifest.json');
const OUT = path.join(ROOT, 'sitemap.xml');

const siteOrigin = process.env.SITE_ORIGIN || 'https://tikho.me';

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const posts = Array.isArray(manifest) ? manifest : (manifest.posts || []);

const urls = [
  `${siteOrigin}/`,
  `${siteOrigin}/about.html`,
  ...posts.map((p) => `${siteOrigin}/posts/${encodeURIComponent(p.id)}.html`),
];

const body = urls
  .map((u) => `  <url>\n    <loc>${xmlEscape(u)}</loc>\n  </url>`)
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  `${body}\n` +
  `</urlset>\n`;

await writeFile(OUT, xml, 'utf8');
console.log(`wrote ${OUT} with ${urls.length} urls`);
