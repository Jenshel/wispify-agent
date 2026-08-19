// panel/src/views/LoginScreen.jsx — single-admin login gate in front of
// SettingsView (src/routes/auth.js POST /api/auth/login, PR4).
import { useState } from 'react';
import { login, ApiError } from '../api/client.js';

export default function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Username and password are required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = await login(username.trim(), password);
      onLogin(body.username);
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">Wispify</div>
        <p className="login-subtitle">Admin panel</p>

        <label className="field">
          <span className="field-label">Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError('');
            }}
            autoComplete="username"
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            autoComplete="current-password"
          />
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function loginErrorMessage(err) {
  if (!(err instanceof ApiError)) return 'Connection error. Please try again.';
  if (err.status === 401) return 'Invalid username or password.';
  if (err.status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (err.status === 503) return 'Admin account is not configured on the server.';
  return 'Connection error. Please try again.';
}
