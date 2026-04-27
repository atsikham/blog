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

let baseIndex = await readFile(INDEX, 'utf8');

// Fix all relative asset paths so the page works from /posts/*.html
// (otherwise src/css, src/js, src/posts/… would resolve to /posts/src/… = 404)
baseIndex = baseIndex
  .replace(/(href|src)="src\//g, '$1="/src/')
  .replace(/(href|src)="([^/"#][^"]*\.(css|js|svg|png|jpg|ico|webmanifest))"/g, '$1="/$2"');

await mkdir(OUT_DIR, { recursive: true });

for (const post of posts) {
  const url = `${siteOrigin}/posts/${encodeURIComponent(post.id)}.html`;
  const title = `${post.title} | tikho.me`;
  const desc = (post.excerpt || '').trim();

  let html = baseIndex;

  // Pre-set the hash so the SPA boots directly into the correct post.
  // No redirect — the page IS the canonical URL so Googlebot can index it.
  const postHash = `post-${encodeURIComponent(post.id)}`;
  html = html.replace(/<head>/i,
    `<head>\n<script>if(!location.hash)location.hash='${postHash}';</script>`
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

// ── Prerender /about.html ─────────────────────────────────────
{
  const url = `${siteOrigin}/about.html`;
  const title = 'About | tikho.me';
  const desc = 'Anatoli Tsikhamirau — platform engineer. Working on Kubernetes, AWS, and internal developer platforms.';

  let html = baseIndex;

  // Boot SPA directly into the about page — no redirect
  html = html.replace(/<head>/i,
    `<head>\n<script>if(!location.hash)location.hash='about';</script>`
  );
  html = setTitle(html, title);
  html = setMetaTag(html, { attr: 'name', key: 'description', content: desc });
  html = setLinkCanonical(html, url);

  html = setMetaTag(html, { attr: 'property', key: 'og:type', content: 'profile' });
  html = setMetaTag(html, { attr: 'property', key: 'og:url', content: url });
  html = setMetaTag(html, { attr: 'property', key: 'og:title', content: title });
  html = setMetaTag(html, { attr: 'property', key: 'og:description', content: desc });

  html = setMetaTag(html, { attr: 'name', key: 'twitter:title', content: title });
  html = setMetaTag(html, { attr: 'name', key: 'twitter:description', content: desc });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name: 'Anatoli Tsikhamirau',
      jobTitle: 'Platform Engineer',
      url: `${siteOrigin}/about.html`,
      sameAs: [
        'https://github.com/atsikham',
        'https://www.linkedin.com/in/anatoli-tsikhamirau/',
      ],
    },
  };
  html = setJsonLd(html, jsonLd);

  await writeFile(path.join(ROOT, 'about.html'), html, 'utf8');
}

console.log(`wrote ${posts.length} prerendered pages to ${OUT_DIR}`);
