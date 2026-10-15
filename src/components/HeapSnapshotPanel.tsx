import { useEffect, useMemo, useRef, useState } from 'react';

import { formatBytes, formatClock, formatDuration, formatPercent } from '../lib/format';
import type { HeapSnapshotRecord, MetricsStore } from '../lib/store';
import type { RetentionPath } from '../lib/types';

interface Props {
  store: MetricsStore;
  /** Asks the collector to walk the live heap. The walk's result arrives as a message, not a reply. */
  onTakeSnapshot: () => void;
  /** Snapshots are taken from the live target only; a replay has no process to walk. */
  disabled: boolean;
}

/** How long a requested walk is shown as running before the panel stops claiming it is. */
const PENDING_TIMEOUT_MS = 180_000;

/**
 * Answers "what is holding these objects alive?".
 *
 * The two halves of the answer are deliberately different shapes. The table is accounting: what
 * exists and how much it occupies. The retention chains are causation: the references the runtime
 * itself reports, from a GC root down to a live instance — the chain that has to be cut, and the
 * list of things that are not the problem because nothing points at them.
 *
 * A walk is expensive in a way this panel states rather than hides: it stops the target for one
 * Gen 2 collection, and on a large heap it takes a while. That is why it is a button and not a
 * periodic sample.
 */
