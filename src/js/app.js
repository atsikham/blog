// ============================================================
//  Blog Data
//
//  Post metadata  →  src/posts/manifest.json  (one entry per post)
//  Post content   →  src/posts/<file>         (.md or .adoc files)
//
//  To add a new post:
//    1. Create src/posts/5-my-new-post.md  (or .adoc) with content
//    2. Add a metadata entry to src/posts/manifest.json
// ============================================================

// ── Markdown → HTML ──────────────────────────────────────────
// uses marked (loaded from CDN) when available — handles all the edge cases
// the hand-rolled parser kept hitting (nested fences, tables, etc.)
function parseMarkdown(md) {
  // pull raw HTML blocks out before marked sees them — marked would escape
  // <svg> and similar tags even with sanitize:false in older builds
  const rawBlocks = [];
  md = md.replace(/^(<(svg|div|figure|table|details|section|article|aside)[^>]*>[\s\S]*?<\/\2>)/gm,
    (block) => { const i = rawBlocks.push(block) - 1; return `\x00RAW${i}\x00`; }
  );

  let html;
  if (typeof marked !== "undefined") {
    marked.use({ breaks: false, gfm: true });
    html = marked.parse(md);
  } else {
    // fallback — shouldn't happen once CDN loads, but keeps the page working offline
    html = md
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm,  "<h2>$1</h2>")
      .replace(/^# (.+)$/gm,   "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^(?!<).+$/gm, "<p>$&</p>");
  }

  // restore raw HTML blocks that were pulled out above
  html = html.replace(/\x00RAW(\d+)\x00/g, (_, i) => rawBlocks[+i]);
  // marked wraps placeholders in <p> — unwrap them
  html = html.replace(/<p>\x00RAW(\d+)\x00<\/p>/g, (_, i) => rawBlocks[+i]);

  return html;
}


