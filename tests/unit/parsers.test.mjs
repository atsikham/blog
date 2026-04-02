import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseMarkdown,
  parseAsciidoc,
  fmtCount,
  buildCommentTree,
  getCommentThreadState,
  migrateStoredCommentsShape,
} from "../../src/js/pure.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const postsDir = path.join(repoRoot, "src/posts");
const manifest = JSON.parse(fs.readFileSync(path.join(postsDir, "manifest.json"), "utf8"));

// ── fmtCount ──────────────────────────────────────────────────

test("fmtCount — small numbers are unchanged", () => {
  assert.equal(fmtCount(0),   "0");
  assert.equal(fmtCount(1),   "1");
  assert.equal(fmtCount(999), "999");
});

test("fmtCount — thousands get k suffix", () => {
  assert.equal(fmtCount(1_000),  "1k");
  assert.equal(fmtCount(1_200),  "1.2k");
  assert.equal(fmtCount(9_999),  "10k");
  assert.equal(fmtCount(10_000), "10k");
  // current UI intentionally rounds >= 10k to whole-k values for compactness
  assert.equal(fmtCount(12_500), "13k");
  assert.equal(fmtCount(99_900), "100k");
});

test("fmtCount — millions get m suffix", () => {
  assert.equal(fmtCount(1_000_000),  "1m");
  assert.equal(fmtCount(1_400_000),  "1.4m");
  assert.equal(fmtCount(10_000_000), "10m");
});

// ── comment tree helpers ─────────────────────────────────────

test("buildCommentTree — nests replies under their parent and keeps roots newest-first", () => {
  const comments = [
    { id: "c1", name: "Alice", text: "first",  date: "Mar 1", replyToId: null },
    { id: "c2", name: "Bob",   text: "reply",  date: "Mar 1", replyToId: "c1" },
    { id: "c3", name: "Cara",  text: "second", date: "Mar 2", replyToId: null },
    { id: "c4", name: "Dan",   text: "nested", date: "Mar 2", replyToId: "c2" },
  ];

  const { childMap, roots } = buildCommentTree(comments);
  assert.deepEqual(roots.map((c) => c.id), ["c3", "c1"]);
  assert.deepEqual((childMap.c1 || []).map((c) => c.id), ["c2"]);
  assert.deepEqual((childMap.c2 || []).map((c) => c.id), ["c4"]);
});

test("buildCommentTree — comments with missing parents fall back to roots", () => {
  const comments = [
    { id: "c1", name: "Alice", text: "root", date: "Mar 1", replyToId: null },
    { id: "c2", name: "Bob", text: "orphan", date: "Mar 1", replyToId: "missing" },
  ];
  const { childMap, roots } = buildCommentTree(comments);
  assert.deepEqual(Object.keys(childMap), []);
  assert.deepEqual(roots.map((c) => c.id), ["c2", "c1"]);
});

test("getCommentThreadState — replies are collapsed by default until expanded", () => {
  const childMap = { c1: [{ id: "c2" }, { id: "c3" }] };
  const state = getCommentThreadState("c1", childMap, new Set());
  assert.equal(state.hasChildren, true);
  assert.equal(state.childCount, 2);
  assert.equal(state.collapsed, true);
  assert.equal(state.label, "Show thread (2)");
  assert.equal(state.icon, "▶");
});

test("getCommentThreadState — explicit expanded state wins", () => {
  const childMap = { c1: [{ id: "c2" }] };
  const state = getCommentThreadState("c1", childMap, new Set(["c1"]));
  assert.equal(state.collapsed, false);
  assert.equal(state.label, "Hide thread (1)");
  assert.equal(state.icon, "▼");
});

test("migrateStoredCommentsShape — fills missing replyToId and nulls broken references", () => {
  const input = {
    post1: [
      { id: "a", name: "A", text: "root", date: "Mar 1" },
      { id: "b", name: "B", text: "reply", date: "Mar 1", replyToId: "missing" },
      { id: "c", name: "C", text: "valid", date: "Mar 1", replyToId: "a" },
    ],
  };

  const { commentsByPost, changed } = migrateStoredCommentsShape(input);
  assert.equal(changed, true);
  assert.equal(commentsByPost.post1[0].replyToId, null);
  assert.equal(commentsByPost.post1[1].replyToId, null);
  assert.equal(commentsByPost.post1[2].replyToId, "a");
});

// ── parseMarkdown ─────────────────────────────────────────────

test("parseMarkdown — headings", () => {
  const out = parseMarkdown("# H1\n## H2\n### H3");
  assert.match(out, /<h1>H1<\/h1>/);
  assert.match(out, /<h2>H2<\/h2>/);
  assert.match(out, /<h3>H3<\/h3>/);
});

test("parseMarkdown — bold and italic", () => {
  const out = parseMarkdown("**bold** and _italic_");
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
});

test("parseMarkdown — inline code is not processed for bold/italic", () => {
  const out = parseMarkdown("use `*not italic*` here");
  assert.match(out, /<code>\*not italic\*<\/code>/);
  assert.doesNotMatch(out, /<em>not italic<\/em>/);
});

test("parseMarkdown — fenced code block content is not escaped twice", () => {
  const out = parseMarkdown("```go\nfmt.Println(\"hello\")\n```");
  assert.match(out, /<pre><code class="language-go">/);
  // marked keeps the raw quotes inside code blocks; the important part is that
  // the string appears once and isn't double-escaped.
  assert.match(out, /fmt\.Println\("hello"\)/);
  assert.doesNotMatch(out, /&amp;quot;/);
});

