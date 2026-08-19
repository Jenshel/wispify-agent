// panel/src/views/ChatView.jsx — conversation list, pin/archive/unread,
// global pause-bot control, and thread view (tasks.md Phase 11.1/11.2).
// Default post-login view (see App.jsx's tab state). Sits behind
// LoginScreen, same as SettingsView — every API call here requires an
// admin session (src/auth/middleware.js requireAuth via
// src/routes/conversations.js/settings.js).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listConversations,
  getConversationDetail,
  updateConversation,
  getAppConfig,
  updateAppConfig,
  ApiError,
} from '../api/client.js';
import ConversationListItem from './chat/ConversationListItem.jsx';
import ThreadView from './chat/ThreadView.jsx';

// Polling, not a websocket — no realtime infra exists anywhere in this repo
// (design.md keeps the dependency list minimal for this starter). 8s is a
// deliberate middle-of-the-range choice: frequent enough that a new
// message shows up without a manual refresh feeling natural for a
// single-admin panel, not so frequent it hammers the backend for a
// mono-tenant, single-bot deployment.
const POLL_INTERVAL_MS = 8000;

export default function ChatView({ username, onLogout }) {
  const [conversations, setConversations] = useState(null); // null while loading
  const [showArchived, setShowArchived] = useState(false);
  const [selectedPhone, setSelectedPhone] = useState(null);
  const [selected, setSelected] = useState(null); // full conversation detail, incl. recentTurns
  const [appConfig, setAppConfig] = useState(null);
  const [pauseToggling, setPauseToggling] = useState(false);
  const [loadError, setLoadError] = useState('');
  const pollRef = useRef(null);

  const reloadList = useCallback(async () => {
    try {
      const list = await listConversations(showArchived);
      setConversations(list);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load conversations.');
    }
  }, [showArchived]);

  useEffect(() => {
    reloadList();
    pollRef.current = setInterval(reloadList, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [reloadList]);

  useEffect(() => {
    getAppConfig()
      .then(setAppConfig)
      .catch(() => {
        // Best-effort — the pause control just stays disabled until the
        // next successful load; this must never block the conversation list.
      });
  }, []);

  const openThread = useCallback(async (phone) => {
    setSelectedPhone(phone);
    try {
      const conv = await getConversationDetail(phone);
      setSelected(conv);
      if (conv.unread) {
        const updated = await updateConversation(phone, { markRead: true });
        setSelected(updated);
        reloadList();
      }
    } catch {
      setSelected(null);
    }
  }, [reloadList]);

  const togglePin = useCallback(
    async (phone, pinned) => {
      const updated = await updateConversation(phone, { pinned });
      await reloadList();
      if (selectedPhone === phone) setSelected(updated);
    },
    [reloadList, selectedPhone]
  );

  const toggleArchive = useCallback(
    async (phone, archived) => {
      const updated = await updateConversation(phone, { archived });
      await reloadList();
      if (selectedPhone === phone) setSelected(updated);
    },
    [reloadList, selectedPhone]
  );

  const handlePauseToggle = async () => {
    if (!appConfig) return;
    setPauseToggling(true);
    try {
      const updated = await updateAppConfig({ botPaused: !appConfig.botPaused });
      setAppConfig(updated);
    } catch {
      // Best-effort — on failure the toggle just reflects last-known state.
    } finally {
      setPauseToggling(false);
    }
  };

  if (loadError) {
    return (
      <div className="chat-shell chat-shell-error">
        <p className="form-error" role="alert">
          {loadError}
        </p>
        <button className="btn-secondary" onClick={reloadList}>
          Retry
        </button>
      </div>
    );
  }

  if (!conversations) {
    return <div className="app-loading">Loading conversations…</div>;
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <span className="chat-brand">Wispify — Chat</span>
        <div className="chat-header-actions">
          <label className="toggle-row pause-toggle">
            <input
              type="checkbox"
              checked={!!(appConfig && appConfig.botPaused)}
              disabled={!appConfig || pauseToggling}
              onChange={handlePauseToggle}
            />
            <span>Pause bot</span>
          </label>
          <span className="settings-username">{username}</span>
          <button className="btn-secondary" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      {/* Clear visual state when paused — the admin must never miss that
          the bot has gone silent (tasks.md 11.1's explicit requirement). */}
      {appConfig && appConfig.botPaused && (
        <p className="pause-banner" role="alert">
          Bot is PAUSED — no automatic replies are being sent to any customer.
        </p>
      )}

      <div className="chat-body">
        <aside className="conversation-list">
          <label className="toggle-row toggle-row-small">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <span>Show archived</span>
          </label>

          {conversations.length === 0 ? (
            <p className="field-hint">No conversations yet.</p>
          ) : (
            <ul className="conversation-items">
              {conversations.map((c) => (
                <ConversationListItem
                  key={c.customerPhone}
                  conversation={c}
                  selected={c.customerPhone === selectedPhone}
                  onOpen={() => openThread(c.customerPhone)}
                  onTogglePin={() => togglePin(c.customerPhone, !c.pinned)}
                  onToggleArchive={() => toggleArchive(c.customerPhone, !c.archived)}
                />
              ))}
            </ul>
          )}
        </aside>

        <main className="conversation-thread">
          {selected ? <ThreadView conversation={selected} /> : <p className="field-hint">Select a conversation.</p>}
        </main>
      </div>
    </div>
  );
}