// ── AsciiDoc → HTML ──────────────────────────────────────────
function parseAsciidoc(adoc) {
  // 1. Extract image:: macros before any other processing
  const rawImgs = [];
  adoc = adoc.replace(/^image::([^\[]+)\[([^\]]*)\]$/gm, (_, src, alt) => {
    const idx = rawImgs.push(`<img src="${src.trim()}" alt="${alt.trim()}">`) - 1;
    return `\x00IMG${idx}\x00`;
  });

  // 2. Extract source/listing blocks before HTML-escaping so code isn't mangled
  const codeBlocks = [];
  adoc = adoc.replace(
    /\[source(?:,(\w*))?\]\n-{4,}\n([\s\S]*?)\n-{4,}/g,
    (_, lang = "", code) => {
      const escaped = code.trimEnd()
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const idx = codeBlocks.push(`<pre><code class="language-${lang || "text"}">${escaped}</code></pre>`) - 1;
      return `\x00CODE${idx}\x00`;
    }
  );
  // Generic delimited blocks (no [source] header)
  adoc = adoc.replace(/^-{4,}\n([\s\S]*?)\n-{4,}$/gm, (_, code) => {
    const escaped = code.trimEnd()
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idx = codeBlocks.push(`<pre><code>${escaped}</code></pre>`) - 1;
    return `\x00CODE${idx}\x00`;
  });

  // 2b. Extract AsciiDoc tables ([cols=...]\n|===\n...\n|===)
  // Must run before HTML-escaping so pipe characters survive intact.
  const tables = [];
  // Inline-markup helper — applied per cell so markup works inside tables.
  const inlineFormat = (raw) => {
    let t = raw
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // stash inline code spans before bold/italic so `*.css` isn't mangled
    const cellSpans = [];
    const stash = (html) => { const i = cellSpans.push(html) - 1; return `\x00CS${i}\x00`; };
    t = t.replace(/``([^`].*?[^`])``/g, (_, c) => stash(`<code>${c}</code>`));
    t = t.replace(/``([^`]+)``/g,        (_, c) => stash(`<code>${c}</code>`));
    t = t.replace(/`([^`\n]+)`/g,        (_, c) => stash(`<code>${c}</code>`));
    t = t.replace(/\+([^+\n]+?)\+/g,     (_, c) => stash(`<code>${c}</code>`));
    t = t.replace(/\*\*(.+?)\*\*/g,  "<strong>$1</strong>");
    t = t.replace(/\*([^*\n]+?)\*/g, "<strong>$1</strong>");
    t = t.replace(/__(.+?)__/g,      "<em>$1</em>");
    t = t.replace(/_([^_\n]+?)_/g,   "<em>$1</em>");
    t = t.replace(/\x00CS(\d+)\x00/g, (_, i) => cellSpans[+i]);
    t = t.replace(/(https?:\/\/[^\s[]+)\[([^\]]+)\]/g,
      '<a href="$1" target="_blank" rel="noopener">$2</a>');
    return t;
  };
  adoc = adoc.replace(
    /^(\[[^\]\r\n]+\]\r?\n)?\|===\r?\n([\s\S]*?)\r?\n\|===$/gm,
    (full, attrLineRaw = "", body) => {
      const attrLine = (attrLineRaw || "").trim();
      const isHeader = /options\s*=\s*"[^"]*header[^"]*"/.test(attrLine);

      const lines = body.split(/\r?\n/);
      const rows = [];
      let cur = [];

      const flush = () => { if (cur.length) { rows.push(cur); cur = []; } };

      for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.trim()) { flush(); continue; }
        if (line.trim().startsWith("|")) {
          const cells = line.trim().split("|").slice(1).map(c => c.trim());
          if (cells.length > 1) { flush(); rows.push(cells); }
          else { cur.push(cells[0] || ""); }
        } else {
          if (!cur.length) cur.push("");
          cur[cur.length - 1] += (cur[cur.length - 1] ? " " : "") + line.trim();
        }
      }
      flush();

      if (!rows.length) return full;

      const headerRow = isHeader ? rows.shift() : null;
      const thead = headerRow
        ? `<thead><tr>${headerRow.map(c => `<th>${inlineFormat(c)}</th>`).join("")}</tr></thead>`
        : "";
      const tbody = `<tbody>${rows
        .map(r => `<tr>${r.map(c => `<td>${inlineFormat(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;

      const idx = tables.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`) - 1;
      return `\x00TABLE${idx}\x00`;
    }
  );

  // 2c. Stash inline code spans AFTER table extraction — tables handle their own
  //     inline formatting via inlineFormat per-cell. Stashing before would leave
  //     \x00SPAN..\x00 placeholders raw inside cells (inlineFormat only restores \x00CS..\x00).
  const inlineSpans = [];
  const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const stashInline = (raw) => { const idx = inlineSpans.push(raw) - 1; return `\x00SPAN${idx}\x00`; };
  adoc = adoc.replace(/``([^`].*?[^`])``/g, (_, c) => stashInline(`<code>${esc(c)}</code>`));
  adoc = adoc.replace(/``([^`]+)``/g,        (_, c) => stashInline(`<code>${esc(c)}</code>`));
  adoc = adoc.replace(/`([^`\n]+)`/g,        (_, c) => stashInline(`<code>${esc(c)}</code>`));
  adoc = adoc.replace(/\+([^+\n]+?)\+/g,     (_, c) => stashInline(`<code>${esc(c)}</code>`));

  // 3. Escape HTML entities in the remaining text
  let html = adoc
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 4. Admonitions
  html = html.replace(
    /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION): (.+)$/gm,
    (_, type, text) => `<blockquote><strong>${type}:</strong> ${text}</blockquote>`
  );

  // 5. Headings (= Title already handled as h1 by = prefix)
  html = html.replace(/^====+ (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^=== (.+)$/gm,   "<h3>$1</h3>");
  html = html.replace(/^== (.+)$/gm,    "<h2>$1</h2>");
  html = html.replace(/^= (.+)$/gm,     "<h1>$1</h1>");

  // 6. Lists — capture "* item" lines plus any soft-wrapped continuation lines
  //    (non-blank lines that don't start a new bullet / block element).
  html = html.replace(/((?:^\* .+\n?(?:^(?![*\n=\[]).+\n?)*)+)/gm, (block) => {
    const items = [];
    let cur = null;
    for (const line of block.split("\n")) {
      if (!line.trim()) continue;
      if (/^\* /.test(line)) {
        if (cur !== null) items.push(cur);
        cur = line.replace(/^\* /, "");
      } else {
        cur = (cur !== null ? cur + " " : "") + line.trim();
      }
    }
    if (cur !== null) items.push(cur);
    return `<ul>${items.map(t => `<li>${t}</li>`).join("")}</ul>`;
  });
  html = html.replace(/((?:^\. .+\n?(?:^(?![.\n=\[]).+\n?)*)+)/gm, (block) => {
    const items = [];
    let cur = null;
    for (const line of block.split("\n")) {
      if (!line.trim()) continue;
      if (/^\. /.test(line)) {
        if (cur !== null) items.push(cur);
        cur = line.replace(/^\. /, "");
      } else {
        cur = (cur !== null ? cur + " " : "") + line.trim();
      }
    }
    if (cur !== null) items.push(cur);
    return `<ol>${items.map(t => `<li>${t}</li>`).join("")}</ol>`;
  });

  // 7. Inline formatting — bold/italic only; inline code already stashed above.
  // Order matters: ** before * so **word** isn't partially consumed.
  html = html.replace(/\*\*(.+?)\*\*/g,  "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+?)\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g,      "<em>$1</em>");
  html = html.replace(/_([^_\n]+?)_/g,   "<em>$1</em>");

  // Restore inline code spans now that bold/italic is done
  html = html.replace(/\x00SPAN(\d+)\x00/g, (_, i) => inlineSpans[+i]);

  // 8. URLs with label:  https://example.com[label]
  html = html.replace(/(https?:\/\/[^\s\[]+)\[([^\]]+)\]/g,
    '<a href="$1" target="_blank" rel="noopener">$2</a>');

  // 9. Paragraphs — group consecutive plain-text lines into <p> blocks.
  // Lines starting with "<" are already block HTML; lines starting with \x00
  // are placeholders. Everything else is plain text and may be soft-wrapped
  // across multiple source lines (no blank line between them = same paragraph).
  {
    const inLines  = html.split("\n");
    const outLines = [];
    let para = [];

    const flushPara = () => {
      if (para.length) {
        outLines.push(`<p>${para.join(" ")}</p>`);
        para = [];
      }
    };

    for (const line of inLines) {
      const t = line.trim();
      if (!t) {
        // blank line → end of paragraph
        flushPara();
        outLines.push(line);
      } else if (/^</.test(t) && !/^<(strong|em|code|a)[\s>]/i.test(t) || /^\x00/.test(t)) {
        // block HTML or placeholder → flush any open paragraph first
        // (inline elements like <strong>/<em> are NOT treated as block boundaries)
        flushPara();
        outLines.push(line);
      } else {
        // plain text or inline HTML — accumulate into current paragraph
        para.push(t);
      }
    }
    flushPara();
    html = outLines.join("\n");
  }
  html = html.replace(/<p>\s*<\/p>/g, "");

  // 10. Restore code and image placeholders
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i]);
  html = html.replace(/<p>\x00CODE(\d+)\x00<\/p>/g, (_, i) => codeBlocks[+i]);
  html = html.replace(/\x00IMG(\d+)\x00/g,  (_, i) => rawImgs[+i]);
  html = html.replace(/<p>\x00IMG(\d+)\x00<\/p>/g, (_, i) => rawImgs[+i]);

  // 11. Restore table placeholders
  html = html.replace(/\x00TABLE(\d+)\x00/g,   (_, i) => tables[+i]);
  html = html.replace(/<p>\x00TABLE(\d+)\x00<\/p>/g, (_, i) => tables[+i]);

  return html;
}

// ── Dispatch by extension ────────────────────────────────────
function parseContent(text, filename) {
  const html = filename.endsWith(".adoc") || filename.endsWith(".asciidoc")
    ? parseAsciidoc(text)
    : parseMarkdown(text);

  // img src paths in posts are relative to src/posts/ — rewrite to root-relative
  // so they resolve correctly from any URL depth (/, /posts/1.html, etc.)
  return html.replace(/(<img\b[^>]*?\bsrc=")(?!https?:\/\/|\/|data:)([^"]+)"/g,
    (_, prefix, src) => `${prefix}/src/posts/${src}"`
  );
}

// ── Load posts from manifest + content files ─────────────────
async function loadPosts() {
  const manifestRes = await fetch("/src/posts/manifest.json");
  const manifest = await manifestRes.json();

  // The manifest can be the new object shape or the older bare array.
  const postMetas     = Array.isArray(manifest) ? manifest : manifest.posts;
  const globalExclude = Array.isArray(manifest) ? [] : (manifest.globalExcludeTagsFromAbout || []);
  const globalAuthors = Array.isArray(manifest) ? {} : (manifest.globalAuthors || {});

  state.globalExcludeTagsFromAbout = new Set(globalExclude);
  state.pinnedPostIds = new Set(Array.isArray(manifest) ? [] : (manifest.pinnedPostIds || []));

  // Normalise an author entry — can be a plain string or a {name,...} object.
  // Fills initials (first letter of each word, max 2) and url from globalAuthors.
  const resolveAuthor = (a) => {
    const name    = typeof a === "string" ? a : a.name;
    const global  = globalAuthors[name] || {};
    const initials = (typeof a === "object" && a.initials)
      || name.trim().split(/\s+/).map(w => w[0].toUpperCase()).join("").slice(0, 2);
    const url = (typeof a === "object" && a.url) || global.url || null;
    return { name, initials, url };
  };

  return Promise.all(
    postMetas.map(async (meta) => {
      const res  = await fetch(`/src/posts/${meta.file}`);
      const text = await res.text();
      const content = parseContent(text, meta.file);

      const wordCount = text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\[source[^\]]*\]\n-{4,}[\s\S]*?-{4,}/g, "")
        .replace(/<[^>]+>/g, " ")
        .trim().split(/\s+/).filter(Boolean).length;
      const mins    = Math.max(1, Math.round(wordCount / 200));
      const readTime = `${mins} min read`;

      const authors = (meta.authors || []).map(resolveAuthor);

      return { ...meta, authors, readTime, content };
    })
  );
}

// ============================================================
//  State
// ============================================================

const POSTS_PER_PAGE = 6;
const TAGS_VISIBLE = 10;

const state = {
  posts: [],
  currentPage: "home",
  activeFilters: new Set(),
  searchQuery: "",
  openPostId: null,
  scrollYBeforeModal: null,
  currentPaginationPage: 1,
  tagsExpanded: false,
  expandedCommentThreads: new Set(),
  globalExcludeTagsFromAbout: new Set(),
  pinnedPostIds: new Set(),
};

// formats large counts the way everyone expects: 999, 1k, 1.2k, 10k, 1m …
function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "m";
  if (n >= 1_000)     return (n / 1_000)    .toFixed(n >= 10_000     ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

function getAllTags() {
  const freq = {};
  state.posts.forEach((p) => p.tags.forEach((t) => { freq[t] = (freq[t] || 0) + 1; }));
  return Object.entries(freq)
    .sort(([a, ca], [b, cb]) => cb - ca || a.localeCompare(b))
    .map(([tag]) => tag);
}

function buildCommentTree(comments) {
  const byId = {};
  comments.forEach((c) => { byId[c.id] = c; });

  const childMap = {};
  const roots = [];
  comments.forEach((c) => {
    if (c.replyToId && byId[c.replyToId]) {
      (childMap[c.replyToId] = childMap[c.replyToId] || []).push(c);
    } else {
      roots.push(c);
    }
  });

  roots.reverse();
  return { byId, childMap, roots };
}

function getCommentThreadState(commentId, childMap, expandedSet) {
  const childCount = (childMap[commentId] || []).length;
  const hasChildren = childCount > 0;
  const collapsed = hasChildren ? !expandedSet.has(commentId) : false;
  return {
    hasChildren,
    childCount,
    collapsed,
    label: hasChildren ? (collapsed ? `Show thread (${childCount})` : `Hide thread (${childCount})`) : "",
    icon: hasChildren ? (collapsed ? "▶" : "▼") : "",
  };
}

// ============================================================
//  Render: About Tags (derived from post tag frequency)
// ============================================================

function renderAboutTags() {
  // globalExcludeTagsFromAbout is defined once at the top of manifest.json.
  // Tags in that list are excluded from the About skills cloud across every post —
  // e.g. "JavaScript" and "Architecture" are too generic to be meaningful skills.
  const excluded = state.globalExcludeTagsFromAbout;

  const freq = {};
  state.posts.forEach((p) =>
    p.tags
      .filter(t => !excluded.has(t))
      .forEach((t) => { freq[t] = (freq[t] || 0) + 1; })
  );

  // Sort by frequency descending, then alphabetically for ties
  const sorted = Object.entries(freq)
    .sort(([a, ca], [b, cb]) => cb - ca || a.localeCompare(b))
    .map(([tag, count]) => ({ tag, count }));

  const container = document.getElementById("aboutTags");
  if (!container) return;

  container.innerHTML = sorted
    .map(({ tag, count }) =>
      `<span class="post-tag" style="font-size:0.88rem;padding:5px 14px;cursor:default" title="${count} post${count !== 1 ? "s" : ""}">${tag}</span>`
    )
    .join("");
}


function showToast(message, icon = "✅") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function formatAuthors(authors) {
  // normalise: authors can be resolved objects {name,url} or raw strings
  const normalised = authors.map(a => typeof a === "string" ? { name: a, url: null } : a);
  // render each name as a link if the author has a url, otherwise plain text
  const fmt = (a) => a.url
    ? `<a href="${a.url}" target="_blank" rel="noopener" class="author-link">${a.name}</a>`
    : (a.name || "");
  const [first, second, ...rest] = normalised;
  if (normalised.length === 1) return fmt(first);
  if (normalised.length === 2) return `${fmt(first)} &amp; ${fmt(second)}`;
  return normalised.slice(0, -1).map(fmt).join(", ") + " &amp; " + fmt(normalised.at(-1));
  if (authors.length === 1) return fmt(authors[0]);
  if (authors.length === 2) return `${fmt(authors[0])} &amp; ${fmt(authors[1])}`;
  return authors.slice(0, -1).map(fmt).join(", ") + " &amp; " + fmt(authors.at(-1));
}

function renderAuthors(authors) {
  // normalise raw strings just in case
  const normalised = authors.map(a =>
    typeof a === "string"
      ? { name: a, url: null, initials: a.trim().split(/\s+/).map(w => w[0].toUpperCase()).join("").slice(0, 2) }
      : a
  );
  const extraMargin = normalised.length > 1 ? `style="margin-right:${(normalised.length - 1) * 6}px"` : "";
  return `
    <div class="avatars" ${extraMargin}>
      ${normalised.map((a) => `<div class="avatar" title="${a.name}">${a.initials}</div>`).join("")}
    </div>
    <div class="post-meta-info">
      <span class="post-author">${formatAuthors(normalised)}</span>
    </div>
  `;
}

function renderTagFilter() {
  const tags = getAllTags();
  const container = document.getElementById("tagFilter");
  const hasFilters = state.activeFilters.size > 0;

  const visibleTags = tags.slice(0, TAGS_VISIBLE);
  const hiddenTags  = tags.slice(TAGS_VISIBLE);
  const hasHidden   = hiddenTags.length > 0;

  // Always surface active tags that would otherwise be hidden, so a selected
  // tag is never invisible regardless of the collapsed state.
  const alwaysShow = new Set(
    hiddenTags.filter(t => state.activeFilters.has(t))
  );

  const tagBtn = (t) =>
    `<button class="tag-btn ${state.activeFilters.has(t) ? "active" : ""}" data-tag="${t}">${t}</button>`;

  const collapsedHiddenTags = hiddenTags.filter(t => !alwaysShow.has(t));
  const hiddenHtml = collapsedHiddenTags.map(tagBtn).join("");
  // Only show the expand button if there are tags that are actually hidden
  const hasCollapsible = hasHidden && collapsedHiddenTags.length > 0;

  container.innerHTML = `
    <button class="tag-btn ${!hasFilters ? "active" : ""}" data-tag="__all__">All Posts</button>
    ${visibleTags.map(tagBtn).join("")}
    ${[...alwaysShow].map(tagBtn).join("")}
    ${hasCollapsible ? `
      <span class="tags-overflow ${state.tagsExpanded ? "" : "tags-overflow-hidden"}">${hiddenHtml}</span>
      <button class="tag-btn tag-btn-expand" data-tag="__expand__">
        ${state.tagsExpanded ? "▲ Less" : `+${collapsedHiddenTags.length} more`}
      </button>
    ` : ""}
    ${hasFilters ? `<button class="tag-btn tag-btn-clear" data-tag="__clear__">✕ Clear</button>` : ""}
  `;

  container.querySelectorAll(".tag-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      if (tag === "__expand__") {
        state.tagsExpanded = !state.tagsExpanded;
        renderTagFilter();
        return;
      }
      if (tag === "__all__" || tag === "__clear__") {
        state.activeFilters.clear();
      } else if (state.activeFilters.has(tag)) {
        state.activeFilters.delete(tag);
      } else {
        state.activeFilters.add(tag);
      }
      state.searchQuery = "";
      state.currentPaginationPage = 1;
      const inp = document.getElementById("searchInput");
      const clr = document.getElementById("searchClear");
      if (inp) inp.value = "";
      if (clr) clr.style.display = "none";
      renderTagFilter();
      renderPostGrid();
    });
  });
}

// ============================================================
//  Render: Post Grid
// ============================================================

function renderPostGrid() {
  const q = state.searchQuery.toLowerCase().trim();

  // Tag filters run first, then search narrows the already-filtered list.
  // That makes the result feel predictable when both are active.
  let filtered = state.activeFilters.size === 0
    ? state.posts
    : state.posts.filter((p) =>
        [...state.activeFilters].every((tag) => p.tags.includes(tag))
      );

  if (q) {
    filtered = filtered.filter((p) =>
      p.title.toLowerCase().includes(q) ||
      p.excerpt.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q)) ||
      p.authors.some((a) => a.name.toLowerCase().includes(q))
    );
  }

  // When no search or tag filter is active, float pinned posts to the top
  // (preserving their relative order from pinnedPostIds).
  const isPinnedView = !q && state.activeFilters.size === 0;
  if (isPinnedView && state.pinnedPostIds.size > 0) {
    const pinned   = filtered.filter((p) => state.pinnedPostIds.has(p.id));
    const unpinned = filtered.filter((p) => !state.pinnedPostIds.has(p.id));
    // Sort pinned by the order they appear in pinnedPostIds
    const pinOrder = [...state.pinnedPostIds];
    pinned.sort((a, b) => pinOrder.indexOf(a.id) - pinOrder.indexOf(b.id));
    filtered = [...pinned, ...unpinned];
  }

  const grid = document.getElementById("postsGrid");
  const count = document.getElementById("resultsCount");

  if (count) {
    if (q || state.activeFilters.size > 0) {
      count.textContent = `${filtered.length} post${filtered.length !== 1 ? "s" : ""}`;
    } else {
      count.textContent = "";
    }
  }

  if (!filtered.length) {
    grid.innerHTML = `<p style="color:var(--text-muted);grid-column:1/-1;padding:20px 0">No posts match your search.</p>`;
    renderPagination(0, 0);
    return;
  }

  const totalPages = Math.ceil(filtered.length / POSTS_PER_PAGE);
  // Clamp currentPaginationPage in case filters reduced the total
  if (state.currentPaginationPage > totalPages) state.currentPaginationPage = totalPages;
  if (state.currentPaginationPage < 1) state.currentPaginationPage = 1;

  const start = (state.currentPaginationPage - 1) * POSTS_PER_PAGE;
  const pagePosts = filtered.slice(start, start + POSTS_PER_PAGE);

  grid.innerHTML = pagePosts.map((post) => renderPostCard(post)).join("");

  // Attach card events
  grid.querySelectorAll(".post-card[data-id]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".action-btn")) return;
      openPost(card.dataset.id);
    });
  });

  grid.querySelectorAll(".like-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLike(btn.dataset.id);
    });
  });

  grid.querySelectorAll(".comment-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPost(btn.dataset.id, true);
    });
  });

  grid.querySelectorAll(".post-tags-expand").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const hidden = btn.previousElementSibling; // .post-tags-hidden
      const expanded = hidden.classList.toggle("post-tags-visible");
      btn.textContent = expanded ? "Show less" : `+${hidden.querySelectorAll(".post-tag").length} more`;
    });
  });

  renderPagination(state.currentPaginationPage, totalPages);
}

