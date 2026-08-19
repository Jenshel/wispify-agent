// panel/src/views/settings/IntegrationCard.jsx — one card per integration
// (Meta / Gemini / Google Calendar / Stripe). Validate-then-persist mirrors
// the backend contract exactly (src/routes/settings.js, PR4): POST
// credentials to /verify, show a loading state, then a clear pass/fail
// result. On success the backend's returned public shape ({id, enabled,
// status, publicMeta, lastCheckedAt, lastError}) replaces this card's
// integration prop via onUpdated — status/enabled reflect immediately,
// never a silent save.
import { useState } from 'react';
import { verifyIntegration, setIntegrationEnabled, ApiError, GOOGLE_CALENDAR_OAUTH_START_URL } from '../../api/client.js';
import { INTEGRATION_META, canEnableIntegration, statusLabel } from './integrationFields.js';

export default function IntegrationCard({ id, integration, onUpdated }) {
  const meta = INTEGRATION_META[id];
  const [form, setForm] = useState(() => initialFormState(meta));
  const [verifying, setVerifying] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [result, setResult] = useState(null); // { ok: boolean, message: string } | null

  const handleFieldChange = (name, value) => {
    setForm((prev) => ({ ...prev, [name]: value }));
    setResult(null);
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setVerifying(true);
    setResult(null);
    try {
      const updated = await verifyIntegration(id, form);
      onUpdated(updated);
      setResult({ ok: true, message: 'Verified — connection is live.' });
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Connection error. Please try again.' });
    } finally {
      setVerifying(false);
    }
  };

  const handleToggle = async () => {
    setToggling(true);
    setResult(null);
    try {
      const updated = await setIntegrationEnabled(id, !integration.enabled);
      onUpdated(updated);
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Could not update.' });
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className={`integration-card status-${integration.status}`}>
      <div className="integration-card-header">
        <h3>{meta.label}</h3>
        <span className={`status-pill status-pill-${integration.status}`}>{statusLabel(integration.status)}</span>
      </div>

      {integration.publicMeta && <PublicMeta data={integration.publicMeta} />}

      {integration.status === 'error' && integration.lastError && (
        <p className="form-error" role="alert">
          {integration.lastError}
        </p>
      )}

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={!!integration.enabled}
          disabled={toggling || !canEnableIntegration(integration.status)}
          onChange={handleToggle}
        />
        <span>Enabled</span>
      </label>
      {!canEnableIntegration(integration.status) && <p className="field-hint">Verify credentials before enabling.</p>}

      {meta.oauth ? (
        <a className="btn-primary oauth-link" href={GOOGLE_CALENDAR_OAUTH_START_URL}>
          Connect Google Calendar
        </a>
      ) : (
        <form className="integration-form" onSubmit={handleVerify}>
          {meta.fields.map((field) => (
            <CredentialField key={field.name} field={field} value={form[field.name]} onChange={handleFieldChange} />
          ))}
          <button type="submit" className="btn-primary" disabled={verifying}>
            {verifying ? 'Verifying…' : 'Verify & Save'}
          </button>
        </form>
      )}

      {result && (
        <p className={result.ok ? 'form-success' : 'form-error'} role="status">
          {result.message}
        </p>
      )}
    </div>
  );
}

function PublicMeta({ data }) {
  const entries = Object.entries(data).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return null;
  return (
    <dl className="integration-meta">
      {entries.map(([k, v]) => (
        <div key={k} className="integration-meta-row">
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function CredentialField({ field, value, onChange }) {
  return (
    <label className="field">
      <span className="field-label">
        {field.label}
        {field.required ? '' : ' (optional)'}
      </span>
      {field.type === 'select' ? (
        <select value={value || ''} onChange={(e) => onChange(field.name, e.target.value)} required={field.required}>
          <option value="" disabled>
            Select a model…
          </option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type}
          value={value || ''}
          onChange={(e) => onChange(field.name, e.target.value)}
          required={field.required}
          autoComplete="off"
        />
      )}
    </label>
  );
}

function initialFormState(meta) {
  if (meta.oauth) return {};
  return Object.fromEntries(meta.fields.map((f) => [f.name, '']));
}
