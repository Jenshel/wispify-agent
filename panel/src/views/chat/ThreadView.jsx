// panel/src/views/chat/ThreadView.jsx — renders a conversation's
// recentTurns in order (tasks.md Phase 11.1/11.2): customer messages on the
// left, bot replies on the right. A turn with mediaType starting 'image/'
// renders a real <img>; 'audio/' renders a real <audio controls> element —
// both point at the same-origin mediaUrl (src/routes/files.js), which the
// admin's existing session cookie already authenticates (credentials:
// 'include' isn't needed for a plain <img>/<audio> tag — the browser
// attaches same-origin cookies to those requests automatically).
export default function ThreadView({ conversation }) {
  const turns = conversation.recentTurns || [];

  return (
    <div className="thread-view">
      <header className="thread-header">
        <span className="thread-title">{conversation.contactName || conversation.customerPhone}</span>
        <span className="thread-phone">{conversation.customerPhone}</span>
      </header>

      <div className="thread-messages">
        {turns.length === 0 && <p className="field-hint">No messages yet.</p>}
        {turns.map((turn, i) => (
          <div key={i} className={`thread-message thread-message-${turn.role === 'user' ? 'customer' : 'bot'}`}>
            <ThreadMessageMedia turn={turn} />
            {turn.content && <p className="thread-message-text">{turn.content}</p>}
            <span className="thread-message-time">{formatTime(turn.ts)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThreadMessageMedia({ turn }) {
  if (!turn.mediaUrl) return null;
  if (turn.mediaType && turn.mediaType.startsWith('image/')) {
    return <img className="thread-message-media" src={turn.mediaUrl} alt="Sent by the customer" />;
  }
  if (turn.mediaType && turn.mediaType.startsWith('audio/')) {
    // eslint-disable-next-line jsx-a11y/media-has-caption -- inbound WhatsApp voice notes have no caption track
    return <audio className="thread-message-media" controls src={turn.mediaUrl} />;
  }
  return null;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