export function HeapSnapshotPanel({ store, onTakeSnapshot, disabled }: Props) {
  const [pendingUntil, setPendingUntil] = useState(0);
  const [selected, setSelected] = useState(0);
  const lastArrival = useRef(0);

  const snapshots = store.snapshots;
  const newest = snapshots[0] as HeapSnapshotRecord | undefined;

  // A request is over when a snapshot that was not there before arrives. Watching the arrival
  // rather than the command's acknowledgement is what survives the walk failing halfway: the
  // button returns to normal instead of staying stuck on "walking" forever.
  useEffect(() => {
    if (!newest) return;
    if (newest.seq !== lastArrival.current) {
      lastArrival.current = newest.seq;
      setPendingUntil(0);
      setSelected(0);
    }
  }, [newest]);

  const pending = pendingUntil > Date.now();

  const snapshot = snapshots[Math.min(selected, snapshots.length - 1)];

  const rows = useMemo(() => snapshot?.types ?? [], [snapshot]);

  if (!snapshot) {
    return (
      <div className="panel">
        <section className="snapshot-intro">
          <span className="eyebrow">Heap snapshot</span>
          <h2>Nothing has walked the heap yet</h2>
          <p>
            An allocation rate tells you what is being <em>created</em>. A heap snapshot tells you what
            is still there and, for the types that dominate it, the chain of references from a GC root
            down to a live instance — which is the difference between “this type is big” and “this is
            why it is big”.
          </p>
          <p className="caveat">
            The walk happens during a Gen 2 collection, so the target pauses while it runs, and the
            collector holds the object graph in its own memory. Exact accounting is the trade.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => {
              setPendingUntil(Date.now() + PENDING_TIMEOUT_MS);
              onTakeSnapshot();
            }}
            disabled={disabled || pending}
          >
            {pending ? 'Walking the heap…' : disabled ? 'Not available while replaying' : 'Take snapshot'}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="panel">
      {snapshot.coverageNote && <div className="notice notice-warning">{snapshot.coverageNote}</div>}
      {snapshot.retainedNote && <div className="notice notice-warning">{snapshot.retainedNote}</div>}
      {snapshot.edgeAlignmentNote && <div className="notice notice-info">{snapshot.edgeAlignmentNote}</div>}
      {snapshot.incomplete && (
        <div className="notice notice-warning">
          The walk did not finish within its deadline, so this is the part of the heap it reached before
          it was stopped. Treat the totals as a floor.
        </div>
      )}

      <section className="block-head block-head-sticky">
        <div>
          <span className="eyebrow">Snapshot #{snapshot.snapshotId}</span>
          <h2>What is holding these objects alive</h2>
          <p className="caveat">
            Taken at {formatClock(snapshot.receivedAt)} · exact live objects at one blocking collection,
            not a sample.
          </p>
        </div>
        <div className="table-controls">
          {snapshots.length > 1 && (
            <select
              className="input input-sm"
              value={selected}
              onChange={(event) => setSelected(Number(event.target.value))}
            >
              {snapshots.map((entry, index) => (
                <option key={entry.seq} value={index}>
                  {index === 0 ? 'Newest' : `${index + 1} ago`} · {formatClock(entry.receivedAt)}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn btn-sm"
            onClick={() => {
              setPendingUntil(Date.now() + PENDING_TIMEOUT_MS);
              onTakeSnapshot();
            }}
            disabled={disabled || pending}
          >
            {pending ? 'Walking the heap…' : 'Take snapshot'}
          </button>
        </div>
      </section>

      <section className="metrics-strip">
        <SnapshotStat label="Live objects" value={snapshot.objectCount.toLocaleString()} />
        <SnapshotStat label="Live bytes" value={formatBytes(snapshot.totalBytes)} />
        <SnapshotStat
          label="Reachable"
          value={formatPercent((snapshot.reachableObjects / Math.max(1, snapshot.objectCount)) * 100, 2)}
          hint="Share of the walked objects a GC root can reach. Live objects that no root reaches are finalizable garbage, not a leak."
        />
        <SnapshotStat label="References" value={snapshot.edgeCount.toLocaleString()} />
        <SnapshotStat
          label="Roots"
          value={`${snapshot.rootCount.toLocaleString()} + ${snapshot.staticRootCount.toLocaleString()} static`}
          hint="Root edges plus static fields: the places a retention chain can start."
        />
        <SnapshotStat label="Types" value={snapshot.typeCount.toLocaleString()} />
        <SnapshotStat
          label="Paused target"
          value={formatDuration(snapshot.pauseMs)}
          hint="How long the snapshot collection stopped the target."
        />
        <SnapshotStat label="Walk took" value={formatDuration(snapshot.durationMs)} />
      </section>

      <section className="snapshot-retention">
        <h3>Retention chains</h3>
        {snapshot.retention.length === 0 ? (
          <p className="empty-note">
            No retention path was reported. The largest types here had no instance a root could reach,
            which usually means the walk itself is incomplete — the note above says why when it is.
          </p>
        ) : (
          <p className="caveat">
            One chain per type, root first: the runtime’s own references, named where the runtime names
            them (<code>field #n</code> is a reference it reports by index). <strong>Holds</strong> is what
            that object alone keeps alive, so the chain shows where the weight sits — often not at either
            end. Read the top of the chain: that is the reference that has to go.
          </p>
        )}
        <div className="retention-list">
          {snapshot.retention.map((path) => (
            <RetentionChain key={path.typeName} path={path} />
          ))}
        </div>
      </section>

      <section>
        <h3>Live bytes by type</h3>
        <p className="caveat">
          Live bytes is what each type’s objects occupy. <strong>Freed if removed</strong> is the different
          question — the live bytes that would no longer be reachable if every object of that type went
          away — and it is normally the larger number, because a small type can hold a large one. A type
          whose two numbers match holds nothing that is not its own.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Type</th>
              <th className="num">Live objects</th>
              <th className="num">Live bytes</th>
              <th className="share-col">Share</th>
              <th className="num" title="Live bytes that would no longer be reachable if every object of this type were removed — what the type holds, not just what it occupies.">
                Freed if removed
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.typeName}>
                <td className="num dim">{index + 1}</td>
                <td className="type-name" title={row.typeName}>
                  {row.typeName}
                </td>
                <td className="num">{row.objectCount.toLocaleString()}</td>
                <td className="num">{formatBytes(row.liveBytes)}</td>
                <td className="share-col">
                  <span className="share-bar">
                    <span className="share-fill" style={{ width: `${Math.min(100, row.share * 100)}%` }} />
                  </span>
                  <span className="share-text">{formatPercent(row.share * 100)}</span>
                </td>
                <td className="num">
                  {row.retainedBytes == null ? (
                    <span className="dim">—</span>
                  ) : (
                    formatBytes(row.retainedBytes)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {snapshot.typeCount > rows.length && (
          <p className="empty-note">
            Showing the top {rows.length} of {snapshot.typeCount.toLocaleString()} types by live bytes.
            {snapshot.unknownTypeObjects > 0 &&
              ` ${snapshot.unknownTypeObjects.toLocaleString()} objects have a type the walk never named.`}
          </p>
        )}
      </section>

      {snapshot.inventory.length > 0 && (
        <details className="snapshot-inventory">
          <summary>What the session actually saw ({snapshot.inventory.length} event kinds)</summary>
          <p className="caveat">
            Counted, not assumed: a graph built from events that never arrived looks exactly like a
            small heap, so the events that did arrive are listed.
          </p>
          <p className="mono-dim">{snapshot.inventory.join(' · ')}</p>
        </details>
      )}

      <p className="caveat">{snapshot.note}</p>
    </div>
  );
}

function SnapshotStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric-tile" title={hint}>
      <span className="eyebrow">{label}</span>
      <span className="metric-value metric-value-sm">{value}</span>
    </div>
  );
}

/**
 * One reference chain, drawn root first.
 *
 * The root frame is the only one that is always a real root; the frames after it are field
 * references, and the last is the instance the type was ranked on. Size is carried on every frame
 * because the interesting frame is often not the largest one: a 92 MB array usually sits directly
 * under the small dictionary that is the actual mistake.
 */
function RetentionChain({ path }: { path: RetentionPath }) {
  // The heaviest frame is what a reader should look at: it is where the weight in this chain
  // actually sits, and it is rarely the last one.
  const heaviest = path.frames.reduce((max, frame) => ((frame.retainedBytes ?? -1) > (max ?? -1) ? frame.retainedBytes ?? -1 : max), -1);

  return (
    <article className="retention-chain">
      <header>
        <span className="eyebrow">Held alive by</span>
        <span className="retention-target">{path.typeName}</span>
        <span className="chip">{path.depth} hops</span>
        {heaviest > 0 && <span className="chip chip-info">holds {formatBytes(heaviest)}</span>}
        {path.truncated && <span className="chip chip-warning">chain truncated</span>}
      </header>
      <ol className="retention-frames">
        {path.frames.map((frame, index) => (
          <li key={`${index}-${frame.label}`} className={index === 0 ? 'retention-root' : undefined}>
            <span className="retention-label" title={frame.label}>
              {frame.label}
            </span>
            <span className="retention-type" title={frame.typeName}>
              {frame.typeName}
            </span>
            <span className="retention-size">
              {formatBytes(frame.size)}
              {frame.retainedBytes != null && (
                <span
                  className="retention-retained"
                  title="Live bytes that would no longer be reachable if this object became unreachable."
                >
                  holds {formatBytes(frame.retainedBytes)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </article>
  );
}