function renderPagination(currentPage, totalPages) {
  const container = document.getElementById("pagination");
  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  const btn = (label, page, disabled, active, ariaLabel) =>
    `<button class="page-btn${active ? " active" : ""}" data-page="${page}"
      ${disabled ? "disabled" : ""} aria-label="${ariaLabel || label}"
      ${active ? 'aria-current="page"' : ""}>${label}</button>`;

  // Build page window: always show first, last, current ±1, with ellipsis gaps
  const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]
    .filter(p => p >= 1 && p <= totalPages));
  const sorted = [...pages].sort((a, b) => a - b);

  let html = btn("‹", currentPage - 1, currentPage === 1, false, "Previous page");
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += `<span class="page-ellipsis">…</span>`;
    html += btn(p, p, false, p === currentPage, `Page ${p}`);
    prev = p;
  }
  html += btn("›", currentPage + 1, currentPage === totalPages, false, "Next page");

  container.innerHTML = html;

  container.querySelectorAll(".page-btn:not([disabled])").forEach((b) => {
    b.addEventListener("click", () => {
      state.currentPaginationPage = +b.dataset.page;
      renderPostGrid();
      // scroll back to top of the grid smoothly
      document.getElementById("postsGrid")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderPostCard(post) {
  const likeCount    = Storage.getLikes(post.id);
  const liked        = Storage.isLiked(post.id);
  const commentCount = Storage.getComments(post.id).length;
  const readCount    = Storage.getReads(post.id);
  const isPinned     = state.pinnedPostIds.has(post.id);

  const TAGS_LIMIT = 5;
  const visibleTags = post.tags.slice(0, TAGS_LIMIT);
  const hiddenTags  = post.tags.slice(TAGS_LIMIT);

  const tagsHtml = `
    ${visibleTags.map((t) => `<span class="post-tag">${t}</span>`).join("")}
    ${hiddenTags.length ? `
      <span class="post-tags-hidden">
        ${hiddenTags.map((t) => `<span class="post-tag">${t}</span>`).join("")}
      </span>
      <button class="post-tags-expand" aria-label="Show all tags">+${hiddenTags.length} more</button>
    ` : ""}
  `;

  return `
    <article class="post-card${isPinned ? " post-card-pinned" : ""}" data-id="${post.id}" tabindex="0" role="button" aria-label="Read ${post.title}">
      ${isPinned ? `<div class="pinned-badge" title="Featured post">📌 Featured</div>` : ""}
      <div class="post-card-header">
        <div class="post-tags">${tagsHtml}</div>
        <h2 class="post-title">${post.title}</h2>
        <p class="post-excerpt">${post.excerpt}</p>
      </div>
      <div class="post-meta">
        ${renderAuthors(post.authors)}
        <span>${post.date}</span>
      </div>
      <div class="post-card-footer">
        <button class="action-btn like-btn ${liked ? "liked" : ""}" data-id="${post.id}" aria-label="Like this post" title="${likeCount} like${likeCount !== 1 ? "s" : ""}">
          <span>${liked ? "❤️" : "🤍"}</span>
          <span class="like-count">${fmtCount(likeCount)}</span>
        </button>
        <button class="action-btn comment-btn" data-id="${post.id}" aria-label="Comment on this post" title="${commentCount} comment${commentCount !== 1 ? "s" : ""}">
          <span>💬</span>
          <span>${fmtCount(commentCount)}</span>
        </button>
        <span class="read-time">⏱ ${post.readTime}</span>
        <span class="read-count" title="${readCount} read${readCount !== 1 ? "s" : ""}">👁 ${fmtCount(readCount)}</span>
      </div>
    </article>
  `;
}

// ============================================================
//  Render: Post Modal
// ============================================================

// Tracks the comment id currently being replied to — cleaner than form.dataset
// which can have encoding surprises with special characters in ids.
let _pendingReplyToId = null;

function openPost(postId, scrollToComments = false, skipAnimation = false) {
  const post = state.posts.find((p) => p.id === postId);
  if (!post) return;

  // Save scroll position so closing the modal returns to the same spot.
  state.scrollYBeforeModal = window.scrollY;

  // Update SEO metadata for the now-open article
  applyPostSEO(post);

  _pendingReplyToId = null; // reset on every open
  state.openPostId = postId;

  // On a normal open we write the hash so refresh/back work naturally.
  // On a restore we skip that write to avoid a second hash-driven open cycle.
  if (!skipAnimation) setHash("home", postId);

  const likeCount  = Storage.getLikes(postId);
  const liked      = Storage.isLiked(postId);
  const comments   = Storage.getComments(postId);

  // Count this view — at most once per session (see Storage.recordRead).
  Storage.recordRead(postId);
  const readCount = Storage.getReads(postId);

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  document.getElementById("modalContent").innerHTML = `
    <div class="modal-sidebar">
      <div class="modal-sidebar-top">
        <div class="modal-tags">
          ${post.tags.map((t) => `<span class="post-tag">${t}</span>`).join("")}
        </div>
        <h1 class="modal-title">${post.title}</h1>
        <div class="modal-meta">
          <div class="modal-meta-authors">
            <div class="avatars">
              ${post.authors.map((a) => `<div class="avatar" title="${a.name}">${a.initials}</div>`).join("")}
            </div>
            <div class="modal-meta-info">
              <span class="post-author">${formatAuthors(post.authors)}</span>
              <span class="modal-meta-date">${post.date} · ${post.readTime}</span>
              <span class="modal-meta-reads">👁 ${fmtCount(readCount)} read${readCount !== 1 ? "s" : ""}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-sidebar-actions">
        <button class="action-btn like-btn modal-like-btn ${liked ? "liked" : ""}" data-id="${postId}" title="${likeCount} like${likeCount !== 1 ? "s" : ""}">
          <span>${liked ? "❤️" : "🤍"}</span>
          <span class="like-label">${liked ? "Liked" : "Like"}</span>
          <span class="like-count">(${fmtCount(likeCount)})</span>
        </button>
        <button class="action-btn comment-btn scroll-to-comments">
          💬 <span>${comments.length} comment${comments.length !== 1 ? "s" : ""}</span>
        </button>
        <button class="action-btn pdf-btn" id="exportPdf">
          📄 <span>Export PDF</span>
        </button>
      </div>
    </div>
    <div class="modal-content-pane">
      <div class="modal-content-topbar">
        <button class="modal-close" id="modalClose" aria-label="Close post">✕ Close</button>
        <div class="topbar-spacer"></div>
        <button class="topbar-btn" id="modalThemeToggle" aria-label="Toggle theme" title="Switch light / dark">
          ${isDark ? "☀️" : "🌙"} <span>${isDark ? "Light" : "Dark"}</span>
        </button>
        <button class="topbar-btn topbar-comments-btn" id="toggleComments" aria-label="Toggle comments" title="Show / hide comments">
          💬 <span>Show comments</span>
        </button>
      </div>
      <button class="modal-close-float" id="modalCloseFloat" aria-label="Close post">✕ Close</button>
      <div class="modal-scroll-area">
        <div class="modal-body">${post.content}</div>
        <div class="comments-section comments-hidden" id="commentsSection">
          <div class="comments-header">
            <h3 class="comments-title">💬 Comments (${comments.length})</h3>
          </div>
          <form class="comment-form" id="commentForm" novalidate>
            <div class="comment-inputs">
              <input class="form-input" id="commentName" type="text" placeholder="Your name" required maxlength="80" />
              <input class="form-input" id="commentEmail" type="email" placeholder="Email (optional)" maxlength="120" />
            </div>
            <textarea class="form-input" id="commentText" placeholder="Share your thoughts…" required maxlength="1000"></textarea>
            <div class="char-counter"><span id="charCount">0</span> / 1000</div>
            <br/>
            <button class="submit-btn" type="submit">Post Comment</button>
          </form>
          <div class="comments-list" id="commentsList">
            ${renderCommentsList(comments)}
          </div>
        </div>
      </div>
    </div>
  `;

  // Events inside modal
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalCloseFloat").addEventListener("click", closeModal);
  document.querySelector(".modal-like-btn").onclick = () => toggleLike(postId);
  document.querySelector(".scroll-to-comments").addEventListener("click", scrollToCommentsSection);
  document.getElementById("exportPdf").addEventListener("click", () => exportPostAsPDF(post));
  document.getElementById("modalThemeToggle").addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(!isDark);
    localStorage.setItem("theme", !isDark ? "dark" : "light");
  });
  document.getElementById("toggleComments").addEventListener("click", () => {
    const section = document.getElementById("commentsSection");
    const btn = document.getElementById("toggleComments");
    if (section.classList.contains("comments-hidden")) {
      scrollToCommentsSection();
      return;
    }
    section.classList.add("comments-hidden");
    btn.classList.remove("active");
    btn.querySelector("span").textContent = "Show comments";
  });
  document.getElementById("commentForm").addEventListener("submit", (e) => {
    e.preventDefault();
    submitComment(postId);
  });
  bindCommentInteractions();


  const overlay = document.getElementById("modalOverlay");
  if (skipAnimation) {
    // On page refresh with an open post, we want the modal to appear
    // *instantly* — no fade-in, no scale animation.  Adding the .no-transition
    // class to <html> suppresses every CSS transition and animation on the
    // page for this single render cycle.
    //
    // We use a double requestAnimationFrame to remove the class: the first rAF
    // submits the no-transition frame to the compositor; the second fires after
    // the browser has actually painted it, so re-enabling transitions cannot
    // accidentally animate from the CSS initial values.
    document.documentElement.classList.add("no-transition");
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transition");
    }));
  } else {
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  if (scrollToComments) {
    requestAnimationFrame(scrollToCommentsSection);
  }
}

