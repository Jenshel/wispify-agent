// panel/src/App.jsx — top-level auth gate + Chat/Settings tab nav. No
// router: this panel has exactly three screens (login, chat, settings), so
// a state machine is simpler than pulling in react-router for two branches
// (design.md keeps the dependency list minimal for this starter). Chat is
// the default post-login tab (tasks.md Phase 11.1).
import { useCallback, useEffect, useState } from 'react';
import LoginScreen from './views/LoginScreen.jsx';
import SettingsView from './views/SettingsView.jsx';
import ChatView from './views/ChatView.jsx';
import { me, logout } from './api/client.js';

// Theme toggle (tasks.md Phase 11.3) — pure client-side, no backend
// involvement. Persisted in localStorage; applied via a `data-theme`
// attribute on <html> that index.css's light-mode token overrides key off
// of. Lives at the App level (not inside ChatView/SettingsView) because it
// is a whole-panel preference, not scoped to one tab.
const THEME_STORAGE_KEY = 'wispify-panel-theme'; // 'light' | 'dark'

function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark'; // localStorage blocked (private mode, etc.) — fall back to the existing default palette
  }
}

export default function App() {
  const [status, setStatus] = useState('checking'); // checking | anonymous | authenticated
  const [username, setUsername] = useState(null);
  const [tab, setTab] = useState('chat'); // chat | settings
  const [theme, setTheme] = useState(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Best-effort — a blocked localStorage just means the choice doesn't
      // persist across reloads, never a crash.
    }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    me()
      .then((body) => {
        if (cancelled) return;
        setUsername(body.username);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = useCallback((loggedInUsername) => {
    setUsername(loggedInUsername);
    setStatus('authenticated');
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Best-effort — clear local session state regardless of the network
      // outcome; a stale server session just expires on its own TTL.
    }
    setUsername(null);
    setStatus('anonymous');
  }, []);

  if (status === 'checking') {
    return <div className="app-loading">Loading…</div>;
  }

  if (status === 'anonymous') {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <>
      <nav className="app-tabbar">
        <span className="app-tabbar-brand">Wispify</span>
        <div className="app-tabbar-tabs">
          <button
            type="button"
            className={`app-tabbar-tab${tab === 'chat' ? ' app-tabbar-tab-active' : ''}`}
            onClick={() => setTab('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            className={`app-tabbar-tab${tab === 'settings' ? ' app-tabbar-tab-active' : ''}`}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
      </nav>

      {tab === 'chat' ? (
        <ChatView username={username} onLogout={handleLogout} />
      ) : (
        <SettingsView username={username} onLogout={handleLogout} />
      )}
    </>
  );
}
