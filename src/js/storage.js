// Talks to the Lambda API when CONFIG.API_URL is set, falls back to
// localStorage when it isn't. That means local dev just works without
// any mocking, and the site still functions if the API is down.
//
// The pattern: write to localStorage first so the UI is instant, then
// sync to the server in the background. If the server has a newer value
// (e.g. likes from another device), overwrite the local cache on the
// next successful API call.

const Storage = (() => {

  const isConfigured = () =>
    typeof CONFIG !== "undefined" && CONFIG.API_URL;

  async function apiFetch(method, path, body = null) {
    const url = `${CONFIG.API_URL}${path}`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    // Surface rate-limit errors separately so callers can show a friendlier
    // message than the generic "API call failed" warning.
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (!res.ok) throw new Error(`API ${method} ${path}: ${res.status}`);
    return res.json();
  }

  const _likes    = JSON.parse(localStorage.getItem("blog_likes")    || "{}");
  const _reads    = JSON.parse(localStorage.getItem("blog_reads")    || "{}");
  const _comments = JSON.parse(localStorage.getItem("blog_comments") || "{}");

  const _save = {
    likes:    () => localStorage.setItem("blog_likes",    JSON.stringify(_likes)),
    reads:    () => localStorage.setItem("blog_reads",    JSON.stringify(_reads)),
    comments: () => localStorage.setItem("blog_comments", JSON.stringify(_comments)),
  };

  // Old local data sometimes has dangling replyToId values pointing at
  // comments that no longer exist, or undefined instead of null. Fix it once
  // at startup so the comment tree doesn't break on old browsers.
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

  // Fetch server stats once on startup and merge into the local cache.
  // The page renders immediately from local data, then re-renders once
  // the API responds. Non-fatal — if the API is down, local data is fine.
  async function init(postIds) {
    if (!isConfigured() || !postIds.length) return;
    try {
      const stats = await apiFetch("GET", `/stats?postIds=${postIds.join(",")}`);
      for (const row of stats) {
        const local = _likes[row.id] || { count: 0, liked: false };
        // Keep the local "liked" flag — it tracks whether *this browser*
        // liked the post, which the server doesn't know about.
        _likes[row.id] = { count: row.likes, liked: local.liked };
        _reads[row.id] = row.reads;
      }
      _save.likes(); _save.reads();

      // Fetch comments for all posts in parallel — no point waiting for each
      // one sequentially when they're all independent.
      await Promise.all(postIds.map(async (id) => {
        const comments = await apiFetch("GET", `/comments?postId=${id}`);
        _comments[id] = comments;
      }));
      _save.comments();
    } catch (e) {
      console.warn("Storage.init: API unavailable, using local data.", e.message);
    }
  }

  // ── likes ────────────────────────────────────────────────��────

  function getLikes(postId) {
    return (_likes[postId] || { count: 0 }).count;
  }

  // "liked" is per-browser, not per-user. Good enough for a personal blog
  // where I'm not running accounts.
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
        // Use the server's count rather than the local one — avoids drift
        // when the same person likes from two different browsers.
        entry.count = data.likes;
        _save.likes();
      } catch (e) {
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
    // sessionStorage prevents the same tab from re-counting a read on refresh,
    // but a new session (new tab, next day) counts fresh.
    const key = `read_${postId}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");

    _reads[postId] = (_reads[postId] || 0) + 1;
    _save.reads();

    if (isConfigured()) {
      try {
        const data = await apiFetch("POST", "/read", { postId });
        _reads[postId] = data.reads;
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
    // Generate a temporary local ID so replies can reference this comment
    // immediately, before the server assigns a real UUID.
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
          _comments[postId][idx] = saved;
          // Any replies that already targeted the temp ID need to be updated
          // to the real server ID, otherwise the tree breaks.
          _comments[postId].forEach(c => {
            if (c.replyToId === id) c.replyToId = saved.id;
          });
        }
        _save.comments();
        return saved;
      } catch (e) {
        if (e.message === "RATE_LIMITED") {
          // Roll back the optimistic write — the comment never made it to the
          // server, so showing it locally would be misleading.
          _comments[postId] = _comments[postId].filter(c => c.id !== id);
          _save.comments();
          throw e;
        }
        console.warn("Storage.addComment: API call failed, comment saved locally.", e.message);
      }
    }
    return comment;
  }

  return { init, getLikes, isLiked, toggleLike, getReads, recordRead, getComments, addComment };
})();

window.Storage = Storage;
