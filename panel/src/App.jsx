// panel/src/App.jsx — top-level auth gate. No router: this panel currently
// has exactly two screens (login vs settings), so a state machine is
// simpler than pulling in react-router for one branch (design.md keeps the
// dependency list minimal for this starter).
import { useCallback, useEffect, useState } from 'react';
import LoginScreen from './views/LoginScreen.jsx';
import SettingsView from './views/SettingsView.jsx';
import { me, logout } from './api/client.js';

export default function App() {
  const [status, setStatus] = useState('checking'); // checking | anonymous | authenticated
  const [username, setUsername] = useState(null);

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

  return <SettingsView username={username} onLogout={handleLogout} />;
}
