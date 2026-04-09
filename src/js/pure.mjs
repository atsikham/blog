// pure functions extracted from app.js so they can be imported in Node tests
// nothing browser-specific in here

export function parseMarkdown(md) {
  const codeBlocks = [];
  const rawBlocks  = [];

  // raw HTML blocks (svg, div, etc.) must be extracted before anything else —
  // the HTML-escape pass below would mangle them otherwise
  md = md.replace(/^(<(svg|div|figure|table|details|blockquote|section|article|aside)[^>]*>[\s\S]*?<\/\2>)/gm,
    (block) => {
      const idx = rawBlocks.push(block) - 1;
      return `\x00RAW${idx}\x00`;
    }
  );

  const lines = md.split(/\r?\n/);
  const out = [];
  let inCode = false, codeLang = "", codeContent = [];

  for (const line of lines) {
    if (!inCode) {
      const fence = line.match(/^```(\w*)[ \t]*$/);
      if (fence) { inCode = true; codeLang = fence[1] || ""; codeContent = []; }
      else { out.push(line); }
    } else {
      if (line.match(/^```[ \t]*$/)) {
        const escaped = codeContent.join("\n")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const idx = codeBlocks.push(`<pre><code class="language-${codeLang}">${escaped}</code></pre>`) - 1;
        out.push(`\x00CODE${idx}\x00`);
        inCode = false; codeContent = []; codeLang = "";
      } else { codeContent.push(line); }
    }
  }
  if (inCode && codeContent.length) {
    const escaped = codeContent.join("\n")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idx = codeBlocks.push(`<pre><code>${escaped}</code></pre>`) - 1;
    out.push(`\x00CODE${idx}\x00`);
  }

  let html = out.join("\n");
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inlineCodes = [];
  html = html.replace(/`([^`\r\n]+)`/g, (_, c) => {
    const idx = inlineCodes.push(`<code>${c}</code>`) - 1;
    return `\x00INLINE${idx}\x00`;
  });

  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm,  "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm,   "<h1>$1</h1>");
  html = html.replace(/((?:^[-*] .+\r?\n?)+)/gm, (block) => {
    const items = block.trim().split(/\r?\n/).map((l) => `<li>${l.replace(/^[-*] /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  html = html.replace(/((?:^\d+\. .+\r?\n?)+)/gm, (block) => {
    const items = block.trim().split(/\r?\n/).map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
    return `<ol>${items}</ol>`;
  });
  html = html.replace(/\*\*(.+?)\*\*/g,    "<strong>$1</strong>");
  html = html.replace(/\*([^*\r\n]+?)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_\r\n]+?)_/g,   "<em>$1</em>");
  html = html.replace(/!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g,
    '<img src="$2" alt="$1" style="max-width:100%;height:auto;display:block;margin:24px auto;border-radius:8px">');
  html = html.replace(/\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/^(?![ \t]*$)(?!<)(?![\x00]).+$/gm, "<p>$&</p>");
  html = html.replace(/<p>[ \t]*<\/p>/g, "");
  html = html.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCodes[+i]);
  html = html.replace(/\x00CODE(\d+)\x00/g,   (_, i) => codeBlocks[+i]);
  html = html.replace(/\x00RAW(\d+)\x00/g,    (_, i) => rawBlocks[+i]);

  return html;
}