function renderCommentsList(comments) {
  if (!comments.length)
    return `<p class="no-comments">No comments yet — be the first! 🎉</p>`;

  const { byId, childMap, roots } = buildCommentTree(comments);

  function renderNode(comment, depth = 0) {
    const kids = childMap[comment.id] || [];
    const parent = comment.replyToId ? byId[comment.replyToId] : null;
    const threadState = getCommentThreadState(
      comment.id,
      childMap,
      state.expandedCommentThreads || new Set()
    );

    return `
      <div class="comment-node" data-comment-id="${escapeHtml(comment.id)}" data-depth="${depth}">
        <div class="comment-item">
          ${parent ? `<div class="comment-reply-label">↩ ${escapeHtml(parent.name)}</div>` : ""}
          <div class="comment-header">
            <span class="comment-author">${escapeHtml(comment.name)}</span>
            <span class="comment-date">${escapeHtml(comment.date || "")}</span>
          </div>
          <p class="comment-text">${escapeHtml(comment.text)}</p>
          <div class="comment-actions">
            <button class="reply-btn" type="button" data-id="${escapeHtml(comment.id)}" data-name="${escapeHtml(comment.name)}">↩ Reply</button>
            ${threadState.hasChildren ? `
              <button class="replies-toggle-btn" type="button" data-id="${escapeHtml(comment.id)}" aria-expanded="${threadState.collapsed ? "false" : "true"}">
                <span class="toggle-icon">${threadState.icon}</span>
                <span class="toggle-label">${threadState.label}</span>
              </button>
            ` : ""}
          </div>
        </div>
        ${threadState.hasChildren ? `
          <div class="comment-children${threadState.collapsed ? " replies-collapsed" : ""}">
            ${kids.map((kid) => `<div class="comment-branch">${renderNode(kid, depth + 1)}</div>`).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  return roots.map((root) => renderNode(root, 0)).join("");
}

function getCommentsScrollTop(scrollArea, target) {
  const areaRect = scrollArea.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return scrollArea.scrollTop + (targetRect.top - areaRect.top);
}

function scrollToCommentsSection() {
  const scrollArea = document.querySelector(".modal-scroll-area");
  const section = document.getElementById("commentsSection");
  const btn = document.getElementById("toggleComments");
  if (!scrollArea || !section) return;

  // Opening comments also updates the button state so the UI always matches
  // what is actually visible in the modal.
  if (section.classList.contains("comments-hidden")) {
    section.classList.remove("comments-hidden");
  }
  if (btn) {
    btn.classList.add("active");
    btn.querySelector("span").textContent = "Hide comments";
  }

  requestAnimationFrame(() => {
    scrollArea.scrollTo({
      top: getCommentsScrollTop(scrollArea, section),
      behavior: "smooth",
    });
  });
}

function scrollToCommentForm() {
  const scrollArea = document.querySelector(".modal-scroll-area");
  const form = document.getElementById("commentForm");
  if (!scrollArea || !form) return;

  requestAnimationFrame(() => {
    scrollArea.scrollTo({
      top: Math.max(0, getCommentsScrollTop(scrollArea, form) - 16),
      behavior: "smooth",
    });
  });
}

function bindCommentInteractions() {
  const list = document.getElementById("commentsList");
  if (!list) return;

  // Live character counter for the comment textarea
  const textarea = document.getElementById("commentText");
  const charCount = document.getElementById("charCount");
  if (textarea && charCount) {
    const update = () => {
      const len = textarea.value.length;
      charCount.textContent = len;
      charCount.closest(".char-counter").classList.toggle("char-counter-warn", len >= 900);
      charCount.closest(".char-counter").classList.toggle("char-counter-limit", len >= 1000);
    };
    textarea.addEventListener("input", update);
    update(); // sync on re-render if text was pre-filled
  }

  document.querySelectorAll(".reply-btn").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      _pendingReplyToId = id;

      const form = document.getElementById("commentForm");
      const existing = document.getElementById("replyBanner");
      if (existing) existing.remove();

      const banner = document.createElement("div");
      banner.id = "replyBanner";
      banner.className = "reply-banner";
      banner.innerHTML = `↩ Replying to <strong>${escapeHtml(name)}</strong> <button class="reply-cancel" type="button">✕</button>`;
      form.insertBefore(banner, form.firstChild);
      banner.querySelector(".reply-cancel").onclick = () => {
        _pendingReplyToId = null;
        banner.remove();
      };

      scrollToCommentForm();
      document.getElementById("commentName")?.focus();
    };
  });

  document.querySelectorAll(".replies-toggle-btn").forEach((btn) => {
    btn.onclick = () => {
      const commentId = btn.dataset.id;
      const node = btn.closest(".comment-node");
      if (!node) return;
      const children = node.querySelector(":scope > .comment-children");
      if (!children) return;

      const collapsed = children.classList.toggle("replies-collapsed");
      if (!state.expandedCommentThreads) state.expandedCommentThreads = new Set();
      if (!collapsed) state.expandedCommentThreads.add(commentId);
      else state.expandedCommentThreads.delete(commentId);

      const count = children.querySelectorAll(":scope > .comment-branch").length;
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const icon = btn.querySelector(".toggle-icon");
      const label = btn.querySelector(".toggle-label");
      if (icon) icon.textContent = collapsed ? "▶" : "▼";
      if (label) label.textContent = collapsed
        ? `Show thread (${count})`
        : `Hide thread (${count})`;
    };
  });
}

