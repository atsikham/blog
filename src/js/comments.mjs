import { buildCommentTree, getCommentThreadState } from "./pure.mjs";

export function renderCommentsList(comments, expandedThreads, escapeHtml) {
  if (!comments.length) {
    return `<p class="no-comments">No comments yet — be the first! 🎉</p>`;
  }

  const { byId, childMap, roots } = buildCommentTree(comments);

  function renderNode(comment, depth = 0) {
    const kids = childMap[comment.id] || [];
    const parent = comment.replyToId ? byId[comment.replyToId] : null;
    const threadState = getCommentThreadState(comment.id, childMap, expandedThreads || new Set());

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

export function getCommentsScrollTop(scrollArea, target) {
  const areaRect = scrollArea.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return scrollArea.scrollTop + (targetRect.top - areaRect.top);
}

