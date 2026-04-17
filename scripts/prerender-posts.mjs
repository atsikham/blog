import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const MANIFEST = path.join(ROOT, 'src/posts/manifest.json');
const INDEX = path.join(ROOT, 'index.html');

const OUT_DIR = path.join(ROOT, 'posts');

const siteOrigin = process.env.SITE_ORIGIN || 'https://tikho.me';
const ogImage = `${siteOrigin}/src/images/og-image.svg`;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonLdForPost(post, url) {
  const d = new Date(post.date);
  const iso = isNaN(d.getTime()) ? null : d.toISOString();
  const desc = (post.excerpt || '').trim();

  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: desc,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    image: [ogImage],
    author: (post.authors || []).map((a) => ({
      '@type': 'Person',
      name: a.name,
      ...(a.url ? { url: a.url } : {}),
    })),
    ...(iso ? { datePublished: iso, dateModified: iso } : {}),
    publisher: {
      '@type': 'Organization',
      name: 'tikho.me',
      logo: { '@type': 'ImageObject', url: `${siteOrigin}/src/images/favicon.svg` },
    },
  };
}

function injectOrReplace(html, re, replacement) {
  if (re.test(html)) return html.replace(re, replacement);
  // otherwise insert before </head>
  return html.replace(/<\/head>/i, `${replacement}\n</head>`);
}

function setMetaTag(html, opts) {
  const { attr, key, content } = opts;
  const re = new RegExp(`<meta\\s+${attr}="${key}"[^>]*>`, 'i');
  const tag = `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`;
  return injectOrReplace(html, re, tag);
}

function setLinkCanonical(html, href) {
  const re = /<link\s+rel="canonical"[^>]*>/i;
  const tag = `<link rel="canonical" href="${escapeHtml(href)}" />`;
  return injectOrReplace(html, re, tag);
}

function setTitle(html, title) {
  const re = /<title>[^<]*<\/title>/i;
  const tag = `<title>${escapeHtml(title)}</title>`;
  return injectOrReplace(html, re, tag);
}

function setJsonLd(html, json) {
  const re = /<script\s+type="application\/ld\+json"\s+id="jsonld-article"[^>]*>[\s\S]*?<\/script>/i;
  const tag = `<script type="application/ld+json" id="jsonld-article">${escapeHtml(JSON.stringify(json))}</script>`;
  return injectOrReplace(html, re, tag);
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const posts = Array.isArray(manifest) ? manifest : (manifest.posts || []);
const globalAuthors = Array.isArray(manifest) ? {} : (manifest.globalAuthors || {});

// Resolve author: accepts a string name or {name,...} object.
// Fills url from globalAuthors registry if not set per-entry.
const resolveAuthor = (a) => {
  const name = typeof a === "string" ? a : a.name;
  const global = globalAuthors[name] || {};
  return { name, url: (typeof a === "object" && a.url) || global.url || null };
};

const baseIndex = await readFile(INDEX, 'utf8');

await mkdir(OUT_DIR, { recursive: true });

for (const post of posts) {
  const url = `${siteOrigin}/posts/${encodeURIComponent(post.id)}.html`;
  const title = `${post.title} | tikho.me`;
  const desc = (post.excerpt || '').trim();

  let html = baseIndex;

  // Redirect to the root SPA with the post hash.
  // Running the SPA from /posts/1.html breaks all relative asset paths
  // (src/css, src/js, src/posts/… would resolve to /posts/src/… = 404).
  // location.replace fires before any asset loads and keeps history clean
  // (the back button won't loop back to /posts/1.html).
  const postHash = `post-${encodeURIComponent(post.id)}`;
  html = html.replace(/<head>/i,
    `<head>\n<script>location.replace('/#${postHash}');</script>`
  );
  html = setTitle(html, title);
  html = setMetaTag(html, { attr: 'name', key: 'description', content: desc });
  html = setLinkCanonical(html, url);

  html = setMetaTag(html, { attr: 'property', key: 'og:type', content: 'article' });
  html = setMetaTag(html, { attr: 'property', key: 'og:url', content: url });
  html = setMetaTag(html, { attr: 'property', key: 'og:title', content: title });
  html = setMetaTag(html, { attr: 'property', key: 'og:description', content: desc });

  html = setMetaTag(html, { attr: 'name', key: 'twitter:title', content: title });
  html = setMetaTag(html, { attr: 'name', key: 'twitter:description', content: desc });

  html = setJsonLd(html, jsonLdForPost({ ...post, authors: (post.authors || []).map(resolveAuthor) }, url));

  const outPath = path.join(OUT_DIR, `${post.id}.html`);
  await writeFile(outPath, html, 'utf8');
}

console.log(`wrote ${posts.length} prerendered pages to ${OUT_DIR}`);