// ============================================================
//  Export to PDF
// ============================================================

function exportPostAsPDF(post) {
  const authors = formatAuthors(post.authors);
  // Strip the leading <h1> from content — the pdf-header already has the title.
  const pdfContent = post.content.replace(/^\s*<h1>[^<]*<\/h1>\s*/i, "");

  const win = window.open("", "_blank");
  win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${post.title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 11pt;
      line-height: 1.7;
      color: #18181b;
      max-width: 780px;
      margin: 0 auto;
      padding: 40px 36px;
    }

    .pdf-header { border-bottom: 2px solid #e9e5dd; padding-bottom: 20px; margin-bottom: 28px; }

    .pdf-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .pdf-tag {
      font-size: 8pt;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(55,48,163,0.2);
      color: #3730a3;
      background: rgba(55,48,163,0.06);
      letter-spacing: 0.02em;
    }

    h1 {
      font-family: 'Space Grotesk', system-ui, sans-serif;
      font-size: 22pt;
      font-weight: 700;
      line-height: 1.2;
      color: #18181b;
      margin-bottom: 14px;
    }

    .pdf-meta { font-size: 9.5pt; color: #71717a; }
    .pdf-meta strong { color: #18181b; }

    h2 {
      font-family: 'Space Grotesk', system-ui, sans-serif;
      font-size: 14pt;
      font-weight: 700;
      margin: 28px 0 8px;
      color: #18181b;
    }
    h3 {
      font-family: 'Space Grotesk', system-ui, sans-serif;
      font-size: 12pt;
      font-weight: 600;
      margin: 20px 0 6px;
    }

    p { margin-bottom: 12px; }
    ul, ol { margin: 0 0 12px 22px; }
    li { margin-bottom: 4px; }

    code {
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 9pt;
      background: #f5f3ee;
      border: 1px solid #e9e5dd;
      padding: 1px 5px;
      border-radius: 4px;
      color: #3730a3;
    }

    pre {
      background: #f5f3ee;
      border: 1px solid #e9e5dd;
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      margin-bottom: 16px;
      page-break-inside: avoid;
    }
    pre code { background: none; border: none; padding: 0; color: #18181b; font-size: 9pt; }

    blockquote {
      border-left: 3px solid #3730a3;
      padding: 8px 16px;
      margin: 16px 0;
      background: rgba(55,48,163,0.04);
      border-radius: 0 6px 6px 0;
      color: #71717a;
      font-style: italic;
    }

    .pdf-footer {
      margin-top: 40px;
      padding-top: 14px;
      border-top: 1px solid #e9e5dd;
      font-size: 8.5pt;
      color: #a1a1aa;
      display: flex;
      justify-content: space-between;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 10pt;
      table-layout: auto;
    }
    th, td { padding: 7px 12px; border: 1px solid #e9e5dd; text-align: left; word-break: break-word; }
    th { background: #f5f3ee; font-weight: 600; }

    img {
      max-width: 100%;
      max-height: 420px;
      height: auto;
      display: block;
      margin: 20px auto;
      page-break-inside: avoid;
    }

    @media print {
      body {
        padding: 0;
        max-width: none; /* let @page margins control the width */
        font-size: 10pt;
      }
      @page { margin: 15mm 15mm; }
      table {
        width: 100%;
        font-size: 9pt;
        page-break-inside: auto;
      }
      tr { page-break-inside: avoid; }
      th, td { padding: 5px 8px; }
      img {
        max-width: 100%;
        max-height: 360px;
        height: auto;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="pdf-header">
    <div class="pdf-tags">${post.tags.map((t) => `<span class="pdf-tag">${t}</span>`).join("")}</div>
    <h1>${post.title}</h1>
    <div class="pdf-meta">
      <strong>${authors}</strong> &nbsp;·&nbsp; ${post.date} &nbsp;·&nbsp; ${post.readTime}
    </div>
  </div>
  <div class="pdf-body">${pdfContent}</div>
  <div class="pdf-footer">
    <span>tikho.me</span>
    <span>Exported ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); }, 600);
    };
  </scr` + `ipt>
</body>
</html>`);
  win.document.close();
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  document.body.style.overflow = "";
  state.openPostId = null;
  _pendingReplyToId = null;
  setHash("home");
  applyHomeSEO();
  // Restore the scroll position the user was at before opening the post.
  const savedY = state.scrollYBeforeModal ?? 0;
  state.scrollYBeforeModal = null;
  window.scrollTo({ top: savedY, behavior: "instant" });
}

// ============================================================
//  Actions
// ============================================================

// Per-post cooldown prevents a rapid double-click from firing toggleLike
// twice before the first call's state update and re-render have completed,
// which would corrupt the count (increment then immediately decrement).
const _likeCooldown = new Set();

async function toggleLike(postId) {
  if (_likeCooldown.has(postId)) return;
  _likeCooldown.add(postId);
  setTimeout(() => _likeCooldown.delete(postId), 400);

  const { count, liked } = await Storage.toggleLike(postId);
  liked ? showToast("Post liked!", "❤️") : showToast("Like removed", "🤍");
  renderPostGrid();

  // Re-render the modal like button in-place rather than rebuilding the whole
  // modal, so the user's scroll position in the content pane is preserved.
  // We use btn.onclick (a property) instead of addEventListener so that
  // assigning a new handler automatically replaces the old one — addEventListener
  // would accumulate handlers on each like toggle, causing multiple toasts per click.
  if (state.openPostId === postId) {
    const btn = document.querySelector(".modal-like-btn");
    if (btn) {
      btn.className = `action-btn like-btn modal-like-btn ${liked ? "liked" : ""}`;
      btn.innerHTML = `<span>${liked ? "❤️" : "🤍"}</span><span class="like-label">${liked ? "Liked" : "Like"}</span><span class="like-count">(${fmtCount(count)})</span>`;
      btn.onclick = () => toggleLike(postId);
    }
  }
}

async function submitComment(postId) {
  const name = document.getElementById("commentName").value.trim();
  const text = document.getElementById("commentText").value.trim();

  if (!name || !text) {
    showToast("Please fill in your name and comment.", "⚠️");
    return;
  }

  const replyToId = _pendingReplyToId || null;
  _pendingReplyToId = null;

  try {
    await Storage.addComment(postId, name, text, replyToId);
  } catch (e) {
    if (e?.message === "RATE_LIMITED") {
      showToast("You're posting too fast — please wait a moment.", "⏳");
    } else {
      showToast("Comment saved locally (API unavailable).", "⚠️");
    }
    return;
  }
  showToast(replyToId ? "Reply posted!" : "Comment posted!", "💬");

  const replyBanner = document.getElementById("replyBanner");
  if (replyBanner) replyBanner.remove();

  const comments = Storage.getComments(postId);
  const list = document.getElementById("commentsList");
  if (!list) return;

  const section = document.getElementById("commentsSection");
  const toggleBtn = document.getElementById("toggleComments");
  if (section && section.classList.contains("comments-hidden")) {
    section.classList.remove("comments-hidden");
    if (toggleBtn) {
      toggleBtn.classList.add("active");
      toggleBtn.querySelector("span").textContent = "Hide comments";
    }
  }

  list.innerHTML = renderCommentsList(comments);
  bindCommentInteractions();
  document.querySelector(".comments-title").textContent = `💬 Comments (${comments.length})`;
  document.querySelector(".scroll-to-comments span").textContent =
    `${comments.length} comment${comments.length !== 1 ? "s" : ""}`;
  document.getElementById("commentForm").reset();
  const charCount = document.getElementById("charCount");
  if (charCount) {
    charCount.textContent = "0";
    charCount.closest(".char-counter").classList.remove("char-counter-warn", "char-counter-limit");
  }

  renderPostGrid();
}

// ============================================================
//  Page Navigation
// ============================================================

// Hash format:
//   #about          → about page
//   #post-{id}      → home page with post {id} open
//   (empty)         → home page
//
// Encoding the open post in the URL hash means a page refresh restores the
// exact same state — the user stays on the post they were reading.

function parseHash() {
  const hash = window.location.hash.replace("#", "").trim();
  if (hash === "about") return { page: "about", postId: null };
  if (hash.startsWith("post-")) {
    const raw = hash.slice(5);
    return { page: "home", postId: decodeURIComponent(raw) };
  }
  return { page: "home", postId: null };
}

// _settingHash is set to true immediately before we change window.location.hash
// ourselves.  The hashchange listener checks this flag and skips processing if
// we triggered the change — without this guard, our own hash writes would fire
// the listener, which would call openPost() again and cause a double-render /
// close-reopen flash.
let _settingHash = false;

const VALID_PAGES = ["home", "about"];

function setHash(page, postId = null) {
  const next = postId
    ? `post-${encodeURIComponent(postId)}`
    : (page === "about" ? "about" : "");
  const current = window.location.hash.replace("#", "");
  if (current !== next) {
    _settingHash = true;
    window.location.hash = next;
  }
}

function showPage(page, { updateHash = true, scrollToTop = true } = {}) {
  if (!VALID_PAGES.includes(page)) page = "home";
  const changing = state.currentPage !== page;
  state.currentPage = page;
  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");
  document.querySelectorAll(".nav-links a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === page);
  });
  if (updateHash) setHash(page);
  // Only scroll to top when actually navigating to a different page,
  // not when re-activating the same page (e.g. closing a modal).
  if (scrollToTop && changing) window.scrollTo({ top: 0, behavior: "smooth" });
}


// ============================================================
//  Theme Toggle
// ============================================================

function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const icon = dark ? "☀️" : "🌙";
  const label = dark ? "Light" : "Dark";
  // header toggle (icon only)
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = icon;
  // modal topbar button (icon + label)
  const modalBtn = document.getElementById("modalThemeToggle");
  if (modalBtn) modalBtn.innerHTML = `${icon} <span>${label}</span>`;
}

function initTheme() {
  // The theme (data-theme attribute + localStorage) is already applied by the
  // inline <script> in <head> before the first paint, so there is no theme
  // flash.  This function only syncs the toggle button icon and wires the
  // click handler — it must not re-apply the theme or it would overwrite the
  // already-correct value.
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = dark ? "☀️" : "🌙";
  btn?.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(!isDark);
    localStorage.setItem("theme", !isDark ? "dark" : "light");
  });
}

// ============================================================
//  Security
// ============================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
//  Init
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  // Wire up the theme toggle button.  The theme itself was set by the
  // blocking inline script in <head> before any paint occurred.
  initTheme();

  // Load posts before wiring up anything that depends on tags, excerpts,
  // or post content. If this fails, show a clear message instead of a blank grid.
  try {
    state.posts = (await loadPosts()).reverse();
  } catch (err) {
    console.error("Failed to load posts:", err);
    document.getElementById("postsGrid").innerHTML =
      `<p style="color:var(--text-muted);grid-column:1/-1">⚠️ Could not load posts. Open the site via a local server, not file://</p>`;
  }

  // Fetch server-side stats in the background.
  // The page renders first from local data, then refreshes when the API answers.
  Storage.init(state.posts.map((p) => p.id)).then(() => {
    renderPostGrid();
    renderAboutTags();
  });

  // Search
  const searchInput = document.getElementById("searchInput");
  const searchClear = document.getElementById("searchClear");

  searchInput?.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    state.currentPaginationPage = 1;
    searchClear.style.display = state.searchQuery ? "block" : "none";
    renderPostGrid();
  });

  searchClear?.addEventListener("click", () => {
    searchInput.value = "";
    state.searchQuery = "";
    state.currentPaginationPage = 1;
    searchClear.style.display = "none";
    searchInput.focus();
    renderPostGrid();
  });

  // Navigation
  document.querySelectorAll("[data-page]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      showPage(el.dataset.page);
    });
  });

  // Restore page / open post on browser back/forward
  window.addEventListener("hashchange", () => {
    if (_settingHash) { _settingHash = false; return; }
    const { page, postId } = parseHash();
    showPage(page, { updateHash: false });
    if (postId) {
      if (postId !== state.openPostId) openPost(postId);
    } else if (state.openPostId) {
      closeModal();
    }
  });

  // Close modal on overlay click
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.openPostId) closeModal();
  });

  // Keyboard open post card
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("post-card")) {
      openPost(e.target.dataset.id);
    }
  });

  renderTagFilter();
  renderPostGrid();
  renderAboutTags();

  // Restore page and open post on initial load — suppress all transitions so
  // the initial render appears instantly rather than animating in from nothing.
  // The no-transition class is removed after two animation frames (see openPost).
  document.documentElement.classList.add("no-transition");
  const { page, postId } = parseHash();
  showPage(page, { updateHash: !postId });
  if (postId) openPost(postId, false, true); // skipAnimation=true: no pop-in on refresh

  // Reveal the page only after everything is fully rendered.  The inline
  // <head> script set visibility:hidden synchronously before the first paint,
  // so the browser never displays a partially-rendered or wrong-themed page.
  document.documentElement.style.visibility = "visible";

  // Re-enable transitions after the first fully-rendered frame is committed.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove("no-transition");
  }));
});

