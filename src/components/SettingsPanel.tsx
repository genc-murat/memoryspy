import { useEffect, useState } from 'react';

import { formatDuration } from '../lib/format';
import type { Capabilities, CollectorLocation, Settings } from '../lib/types';

interface Props {
  settings: Settings;
  collector: CollectorLocation;
  capabilities: Capabilities | null;
  onSave: (settings: Settings) => Promise<void>;
  onRefreshCollector: () => Promise<void>;
}

/**
 * Environment and settings.
 *
 * The collector location is shown as a first-class piece of information rather than hidden
 * in a log: this app depends on a .NET sidecar it may not have found, and when it has not,
 * the searched paths are the fastest route to a fix.
 */
export function SettingsPanel({ settings, collector, capabilities, onSave, onRefreshCollector }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setSavedAt(Date.now());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel">
      <section className="chart-block">
        <header className="block-head">
          <h2>Collector</h2>
          <p>
            The .NET sidecar that talks to the target process over EventPipe. It is discovered
            automatically; override the path below only if you built it somewhere unusual.
          </p>
        </header>

        <div className={`notice ${collector.found ? 'notice-good' : 'notice-critical'}`}>
          {collector.found ? (
            <>
              <strong>Collector found</strong>
              <span>
                {collector.assemblyPath}
                <br />
                Resolved via <code>{collector.source}</code>
                {collector.dotnetVersion && <> · dotnet {collector.dotnetVersion}</>}
              </span>
            </>
          ) : (
            <>
              <strong>Collector not found</strong>
              <span>{collector.error}</span>
            </>
          )}
        </div>

        <div className="settings-grid">
          <label className="field">
            <span className="field-label">Collector assembly path</span>
            <input
              className="input"
              value={draft.collectorPath ?? ''}
              placeholder="Leave empty to auto-discover"
              spellCheck={false}
              onChange={(event) =>
                setDraft({ ...draft, collectorPath: event.target.value.trim() === '' ? null : event.target.value.trim() })
              }
            />
          </label>

          <label className="field">
            <span className="field-label">.NET host</span>
            <input className="input" value={collector.dotnetPath ?? 'not found'} readOnly />
          </label>
        </div>

        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            void onRefreshCollector();
          }}
        >
          Re-run discovery
        </button>

        {!collector.found && collector.searched.length > 0 && (
          <details className="searched-paths">
            <summary>Paths that were searched ({collector.searched.length})</summary>
            <ul>
              {collector.searched.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="chart-block">
        <header className="block-head">
          <h2>Collection</h2>
          <p>Defaults applied when a new session starts. Changes take effect on the next attach.</p>
        </header>

        <div className="settings-grid">
          <label className="field">
            <span className="field-label">Sampling interval</span>
            <select
              className="input"
              value={draft.intervalMs}
              onChange={(event) => setDraft({ ...draft, intervalMs: Number(event.target.value) })}
            >
              <option value={250}>250 ms</option>
              <option value={500}>500 ms</option>
              <option value={1000}>1 s</option>
              <option value={2000}>2 s</option>
              <option value={5000}>5 s</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">Types reported per sample</span>
            <input
              className="input"
              type="number"
              min={10}
              max={2000}
              value={draft.maxAllocationTypes}
              onChange={(event) => setDraft({ ...draft, maxAllocationTypes: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span className="field-label">Chart history (seconds)</span>
            <input
              className="input"
              type="number"
              min={30}
              max={3600}
              value={draft.historySeconds}
              onChange={(event) => setDraft({ ...draft, historySeconds: Number(event.target.value) })}
            />
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.showAllCounters}
              onChange={(event) => setDraft({ ...draft, showAllCounters: event.target.checked })}
            />
            <span>Show every counter, including the "Other" category</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.verboseCollector}
              onChange={(event) => setDraft({ ...draft, verboseCollector: event.target.checked })}
            />
            <span>Mirror every raw trace event to the diagnostics log</span>
          </label>
        </div>

        {error && <div className="inline-error">{error}</div>}

        <div className="settings-actions">
          <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {savedAt && !dirty && <span className="dim">Saved {formatDuration(Date.now() - savedAt)} ago</span>}
        </div>
      </section>

      {capabilities && (
        <section className="chart-block">
          <header className="block-head">
            <h2>Collector capabilities</h2>
            <p>Reported by the sidecar at handshake. The UI builds its views from this list.</p>
          </header>

          <div className="capability-strip">
            <span className="tag">{capabilities.tool}</span>
            <span className="tag">{capabilities.runtime}</span>
            <span className="tag">{capabilities.os}</span>
            <span className="tag">{capabilities.architecture}</span>
            <span className="tag">protocol v{capabilities.protocolVersion}</span>
          </div>

          <div className="capability-list">
            {capabilities.probes.map((probe) => (
              <div className="capability-row" key={probe.id}>
                <div className="capability-head">
                  <strong>{probe.displayName}</strong>
                  <code>{probe.id}</code>
                  <span className="chip chip-quiet">{probe.channel}</span>
                </div>
                <p>{probe.description}</p>
                <div className="capability-events">
                  {probe.eventTypes.map((type) => (
                    <span className="tag tag-mono" key={type}>
                      {type}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="capability-strip">
            {capabilities.supports.map((feature) => (
              <span className="tag" key={feature}>
                {feature}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
