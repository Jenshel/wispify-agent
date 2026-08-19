// panel/src/views/settings/SoulDocsSection.jsx — the bot's personality/rules
// editor (Phase 4, PR6). Split out from AppConfigSection into its own file
// on purpose: SettingsView.jsx already landed large in PR5 (2136 lines), and
// this section is functionally independent (edits the AI system-prompt
// inputs, not the business/currency/timezone fields) — same
// GET/PATCH /api/settings/app-config endpoint, different concern.
//
// Field names mirror the source system's buildSystemPrompt() exactly
// (WhiteLabel_WA_System/wa-brain-local/index.js): config.context,
// config.personality (preset) + config.personalityCustom, and the soul-docs
// "rules" free text — collapsed here into the single `soul_docs` column
// (PR2's schema; single-bot has no need for the old per-slot multi-key
// soul-docs.json). This is the OWNER's own bot config, not user input, so no
// injection-style validation applies — only a max-length guard (mirrored
// from src/config/store.js MAX_LONG_TEXT_LENGTH; no shared package between
// panel/ and src/ per design.md's module boundary, so this is a documented
// manual duplicate, same precedent as integrationFields.js's GEMINI_MODELS).
// Same explicit-result, never-silent-save pattern as AppConfigSection/
// IntegrationCard.
import { useEffect, useState } from 'react';
import { updateAppConfig, ApiError } from '../../api/client.js';

// Mirrors src/config/store.js MAX_LONG_TEXT_LENGTH — keep both in sync.
const MAX_LONG_TEXT_LENGTH = 20_000;

const PERSONALITY_PRESETS = [
  { value: '', label: 'None selected' },
  { value: 'formal', label: 'Formal — professional, structured' },
  { value: 'amigable', label: 'Friendly — warm, casual' },
  { value: 'juvenil', label: 'Youthful — energetic, modern slang' },
  { value: 'custom', label: 'Custom — use the instructions below' },
];

export default function SoulDocsSection({ appConfig, onSaved }) {
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
      setResult({ ok: true, message: 'Saved — the next reply will use this immediately.' });
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Personality &amp; Rules</h2>
      <p className="field-hint">
        This content feeds the bot&apos;s AI system prompt directly. Changes apply live — no restart needed.
      </p>
      <form className="soul-docs-form" onSubmit={handleSubmit}>
        <label className="field">
          <span className="field-label">Business context</span>
          <textarea
            rows={5}
            maxLength={MAX_LONG_TEXT_LENGTH}
            value={form.context}
            onChange={(e) => handleChange('context', e.target.value)}
            placeholder="What the business sells, hours, location, policies…"
          />
        </label>

        <label className="field">
          <span className="field-label">Personality preset</span>
          <select value={form.personality} onChange={(e) => handleChange('personality', e.target.value)}>
            {PERSONALITY_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Personality instructions</span>
          <textarea
            rows={4}
            maxLength={MAX_LONG_TEXT_LENGTH}
            value={form.personalityCustom}
            onChange={(e) => handleChange('personalityCustom', e.target.value)}
            placeholder="Tone, phrasing, emoji use, anything specific to how this bot should talk…"
          />
        </label>

        <label className="field">
          <span className="field-label">Rules (soul docs)</span>
          <textarea
            rows={10}
            maxLength={MAX_LONG_TEXT_LENGTH}
            value={form.soulDocs}
            onChange={(e) => handleChange('soulDocs', e.target.value)}
            placeholder="Pricing scripts, escalation rules, formatting constraints, anything the bot must always follow…"
          />
          <span className="field-hint">
            {form.soulDocs.length.toLocaleString()} / {MAX_LONG_TEXT_LENGTH.toLocaleString()} characters
          </span>
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
    context: appConfig.context || '',
    personality: appConfig.personality || '',
    personalityCustom: appConfig.personalityCustom || '',
    soulDocs: appConfig.soulDocs || '',
  };
}