test("parseMarkdown — nested fences inside code block are treated as content", () => {
  const out = parseMarkdown("```md\n## heading\n```go\ncode\n```\n```");
  // the inner ``` should be part of the code block, not close it early
  assert.match(out, /```go/);
  assert.doesNotMatch(out, /<h2>heading<\/h2>/);
});

test("parseMarkdown — unordered list", () => {
  const out = parseMarkdown("- one\n- two\n- three");
  assert.match(out, /<ul>/);
  assert.match(out, /<li>one<\/li>/);
  assert.match(out, /<li>three<\/li>/);
});

test("parseMarkdown — ordered list", () => {
  const out = parseMarkdown("1. first\n2. second");
  assert.match(out, /<ol>/);
  assert.match(out, /<li>first<\/li>/);
});

test("parseMarkdown — blockquote", () => {
  const out = parseMarkdown("> a quote");
  assert.match(out, /<blockquote>a quote<\/blockquote>/);
});

test("parseMarkdown — image syntax produces img tag", () => {
  const out = parseMarkdown("![my diagram](diagrams/foo.svg)");
  assert.match(out, /<img/);
  assert.match(out, /src="diagrams\/foo\.svg"/);
  assert.match(out, /alt="my diagram"/);
});

test("parseMarkdown — image is not treated as a link", () => {
  const out = parseMarkdown("![alt](foo.svg)");
  assert.doesNotMatch(out, /<a /);
});

test("parseMarkdown — link", () => {
  const out = parseMarkdown("[GitHub](https://github.com)");
  assert.match(out, /<a href="https:\/\/github\.com".*>GitHub<\/a>/);
});

test("parseMarkdown — HTML entities in text are escaped", () => {
  const out = parseMarkdown("a < b && b > c");
  assert.match(out, /a &lt; b &amp;&amp; b &gt; c/);
});

test("parseMarkdown — raw HTML blocks pass through unescaped", () => {
  const svg = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">\n  <circle cx="50" cy="50" r="40" fill="red"/>\n</svg>`;
  const out = parseMarkdown(`before\n\n${svg}\n\nafter`);
  assert.match(out, /<svg viewBox=/);
  assert.match(out, /<circle/);
  assert.doesNotMatch(out, /&lt;svg/);
});

test("parseMarkdown — bare lines become paragraphs", () => {
  const out = parseMarkdown("hello world");
  assert.match(out, /<p>hello world<\/p>/);
});

// ── parseAsciidoc ─────────────────────────────────────────────

test("parseAsciidoc — headings", () => {
  const out = parseAsciidoc("= H1\n== H2\n=== H3");
  assert.match(out, /<h1>H1<\/h1>/);
  assert.match(out, /<h2>H2<\/h2>/);
  assert.match(out, /<h3>H3<\/h3>/);
});

test("parseAsciidoc — bold and italic", () => {
  const out = parseAsciidoc("*bold* and _italic_");
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
});

test("parseAsciidoc — source block", () => {
  const out = parseAsciidoc("[source,go]\n----\nfmt.Println()\n----");
  assert.match(out, /<pre><code class="language-go">/);
  assert.match(out, /fmt\.Println\(\)/);
});

test("parseAsciidoc — admonition", () => {
  const out = parseAsciidoc("NOTE: something important");
  assert.match(out, /<blockquote><strong>NOTE:<\/strong> something important<\/blockquote>/);
});

test("parseAsciidoc — unordered list", () => {
  const out = parseAsciidoc("* one\n* two");
  assert.match(out, /<ul>/);
  assert.match(out, /<li>one<\/li>/);
});

test("parseAsciidoc — url with label", () => {
  const out = parseAsciidoc("https://github.com[GitHub]");
  assert.match(out, /<a href="https:\/\/github\.com".*>GitHub<\/a>/);
});

test("parseAsciidoc — image:: macro produces img tag", () => {
  const out = parseAsciidoc("image::diagrams/foo.svg[My diagram]");
  assert.match(out, /<img/);
  assert.match(out, /src="diagrams\/foo\.svg"/);
  assert.match(out, /alt="My diagram"/);
});

test("parseAsciidoc — image:: path is not HTML-escaped", () => {
  const out = parseAsciidoc("image::diagrams/how-this-blog-works/architecture.svg[Architecture]");
  assert.doesNotMatch(out, /&lt;img/);
  assert.match(out, /src="diagrams\/how-this-blog-works\/architecture\.svg"/);
});

test("parseAsciidoc — double-backtick inline code with backtick inside", () => {
  const out = parseAsciidoc("a regex like `` /`[\\s\\S]*?`/g `` breaks things");
  assert.match(out, /<code>/);
  assert.doesNotMatch(out, /``/);
});

test("parseAsciidoc — double-backtick takes precedence over single-backtick", () => {
  const out = parseAsciidoc("try ``a`b``");
  assert.match(out, /<code>a`b<\/code>/);
});

// ── content manifest integrity ────────────────────────────────

test("manifest — every referenced post file exists", () => {
  const missing = manifest.posts
    .map((post) => post.file)
    .filter((file) => !fs.existsSync(path.join(postsDir, file)));

  assert.deepEqual(missing, []);
});

test("posts — every AsciiDoc image reference resolves to a real file", () => {
  const imageMacro = /image::([^\[]+)\[[^\]]*]/g;
  const missing = [];

  for (const post of manifest.posts) {
    if (!post.file.endsWith(".adoc")) continue;

    const postPath = path.join(postsDir, post.file);
    const source = fs.readFileSync(postPath, "utf8");

    for (const match of source.matchAll(imageMacro)) {
      const relativeImagePath = match[1].trim();
      const imagePath = path.join(postsDir, relativeImagePath);
      if (!fs.existsSync(imagePath)) {
        missing.push({ post: post.file, image: relativeImagePath });
      }
    }
  }

  assert.deepEqual(missing, []);
});
