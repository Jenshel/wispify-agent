// panel/src/views/SettingsView.jsx — "Settings / Integrations": one card
// per integration plus the app-config (business) section. Sits behind
// LoginScreen because every route it calls requires an admin session
// (src/auth/middleware.js requireAuth, PR4).
import { useCallback, useEffect, useState } from 'react';
import { listIntegrations, getAppConfig, ApiError } from '../api/client.js';
import IntegrationCard from './settings/IntegrationCard.jsx';
import AppConfigSection from './settings/AppConfigSection.jsx';
import SoulDocsSection from './settings/SoulDocsSection.jsx';
import { INTEGRATION_ORDER } from './settings/integrationFields.js';

export default function SettingsView({ username, onLogout }) {
  const [integrations, setIntegrations] = useState(null); // null while loading, else {id: publicShape}
  const [appConfig, setAppConfig] = useState(null);
  const [loadError, setLoadError] = useState('');

  // Google's OAuth callback always redirects to a single fixed path with a
  // `?google=ok` marker (src/integrations/google-calendar.js
  // getFixedPostAuthRedirect()) — never a URL from the query string, so this
  // is safe to read directly. Captured once on mount, then scrubbed from the
  // URL so a page refresh doesn't re-show the banner.
  const [oauthNotice] = useState(() => new URLSearchParams(window.location.search).get('google') === 'ok');
  useEffect(() => {
    if (oauthNotice) window.history.replaceState(null, '', window.location.pathname);
  }, [oauthNotice]);

  const reload = useCallback(async () => {
    try {
      const [list, config] = await Promise.all([listIntegrations(), getAppConfig()]);
      setIntegrations(Object.fromEntries(list.map((item) => [item.id, item])));
      setAppConfig(config);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load settings.');
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loadError) {
    return (
      <div className="settings-shell settings-shell-error">
        <p className="form-error" role="alert">
          {loadError}
        </p>
        <button className="btn-secondary" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  if (!integrations || !appConfig) {
    return <div className="app-loading">Loading settings…</div>;
  }

  return (
    <div className="settings-shell">
      <header className="settings-header">
        <span className="settings-brand">Wispify — Settings</span>
        <div className="settings-header-actions">
          <span className="settings-username">{username}</span>
          <button className="btn-secondary" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      <main className="settings-main">
        {oauthNotice && (
          <p className="form-success" role="status">
            Google Calendar connected.
          </p>
        )}

        <section className="settings-section">
          <h2>Integrations</h2>
          <div className="integration-grid">
            {INTEGRATION_ORDER.map((id) => (
              <IntegrationCard
                key={id}
                id={id}
                integration={integrations[id]}
                onUpdated={(pub) => setIntegrations((prev) => ({ ...prev, [id]: pub }))}
              />
            ))}
          </div>
        </section>

        <AppConfigSection appConfig={appConfig} onSaved={setAppConfig} />

        <SoulDocsSection appConfig={appConfig} onSaved={setAppConfig} />
      </main>
    </div>
  );
}
