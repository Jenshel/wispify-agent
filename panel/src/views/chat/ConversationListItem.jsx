// panel/src/views/chat/ConversationListItem.jsx — one row in ChatView's
// conversation list (tasks.md Phase 11.1): contact name (falls back to
// phone), last message preview, relative timestamp, unread indicator, and
// pin/archive controls. Pin/archive clicks stop propagation so they never
// also open the thread.
export default function ConversationListItem({ conversation, selected, onOpen, onTogglePin, onToggleArchive }) {
  const turns = conversation.recentTurns || [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;

  const classes = ['conversation-item'];
  if (selected) classes.push('conversation-item-selected');
  if (conversation.unread) classes.push('conversation-item-unread');

  return (
    <li className={classes.join(' ')}>
      <button type="button" className="conversation-item-main" onClick={onOpen}>
        <span className="conversation-item-name">
          {conversation.unread && <span className="unread-dot" aria-label="Unread" />}
          {conversation.contactName || conversation.customerPhone}
        </span>
        <span className="conversation-item-preview">{lastTurn ? previewText(lastTurn) : 'No messages yet'}</span>
        <span className="conversation-item-time">{relativeTime(conversation.lastClientMessageAt)}</span>
      </button>
      <div className="conversation-item-actions">
        <button
          type="button"
          className={`icon-btn${conversation.pinned ? ' icon-btn-active' : ''}`}
          title={conversation.pinned ? 'Unpin' : 'Pin'}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
        >
          {conversation.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          type="button"
          className={`icon-btn${conversation.archived ? ' icon-btn-active' : ''}`}
          title={conversation.archived ? 'Unarchive' : 'Archive'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleArchive();
          }}
        >
          {conversation.archived ? 'Unarchive' : 'Archive'}
        </button>
      </div>
    </li>
  );
}

function previewText(turn) {
  if (turn.mediaType) {
    if (turn.mediaType.startsWith('image/')) return turn.content ? `[Photo] ${turn.content}` : '[Photo]';
    if (turn.mediaType.startsWith('audio/')) return '[Audio message]';
  }
  return turn.content || '';
}

/** Cheap, dependency-free relative-time label — no date library needed for "3m"/"2h"/"1d". */
function relativeTime(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
