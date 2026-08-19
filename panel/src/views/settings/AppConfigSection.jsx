// panel/src/views/settings/AppConfigSection.jsx — business name, currency,
// timezone (src/routes/settings.js GET/PATCH /api/settings/app-config,
// PR4). Same explicit-result pattern as IntegrationCard: no silent save.
import { useEffect, useState } from 'react';
import { updateAppConfig, ApiError } from '../../api/client.js';

const CURRENCIES = ['MXN', 'USD', 'EUR', 'COP', 'ARS'];

export default function AppConfigSection({ appConfig, onSaved }) {
  const [form, setForm] = useState(() => toForm(appConfig));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setForm(toForm(appConfig));
  }, [appConfig]);

  const handleChange = (name, value) => {
    setForm((prev) => ({ ...prev, [name]: value }));
    setResult(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      const updated = await updateAppConfig(form);
      onSaved(updated);
      setResult({ ok: true, message: 'Saved.' });
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Business</h2>
      <form className="app-config-form" onSubmit={handleSubmit}>
        <label className="field">
          <span className="field-label">Business name</span>
          <input type="text" value={form.businessName} onChange={(e) => handleChange('businessName', e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Currency</span>
          <select value={form.currency} onChange={(e) => handleChange('currency', e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Timezone</span>
          <input
            type="text"
            value={form.timezone}
            onChange={(e) => handleChange('timezone', e.target.value)}
            placeholder="America/Mexico_City"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
      {result && (
        <p className={result.ok ? 'form-success' : 'form-error'} role="status">
          {result.message}
        </p>
      )}
    </section>
  );
}

function toForm(appConfig) {
  return {
    businessName: appConfig.businessName || '',
    currency: appConfig.currency || 'MXN',
    timezone: appConfig.timezone || '',
  };
}