// ============================================================
//  SEO helpers (per-article metadata for Lighthouse)
// ============================================================

const SITE = {
  name: "tikho.me",
  origin: "https://tikho.me",
  defaultDescription: "tikho.me — a personal blog about technology, engineering, and the ideas worth writing down.",
  ogImage: "https://tikho.me/src/images/og-image.svg",
};

function setMeta(nameOrProp, value) {
  if (!value) return;
  // Try property first (OG), then name (twitter/description)
  let el = document.querySelector(`meta[property='${nameOrProp}'][data-dynamic='true']`)
    || document.querySelector(`meta[name='${nameOrProp}'][data-dynamic='true']`)
    || document.querySelector(`meta[property='${nameOrProp}']`)
    || document.querySelector(`meta[name='${nameOrProp}']`);
  if (!el) {
    el = document.createElement("meta");
    if (nameOrProp.startsWith("og:")) el.setAttribute("property", nameOrProp);
    else el.setAttribute("name", nameOrProp);
    el.setAttribute("data-dynamic", "true");
    document.head.appendChild(el);
  }
  el.setAttribute("content", value);
}

function setCanonical(url) {
  if (!url) return;
  let link = document.querySelector(`link[rel='canonical'][data-dynamic='true']`) || document.querySelector("link[rel='canonical']");
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    link.setAttribute("data-dynamic", "true");
    document.head.appendChild(link);
  }
  link.setAttribute("href", url);
}