export function parseAsciidoc(adoc) {
  const rawImgs = [];
  adoc = adoc.replace(/^image::([^\[]+)\[([^\]]*)\]$/gm, (_, src, alt) => {
    const idx = rawImgs.push(`<img src="${src.trim()}" alt="${alt.trim()}">`) - 1;
    return `\x00IMG${idx}\x00`;
  });
  const codeBlocks = [];
  adoc = adoc.replace(
    /\[source(?:,(\w*))?\]\n-{4,}\n([\s\S]*?)\n-{4,}/g,
    (_, lang = "", code) => {
      const escaped = code.trimEnd().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const idx = codeBlocks.push(`<pre><code class="language-${lang||"text"}">${escaped}</code></pre>`) - 1;
      return `\x00CODE${idx}\x00`;
    }
  );
  adoc = adoc.replace(/^-{4,}\n([\s\S]*?)\n-{4,}$/gm, (_, code) => {
    const escaped = code.trimEnd().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const idx = codeBlocks.push(`<pre><code>${escaped}</code></pre>`) - 1;
    return `\x00CODE${idx}\x00`;
  });

  // Parse simple AsciiDoc tables: |=== ... |===
  // Supports optional table attribute line right above it, e.g. [cols="1,1",options="header"]
  // Contract: a row is a line starting with `|`, cells are split by `|`.
  const tables = [];
  adoc = adoc.replace(
    /^([\[][^[\]\r\n]+[\]]\r?\n)?\|===\r?\n([\s\S]*?)\r?\n\|===$/gm,
    (full, attrLineRaw = "", body) => {
      const attrLine = (attrLineRaw || "").trim();
      const optionsHeader = /options\s*=\s*"[^"]*header[^"]*"/.test(attrLine);

      const lines = body.split(/\r?\n/);
      const rows = [];
      let currentRow = [];

      const pushRow = () => {
        if (currentRow.length) rows.push(currentRow), (currentRow = []);
      };

      for (const rawLine of lines) {
        const line = rawLine.trimRight();
        if (!line.trim()) {
          pushRow();
          continue;
        }
        if (line.trim().startsWith("|")) {
          const cells = line
            .trim()
            .split("|")
            .slice(1)
            .map((c) => c.trim());
          // If the line contains multiple cells, it's a whole row; otherwise treat it as a continuation.
          if (cells.length > 1) {
            pushRow();
            rows.push(cells);
          } else {
            currentRow.push(cells[0] || "");
          }
        } else {
          // continuation line for the last cell
          if (!currentRow.length) currentRow.push("");
          currentRow[currentRow.length - 1] += (currentRow[currentRow.length - 1] ? "\n" : "") + line.trim();
        }
      }
      pushRow();

      if (!rows.length) return full; // fall back: don't transform

      // Format inline markup inside a single cell safely:
      // stash backtick spans first so * inside them isn't bold.
      const inlineFormatCell = (raw) => {
        let t = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const cs = [];
        const s = (h) => { const i = cs.push(h) - 1; return `\x00CS${i}\x00`; };
        t = t.replace(/``([^`].*?[^`])``/g, (_, c) => s(`<code>${c}</code>`));
        t = t.replace(/``([^`]+)``/g,        (_, c) => s(`<code>${c}</code>`));
        t = t.replace(/`([^`\n]+)`/g,        (_, c) => s(`<code>${c}</code>`));
        t = t.replace(/\+([^+\n]+?)\+/g,     (_, c) => s(`<code>${c}</code>`));
        t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        t = t.replace(/\*([^*\n]+?)\*/g, "<strong>$1</strong>");
        t = t.replace(/__(.+?)__/g, "<em>$1</em>");
        t = t.replace(/_([^_\n]+?)_/g, "<em>$1</em>");
        t = t.replace(/\x00CS(\d+)\x00/g, (_, i) => cs[+i]);
        return t;
      };

      const headerRow = optionsHeader ? rows.shift() : null;
      const thead = headerRow
        ? `<thead><tr>${headerRow.map((c) => `<th>${inlineFormatCell(c)}</th>`).join("")}</tr></thead>`
        : "";
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inlineFormatCell(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;

      const idx = tables.push(`<table>${thead}${tbody}</table>`) - 1;
      return `\x00TABLE${idx}\x00`;
    }
  );

  // Stash inline code spans BEFORE HTML-escaping and bold/italic so that
  // content like `*.css` is never matched by the * regex.
  const inlineSpans = [];
  const stashSpan = (h) => { const i = inlineSpans.push(h) - 1; return `\x00SPAN${i}\x00`; };
  adoc = adoc.replace(/``([^`].*?[^`])``/g, (_, c) => stashSpan(`<code>${c}</code>`));
  adoc = adoc.replace(/``([^`]+)``/g,        (_, c) => stashSpan(`<code>${c}</code>`));
  adoc = adoc.replace(/`([^`\n]+)`/g,        (_, c) => stashSpan(`<code>${c}</code>`));
  adoc = adoc.replace(/\+([^+\n]+?)\+/g,     (_, c) => stashSpan(`<code>${c}</code>`));

  let html = adoc.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  html = html.replace(/^(NOTE|TIP|IMPORTANT|WARNING|CAUTION): (.+)$/gm,
    (_, type, text) => `<blockquote><strong>${type}:</strong> ${text}</blockquote>`);
  html = html.replace(/^====+ (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^=== (.+)$/gm,   "<h3>$1</h3>");
  html = html.replace(/^== (.+)$/gm,    "<h2>$1</h2>");
  html = html.replace(/^= (.+)$/gm,     "<h1>$1</h1>");
  html = html.replace(/((?:^\* .+\n?)+)/gm, (block) => {
    const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^\* /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  html = html.replace(/((?:^\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^\. /, "")}</li>`).join("");
    return `<ol>${items}</ol>`;
  });
  // inline bold/italic — inline code already stashed above
  html = html.replace(/\*\*(.+?)\*\*/g,  "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+?)\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g,      "<em>$1</em>");
  html = html.replace(/_([^_\n]+?)_/g,   "<em>$1</em>");
  // restore inline code spans
  html = html.replace(/\x00SPAN(\d+)\x00/g, (_, i) => inlineSpans[+i]);
  html = html.replace(/(https?:\/\/[\s\S]*?)\[([^\]]+)\]/g,
    '<a href="$1" target="_blank" rel="noopener">$2</a>');
  {
    const inLines  = html.split("\n");
    const outLines = [];
    let para = [];

    const flushPara = () => {
      if (para.length) { outLines.push(`<p>${para.join(" ")}</p>`); para = []; }
    };

    for (const line of inLines) {
      const t = line.trim();
      if (!t) {
        flushPara();
        outLines.push(line);
      } else if (/^</.test(t) || /^\x00/.test(t)) {
        flushPara();
        outLines.push(line);
      } else {
        para.push(t);
      }
    }
    flushPara();
    html = outLines.join("\n");
  }
  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i]);
  html = html.replace(/<p>\x00CODE(\d+)\x00<\/p>/g, (_, i) => codeBlocks[+i]);
  html = html.replace(/\x00IMG(\d+)\x00/g,  (_, i) => rawImgs[+i]);
  html = html.replace(/<p>\x00IMG(\d+)\x00<\/p>/g, (_, i) => rawImgs[+i]);
  html = html.replace(/\x00TABLE(\d+)\x00/g, (_, i) => tables[+i]);
  html = html.replace(/<p>\x00TABLE(\d+)\x00<\/p>/g, (_, i) => tables[+i]);


  return html;
}

export function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "m";
  if (n >= 1_000)     return (n / 1_000)    .toFixed(n >= 10_000     ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function buildCommentTree(comments) {
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

export function getCommentThreadState(commentId, childMap, expandedSet = new Set()) {
  const childCount = (childMap[commentId] || []).length;
  const hasChildren = childCount > 0;
  // default state is collapsed when a node has replies, unless explicitly expanded
  const collapsed = hasChildren ? !expandedSet.has(commentId) : false;
  return {
    hasChildren,
    childCount,
    collapsed,
    label: hasChildren
      ? (collapsed ? `Show thread (${childCount})` : `Hide thread (${childCount})`)
      : "",
    icon: hasChildren ? (collapsed ? "▶" : "▼") : "",
  };
}

export function migrateStoredCommentsShape(rawCommentsByPost) {
  const cloned = JSON.parse(JSON.stringify(rawCommentsByPost || {}));
  let changed = false;

  Object.keys(cloned).forEach((postId) => {
    const list = Array.isArray(cloned[postId]) ? cloned[postId] : [];
    const ids = new Set(list.map((c) => c.id));

    list.forEach((comment) => {
      if (typeof comment.replyToId === "undefined") {
        comment.replyToId = null;
        changed = true;
      }
      if (comment.replyToId && !ids.has(comment.replyToId)) {
        comment.replyToId = null;
        changed = true;
      }
    });
  });

  return { commentsByPost: cloned, changed };
}
