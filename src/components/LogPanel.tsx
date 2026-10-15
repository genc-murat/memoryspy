import { useEffect, useRef, useState } from 'react';

import { formatClock } from '../lib/format';
import type { MetricsStore } from '../lib/store';

interface Props {
  store: MetricsStore;
  sessionId: string | null;
  onReset: () => void;
}

/**
 * The "what is the tool itself doing" view.
 *
 * Worth its own panel because this application supervises two processes: when a session
 * shows no data, the reason is nearly always visible here (collector not found, attach
 * refused, target exited) rather than in the charts.
 */
export function LogPanel({ store, sessionId, onReset }: Props) {
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLUListElement | null>(null);

  const entries = filter.trim()
    ? store.logs.filter((entry) => entry.message.toLowerCase().includes(filter.trim().toLowerCase()))
    : store.logs;

  useEffect(() => {
    if (!follow) return;
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries.length, follow]);

  return (
    <div className="panel">
      <section className="block-head">
        <div>
          <h2>Diagnostics</h2>
          <p>
            Collector stderr and host messages. If a session produces no data, this is where the reason will be.
          </p>
        </div>
        <div className="table-controls">
          <input
            className="input input-sm"
            placeholder="Filter messages"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
          />
          <label className="toggle">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
            <span>Follow</span>
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>
            Reset counters
          </button>
        </div>
      </section>

      {store.session.stats && (
        <section className="stats-strip">
          <span>
            <strong>{store.session.stats.messages.toLocaleString()}</strong> messages
          </span>
          <span>
            <strong>{store.session.stats.counters.toLocaleString()}</strong> counter samples
          </span>
          <span>
            <strong>{store.session.stats.allocationSamples.toLocaleString()}</strong> allocation samples
          </span>
          <span>
            <strong>{store.session.stats.gcEvents.toLocaleString()}</strong> GC events
          </span>
          {store.session.stats.dropped > 0 && (
            <span className="warn-text">
              <strong>{store.session.stats.dropped.toLocaleString()}</strong> unparseable lines
            </span>
          )}
          {sessionId && <span className="dim">session {sessionId}</span>}
        </section>
      )}

      <ul className="log-list" ref={listRef}>
        {entries.length === 0 && <li className="empty-note">No messages yet.</li>}
        {entries.map((entry) => (
          <li key={entry.seq} className={`log-row log-${entry.level}`}>
            <span className="log-time">{formatClock(entry.at)}</span>
            <span className="log-source">{entry.source}</span>
            <span className="log-message">{entry.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