function parseManifestDateToISO(dateStr) {
  // manifest format: "Apr 2, 2026" — convert to ISO date
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function postUrl(post) {
  // Prefer prerendered, crawlable URLs. These pages set location.hash and load the SPA.
  return `${SITE.origin}/posts/${encodeURIComponent(post.id)}.html`;
}

function applyHomeSEO() {
  document.title = SITE.name;
  setMeta("description", SITE.defaultDescription);
  setCanonical(SITE.origin + "/");

  setMeta("og:type", "website");
  setMeta("og:url", SITE.origin + "/");
  setMeta("og:title", SITE.name);
  setMeta("og:description", SITE.defaultDescription);
  setMeta("twitter:title", SITE.name);
  setMeta("twitter:description", SITE.defaultDescription);

  const jsonLdEl = document.getElementById("jsonld-article");
  if (jsonLdEl) jsonLdEl.textContent = "";
}

function applyPostSEO(post) {
  if (!post) return;

  const title = `${post.title} | ${SITE.name}`;
  const desc = (post.excerpt || "").trim() || SITE.defaultDescription;
  const url = postUrl(post);

  document.title = title;
  setMeta("description", desc);
  setCanonical(url);

  setMeta("og:type", "article");
  setMeta("og:url", url);
  setMeta("og:title", title);
  setMeta("og:description", desc);

  setMeta("twitter:title", title);
  setMeta("twitter:description", desc);

  // JSON-LD Article schema
  const published = parseManifestDateToISO(post.date);
  const json = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: desc,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": url,
    },
    url,
    image: [SITE.ogImage],
    author: (post.authors || []).map((a) => ({
      "@type": "Person",
      name: a.name,
      ...(a.url ? { url: a.url } : {}),
    })),
    ...(published ? { datePublished: published, dateModified: published } : {}),
    publisher: {
      "@type": "Organization",
      name: SITE.name,
      logo: {
        "@type": "ImageObject",
        url: `${SITE.origin}/src/images/favicon.svg`,
      },
    },
  };

  const jsonLdEl = document.getElementById("jsonld-article");
  if (jsonLdEl) jsonLdEl.textContent = JSON.stringify(json);
}

// Ensure correct SEO metadata on initial load (before any interaction)
applyHomeSEO();
