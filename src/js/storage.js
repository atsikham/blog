// talks to the Lambda API when CONFIG.API_URL is set,
// falls back to localStorage when it's not — so local dev just works
//
// localStorage is always written first so the UI is instant,
// the API is just the cross-device source of truth on top of that

const Storage = (() => {

  const isConfigured = () =>
    typeof CONFIG !== "undefined" && CONFIG.API_URL;

  // just a thin fetch wrapper so I don't repeat headers everywhere
  async function apiFetch(method, path, body = null) {
    const url = `${CONFIG.API_URL}${path}`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`API ${method} ${path}: ${res.status}`);
    return res.json();
  }

  // local cache — keeps reads instant and makes the site work offline
  const _likes    = JSON.parse(localStorage.getItem("blog_likes")    || "{}");
  const _reads    = JSON.parse(localStorage.getItem("blog_reads")    || "{}");
  const _comments = JSON.parse(localStorage.getItem("blog_comments") || "{}");

  const _save = {
    likes:    () => localStorage.setItem("blog_likes",    JSON.stringify(_likes)),
    reads:    () => localStorage.setItem("blog_reads",    JSON.stringify(_reads)),
    comments: () => localStorage.setItem("blog_comments", JSON.stringify(_comments)),
  };

  // older local data can have missing or broken replyToId values.
  // fix them once on startup so the comment tree still renders sensibly.
  (function migrateComments() {
    let changed = false;

    Object.keys(_comments).forEach((postId) => {
      const list = Array.isArray(_comments[postId]) ? _comments[postId] : [];
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

    if (changed) _save.comments();
  })();

  // ── init ──────────────────────────────────────────────────────
  // pull server stats for all posts once on startup and merge into cache
  // non-fatal if it fails — local data is shown in the meantime
  async function init(postIds) {
    if (!isConfigured() || !postIds.length) return;
    try {
      // Bulk-fetch likes + reads
      const stats = await apiFetch("GET", `/stats?postIds=${postIds.join(",")}`);
      for (const row of stats) {
        const local = _likes[row.id] || { count: 0, liked: false };
        _likes[row.id] = { count: row.likes, liked: local.liked };
        _reads[row.id] = row.reads;
      }
      _save.likes(); _save.reads();

      // Fetch comments per post (parallelised)
      await Promise.all(postIds.map(async (id) => {
        const comments = await apiFetch("GET", `/comments?postId=${id}`);
        _comments[id] = comments;
      }));
      _save.comments();
    } catch (e) {
      console.warn("Storage.init: API unavailable, using local data.", e.message);
    }
  }

  // ── likes ─────────────────────────────────────────────────────

  function getLikes(postId) {
    return (_likes[postId] || { count: 0 }).count;
  }

  // "liked" is local-only — it tracks whether this browser liked the post,
  // not some global state. makes sense for a personal blog.
  function isLiked(postId) {
    return (_likes[postId] || { liked: false }).liked;
  }

  async function toggleLike(postId) {
    if (!_likes[postId]) _likes[postId] = { count: 0, liked: false };
    const entry = _likes[postId];
    entry.liked  = !entry.liked;
    entry.count  = Math.max(0, entry.count + (entry.liked ? 1 : -1));
    _save.likes();

    if (isConfigured()) {
      try {
        const data = await apiFetch("POST", "/like", { postId, liked: entry.liked });
        // trust the server count — avoids drift if someone likes from two browsers
        entry.count = data.likes;
        _save.likes();
      } catch (e) {
        // network hiccup — local count is already saved, good enough
        console.warn("Storage.toggleLike: API call failed.", e.message);
      }
    }
    return { count: entry.count, liked: entry.liked };
  }

  // ── reads ─────────────────────────────────────────────────────

  function getReads(postId) {
    return _reads[postId] || 0;
  }

  async function recordRead(postId) {
    // sessionStorage means refreshing the same tab doesn't keep adding reads,
    // but closing and coming back the next day does
    const key = `read_${postId}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");

    _reads[postId] = (_reads[postId] || 0) + 1;
    _save.reads();

    if (isConfigured()) {
      try {
        const data = await apiFetch("POST", "/read", { postId });
        _reads[postId] = data.reads;   // use server value
        _save.reads();
      } catch (e) {
        console.warn("Storage.recordRead: API call failed.", e.message);
      }
    }
  }

  // ── comments ──────────────────────────────────────────────────

  function getComments(postId) {
    return _comments[postId] || [];
  }

  async function addComment(postId, name, text, replyToId = null) {
    const date = new Date().toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
    // generate a local id so replies can reference parent comments immediately
    const id = `local_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const comment = { id, name, text, date, replyToId };

    if (!_comments[postId]) _comments[postId] = [];
    _comments[postId].push(comment);
    _save.comments();

    if (isConfigured()) {
      try {
        const saved = await apiFetch("POST", "/comments", { postId, name, text, replyToId });
        const idx = _comments[postId].findIndex(c => c.id === id);
        if (idx !== -1) {
          // Swap local comment with the server version.
          _comments[postId][idx] = saved;
          // If replies already target the temporary local id, point them at the
          // new durable server id so the UI tree stays intact.
          _comments[postId].forEach(c => {
            if (c.replyToId === id) c.replyToId = saved.id;
          });
        }
        _save.comments();
        return saved;
      } catch (e) {
        console.warn("Storage.addComment: API call failed, comment saved locally.", e.message);
      }
    }
    return comment;
  }

  return { init, getLikes, isLiked, toggleLike, getReads, recordRead, getComments, addComment };
})();

window.Storage = Storage;
