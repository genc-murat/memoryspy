import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { DumpInspection } from './DumpInspection';
import { compareDumpTypes, dumpReportKey } from '../lib/dumpComparison';
import { fileNameOf, formatBytes, formatDuration, formatMilliseconds, formatPercent } from '../lib/format';
import { isTauri } from '../lib/ipc';
import type { AllocationSiteData, DumpAnalysis } from '../lib/types';
import type { useDumpAnalysis } from '../lib/useDumpAnalysis';

const PAGE_SIZE = 100;

type Analysis = ReturnType<typeof useDumpAnalysis>;

export function DumpPanel({ analysis, traces }: { analysis: Analysis; traces: AllocationSiteData[] }) {
  const { path, setPath, reachableOnly, setReachableOnly, result, phase, error, status, work, pick, analyze, cancel, dismissError } = analysis;
  const available = isTauri();
  const queuedCount = analysis.queue.filter((item) => item.state === 'pending' || item.state === 'cancelled').length;
  const multipleFiles = analysis.queue.length > 1;
  const chosenScope = analysis.queueScope ?? reachableOnly;
  const [showImport, setShowImport] = useState(true);
  useEffect(() => { if (result) setShowImport(false); }, [result]);

  return (
    <div className="panel dump-panel">
      <details className="dump-import" open={showImport} onToggle={(event) => setShowImport(event.currentTarget.open)}>
        <summary>{result ? 'Open another dump or change scope' : 'Open a .NET memory dump'}</summary>
        <form
          className="dump-import-form"
          onSubmit={(event) => {
            event.preventDefault();
            void analyze();
          }}
        >
          {multipleFiles ? <span className="field-label">Selected dump files</span>
            : <label className="field-label" htmlFor="dump-path">Dump file path</label>}
          <div className="recording-import-row dump-import-row">
            {multipleFiles ? <div className="dump-multi-selection">{analysis.queue.length} dump files selected</div> : <input
              id="dump-path"
              className="input"
              placeholder="C:\dumps\common1.dmp"
              value={path}
              spellCheck={false}
              disabled={!available || phase !== 'idle'}
              onChange={(event) => setPath(event.target.value)}
            />}
            <button type="button" className="btn btn-sm" disabled={!available || phase !== 'idle'} onClick={() => void pick()}>
              Browse dumps…
            </button>
            <button type="submit" className="btn btn-primary btn-sm"
              disabled={!available || phase !== 'idle' || (analysis.queue.length ? !queuedCount : !path.trim())}>
              {analysis.queue.length ? (queuedCount ? `Analyze ${queuedCount} ${queuedCount === 1 ? 'dump' : 'dumps'}` : 'Queue complete') : 'Analyze dump'}
            </button>
          </div>
          <div className="dump-scope">
            <label className="field">
              <span className="field-label">Heap scope</span>
              <select className="input input-sm" aria-describedby="dump-scope-help" value={chosenScope ? 'reachable' : 'all'}
                disabled={!available || phase !== 'idle' || analysis.queueScope !== null}
                onChange={(event) => setReachableOnly(event.target.value === 'reachable')}>
                <option value="all">All managed objects</option>
                <option value="reachable">Reachable objects only</option>
              </select>
            </label>
            <span className="caveat" id="dump-scope-help">{analysis.queueScope !== null
              ? 'Clear the queue to change its heap scope.'
              : chosenScope
                ? 'Traces GC reachability. Large heaps require extra time and RAM.'
                : 'Includes objects awaiting collection. Use this for an initial overview.'}</span>
          </div>
        </form>
      </details>
      {analysis.queue.length > 0 && <DumpQueue analysis={analysis} />}
      {!available && <p className="caveat">Open MemorySpy on the desktop to analyze a local file.</p>}
      {status && <p className="dim" role="status">{status}</p>}
      {error && (
        <div className="notice notice-warning dump-operation-error">
          <div className="dump-allocation-row">
            <strong role="alert">{error.split('\n')[0]}</strong>
            <button type="button" className="btn btn-sm btn-ghost" onClick={dismissError}>Dismiss error</button>
          </div>
          {error.includes('\n') && <details className="dump-error-details">
            <summary>Diagnostic details</summary>
            <pre>{error.slice(error.indexOf('\n') + 1).trim()}</pre>
          </details>}
        </div>
      )}
      {work && <DumpProgress work={work} cancelling={phase === 'cancelling'} cancel={cancel} />}
      {!result && !work && <section className="dump-empty" aria-labelledby="dump-start-title">
        <h2 id="dump-start-title">Find what keeps memory alive</h2>
        <p>Open a Full or Heap dump, choose a type, then trace the references holding its objects.</p>
        <details className="dump-collection-help">
          <summary>Collect a dump from your .NET process</summary>
          <code>dotnet-dump collect -p &lt;PID&gt; --type Heap --output memory.dmp</code>
          <p>Analyze it on a matching OS and architecture. Add a later dump from the same process to compare growth.</p>
        </details>
      </section>}
      {result && <DumpResults key={dumpReportKey(result)} result={result} analysis={analysis} traces={traces} />}
    </div>
  );
}

function DumpQueue({ analysis }: { analysis: Analysis }) {
  const { queue, phase, clearQueue, moveQueuedFile, retryFailed, analyze } = analysis;
  const busy = phase !== 'idle';
  const completed = queue.filter((item) => item.state === 'complete').length;
  const failures = queue.filter((item) => item.state === 'failed').length;
  const waiting = queue.filter((item) => item.state === 'pending' || item.state === 'cancelled').length;
  const canReorder = queue.every((item) => item.state === 'pending');
  const labels = { pending: 'Queued', running: 'Analyzing', complete: 'Analyzed', failed: 'Failed', cancelled: 'Cancelled' };
  return (
    <section className="dump-queue" aria-labelledby="dump-queue-title">
      <div className="dump-allocation-row">
        <div>
          <h2 id="dump-queue-title">Analysis queue</h2>
          <p className="caveat">Files run one at a time in this order.</p>
          <p className="caveat">{(analysis.queueScope ?? analysis.reachableOnly) ? 'Reachable objects only' : 'All managed objects'}</p>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={clearQueue}>Clear queue</button>
      </div>
      <ol>
        {queue.map((item, index) => (
          <li key={item.path} className={`dump-queue-item is-${item.state}`}>
            <div className="dump-queue-file">
              <span className="dump-queue-position" aria-label={`Position ${index + 1}`}>{index + 1}</span>
              <div>
                <strong title={item.path}>{fileNameOf(item.path)}</strong>
                <code title={item.path}>{item.path}</code>
              </div>
              <span className="dump-queue-state">{labels[item.state]}</span>
              {canReorder && queue.length > 1 && <div className="dump-order-actions">
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy || index === 0}
                  aria-label={`Move ${item.path} earlier in queue`} onClick={() => moveQueuedFile(item.path, -1)}>Earlier</button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy || index === queue.length - 1}
                  aria-label={`Move ${item.path} later in queue`} onClick={() => moveQueuedFile(item.path, 1)}>Later</button>
              </div>}
            </div>
            {item.error && <details className="dump-error-details">
              <summary>Error details for {fileNameOf(item.path)}</summary>
              <pre tabIndex={0}>{item.error}</pre>
            </details>}
          </li>
        ))}
      </ol>
      <div className="dump-allocation-row">
        <span className="dim" role="status">{completed} analyzed · {failures} failed · {waiting} waiting</span>
        <div className="table-controls">
          {!canReorder && waiting > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void analyze()}>
            Continue queue
          </button>}
          {failures > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void retryFailed()}>
            Retry failed files ({failures})
          </button>}
        </div>
      </div>
    </section>
  );
}

function DumpProgress({ work, cancelling, cancel }: {
  work: NonNullable<Analysis['work']>;
  cancelling: boolean;
  cancel: Analysis['cancel'];
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Date.now() - work.startedAt);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [work.startedAt]);
  const percent = work.detail.match(/(?:\(|\s)(\d{1,3}(?:\.\d+)?)%(?:\)|\s|$)/)?.[1];
  return (
    <div className="notice notice-info dump-progress">
      <div>
        <strong role="status">{work.message}</strong>
        <p>{work.detail || 'Waiting for the diagnostic tool to report progress…'}</p>
        <progress aria-label={work.message} max={100} value={percent === undefined ? undefined : Number(percent)} />
      </div>
      <span className="tag-mono" aria-label={`Elapsed ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</span>
      <button type="button" className="btn btn-sm" disabled={cancelling} onClick={() => void cancel()}>
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  );
}

function DumpResults({ result, analysis, traces }: { result: DumpAnalysis; analysis: Analysis; traces: AllocationSiteData[] }) {
  const { baseline, setBaselineId, reports, viewReport, selectType, inspection, closeInspection, phase } = analysis;
  const inspectButton = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tableScroll = useRef<HTMLDivElement>(null);
  const [editingOrder, setEditingOrder] = useState(false);
  const { query, sortByCount, growingOnly, everyInterval, page } = analysis.view;
  const setPage = (page: number) => analysis.updateView({ page });
  const scopedReports = useMemo(() => reports.filter((report) => report.reachableOnly === result.reachableOnly),
    [reports, result.reachableOnly]);
  const first = baseline ? scopedReports.indexOf(baseline) : -1;
  const last = scopedReports.indexOf(result);
  const comparison = first >= 0 && last > first ? baseline : null;
  const history = useMemo(() => scopedReports.slice(comparison ? first : 0, last + 1),
    [comparison, scopedReports, first, last]);
  const intervals = comparison ? history.length - 1 : 0;

  const types = useMemo(() => compareDumpTypes(comparison
    ? history.map((report) => report.types)
    : [result.types]),
  [comparison, history, result.types]);
  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = types.filter((type) => {
      if (comparison && growingOnly && type.deltaBytes <= 0 && type.deltaCount <= 0) return false;
      if (everyInterval && intervals > 1 &&
        (sortByCount ? type.growingCountIntervals : type.growingByteIntervals) < intervals) return false;
      return type.typeName.toLowerCase().includes(term) ||
        type.methodTables.some((table) => table.methodTable.toLowerCase().includes(term));
    });
    if (comparison) {
      filtered.sort((a, b) => {
        const growthA = sortByCount ? a.growingCountIntervals : a.growingByteIntervals;
        const growthB = sortByCount ? b.growingCountIntervals : b.growingByteIntervals;
        const sustained = intervals > 1 ? Number(growthB === intervals) - Number(growthA === intervals) : 0;
        return sustained || (sortByCount ? b.deltaCount - a.deltaCount : b.deltaBytes - a.deltaBytes);
      });
    } else {
      filtered.sort((a, b) => sortByCount ? b.objectCount - a.objectCount : b.totalBytes - a.totalBytes);
    }
    return filtered;
  }, [query, types, sortByCount, comparison, growingOnly, everyInterval, intervals]);
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const currentPage = Math.max(0, Math.min(page, pageCount - 1));
  const firstRow = currentPage * PAGE_SIZE;
  useLayoutEffect(() => {
    const element = tableScroll.current;
    const position = analysis.getTablePosition();
    if (element) {
      element.scrollTop = position?.top ?? 0;
      element.scrollLeft = position?.left ?? 0;
    }
  }, [query, sortByCount, growingOnly, everyInterval, page, comparison, history]);
  const duration = result.durationMs < 1000 ? formatMilliseconds(result.durationMs) : formatDuration(result.durationMs);
  const hasFilters = query !== '' || everyInterval || (comparison && growingOnly);
  function clearFilters() {
    analysis.updateView({ query: '', everyInterval: false, growingOnly: false, page: 0 });
    searchInput.current?.focus();
  }
  function closeDetails() {
    closeInspection();
    if (inspectButton.current?.isConnected) inspectButton.current.focus({ preventScroll: true });
    else searchInput.current?.focus({ preventScroll: true });
  }
  const earlierReports = scopedReports.slice(0, last);
  const metrics = [
    { label: 'Managed memory', value: formatBytes(result.totalBytes), delta: comparison
      ? signed(result.totalBytes - comparison.totalBytes, formatBytes)
      : null },
    { label: 'Objects', value: result.objectCount.toLocaleString(), delta: comparison
      ? signed(result.objectCount - comparison.objectCount, (value) => value.toLocaleString())
      : null },
    { label: 'Types', value: types.filter((type) => type.objectCount > 0).length.toLocaleString() },
    ...(!result.reachableOnly ? [{ label: 'Free block bytes', value: formatBytes(result.freeBytes) }] : []),
  ];

  return (
    <>
      <section className="block-head dump-report-head">
        <div>
          <h2 title={result.path} className="dump-file-name">{fileNameOf(result.path)}</h2>
          <details className="dump-report-path">
            <summary>File location</summary>
            <code>{result.path}</code>
          </details>
          <p>Analyzed in {duration}. {result.reachableOnly ? 'Reachable objects only.' : 'Counts include objects awaiting collection.'}</p>
        </div>
        {baseline !== result && (
          <button type="button" className="btn btn-sm" disabled={phase !== 'idle'} onClick={() => {
            setBaselineId(dumpReportKey(result));
            setPage(0);
          }}>
            {baseline ? 'Use as new baseline' : 'Use as baseline'}
          </button>
        )}
      </section>
      {(reports.length > 1 || baseline) && <div className="dump-capture-controls">
        {earlierReports.length > 0 && <label className="field dump-baseline-picker">
          <span className="field-label">Compare with an earlier capture</span>
          <select className="input input-sm" value={comparison ? dumpReportKey(comparison) : ''} disabled={phase !== 'idle'}
            onChange={(event) => {
              setBaselineId(event.target.value || null);
              setPage(0);
            }}>
            <option value="">Choose a baseline…</option>
            {earlierReports.map((report, index) => <option key={dumpReportKey(report)} value={dumpReportKey(report)}>
              {fileNameOf(report.path)} · capture {index + 1} · {formatBytes(report.totalBytes)}
            </option>)}
          </select>
        </label>}
        {baseline && (
          <div className="notice notice-info dump-baseline">
            <div>
              <strong title={baseline.path}>Baseline · {fileNameOf(baseline.path)}</strong>
              <p>{comparison ? `Comparing ${history.length} captures in the chosen order.`
                : 'Choose a later dump from the same process and heap scope to compare growth.'}</p>
            </div>
            <button type="button" className="btn btn-sm btn-ghost" disabled={phase !== 'idle'} onClick={() => {
              setBaselineId(null);
              setPage(0);
            }}>
              Clear baseline
            </button>
          </div>
        )}
        {reports.length > 1 && (
          <section className="dump-timeline" aria-label="Loaded dump captures">
            <div className="dump-allocation-row">
              <span className="field-label">Captures · comparison order</span>
              <button type="button" className="btn btn-sm btn-ghost" disabled={phase !== 'idle'}
                aria-pressed={editingOrder} onClick={() => setEditingOrder(!editingOrder)}>
                {editingOrder ? 'Done ordering' : 'Edit order'}
              </button>
            </div>
            <ol>
              {reports.map((report, index) => {
                const peers = reports.filter((item) => item.reachableOnly === report.reachableOnly);
                const position = peers.indexOf(report);
                return (
                  <li key={dumpReportKey(report)}>
                    <button type="button" className="btn btn-sm btn-ghost" title={report.path}
                      aria-pressed={report === result} disabled={phase !== 'idle'} onClick={() => viewReport(report)}>
                      <span>{fileNameOf(report.path)}
                        {reports.some((other) => other.id !== report.id && fileNameOf(other.path) === fileNameOf(report.path))
                          ? ` · capture ${index + 1}` : ''}
                      </span>
                      <span className="dim">{formatBytes(report.totalBytes)} · {report.reachableOnly ? 'reachable' : 'all objects'}
                        {report === baseline ? ' · baseline' : ''}
                      </span>
                    </button>
                    {editingOrder && <div className="dump-order-actions">
                      <button type="button" className="btn btn-sm btn-ghost" disabled={phase !== 'idle' || position === 0}
                        aria-label={`Move ${report.path} ${report.reachableOnly ? 'reachable' : 'all objects'} earlier`}
                        onClick={() => analysis.moveReport(dumpReportKey(report), -1)}>Earlier</button>
                      <button type="button" className="btn btn-sm btn-ghost" disabled={phase !== 'idle' || position === peers.length - 1}
                        aria-label={`Move ${report.path} ${report.reachableOnly ? 'reachable' : 'all objects'} later`}
                        onClick={() => analysis.moveReport(dumpReportKey(report), 1)}>Later</button>
                    </div>}
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>}
      {result.notices.length > 0 && (
        <details className="notice notice-warning dump-notices">
          <summary>{result.notices.length} diagnostic {result.notices.length === 1 ? 'notice' : 'notices'}</summary>
          <pre>{result.notices.join('\n')}</pre>
        </details>
      )}
      <div className={`metrics-strip dump-metrics${result.reachableOnly ? '' : ' has-free-blocks'}`}>
        {metrics.map(({ label, value, delta }) => (
          <div className="metric-tile" key={label}>
            <span className="field-label">{label}</span>
            <span className="metric-value">{value}</span>
            {delta && <span className="metric-sub">{delta} vs baseline</span>}
          </div>
        ))}
      </div>
      <div className={`dump-workspace${inspection ? ' has-inspection' : ''}`}>
        <section className="dump-type-browser" aria-labelledby="dump-types-title">
          <div className="block-head dump-table-head">
            <div>
              <h2 id="dump-types-title">{comparison ? 'Type growth since baseline' : 'Managed heap by type'}</h2>
              <p>Inspect a type to trace what keeps its objects alive.</p>
            </div>
          </div>
          <div className="table-controls dump-type-controls">
            {comparison && (
              <label className="dump-growth-filter">
                <input type="checkbox" checked={growingOnly} onChange={(event) => {
                  analysis.updateView({ growingOnly: event.target.checked, page: 0 });
                }} />
                Growing only
              </label>
            )}
            {intervals > 1 && (
              <label className="dump-growth-filter">
                <input type="checkbox" checked={everyInterval} onChange={(event) => {
                  analysis.updateView({ everyInterval: event.target.checked, page: 0 });
                }} />
                Grew in every interval
              </label>
            )}
            <input
              ref={searchInput}
              type="search"
              className="input input-sm"
              aria-label="Filter by type or method table"
              placeholder="Search type or method table"
              value={query}
              onChange={(event) => {
                analysis.updateView({ query: event.target.value, page: 0 });
              }}
            />
            <select
              className="input input-sm"
              aria-label="Sort heap types"
              value={sortByCount ? 'count' : 'bytes'}
              onChange={(event) => {
                analysis.updateView({ sortByCount: event.target.value === 'count', page: 0 });
              }}
            >
              <option value="bytes">{comparison ? 'By byte growth' : 'By bytes'}</option>
              <option value="count">{comparison ? 'By object growth' : 'By object count'}</option>
            </select>
          </div>
          <div className="dump-table-summary">
            <span className="dim" role="status">
              {rows.length ? `${(firstRow + 1).toLocaleString()}–${Math.min(firstRow + PAGE_SIZE, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} types`
                : '0 matching types'}
            </span>
            {hasFilters && <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>Clear filters</button>}
          </div>
          {rows.length === 0 ? (
            <p className="empty-note">
              {comparison && growingOnly && !everyInterval && !query.trim()
                ? 'No types grew since the baseline.' : 'No types match this view.'}
            </p>
          ) : (
            <div className="dump-table-scroll" ref={tableScroll} tabIndex={0} role="region" aria-labelledby="dump-types-title"
              onScroll={(event) => analysis.rememberTablePosition(event.currentTarget.scrollTop, event.currentTarget.scrollLeft)}>
              <table className={`data-table dump-table${comparison ? ' is-comparison' : ''}${intervals > 1 ? ' has-intervals' : ''}`}>
                <colgroup>
                  <col />
                  <col className="dump-number-column" />
                  <col className="dump-number-column" />
                  {comparison ? <>
                    <col className="dump-number-column" />
                    <col className="dump-number-column" />
                    {intervals > 1 && <col className="dump-interval-column" />}
                  </> : <col className="dump-share-column" />}
                  <col className="dump-action-column" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">{comparison ? 'Objects now' : 'Objects'}</th>
                    <th scope="col" className="num">{comparison ? 'Bytes now' : 'Bytes'}</th>
                    {comparison ? (
                      <>
                        <th scope="col" className="num">Object change</th>
                        <th scope="col" className="num">Byte change</th>
                        {intervals > 1 && <th scope="col" className="num">Growing intervals</th>}
                      </>
                    ) : <th scope="col" className="share-col">Share</th>}
                    <th scope="col">Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(firstRow, firstRow + PAGE_SIZE).map((row) => {
                    const share = result.totalBytes > 0 ? (row.totalBytes / result.totalBytes) * 100 : 0;
                    const table = row.methodTables[0];
                    const selected = inspection?.typeName === row.typeName;
                    return (
                      <tr key={row.typeName} className={selected ? 'is-inspected' : undefined}>
                        <td className="type-name" title={row.methodTables.length === 1 ? `${row.typeName} (MT ${table.methodTable})` : row.typeName}>
                          {row.typeName}
                        </td>
                        <td className="num">{row.objectCount.toLocaleString()}</td>
                        <td className="num" title={`${row.totalBytes.toLocaleString()} bytes`}>{formatBytes(row.totalBytes)}</td>
                        {comparison ? (
                          <>
                            <td className={row.deltaCount > 0 ? 'num dump-growth' : 'num'}>
                              {signed(row.deltaCount, (value) => value.toLocaleString())}
                            </td>
                            <td className={row.deltaBytes > 0 ? 'num dump-growth' : 'num'}>
                              {signed(row.deltaBytes, formatBytes)}
                            </td>
                            {intervals > 1 && (
                              <td className="num" title={sortByCount ? 'Object count grew' : 'Bytes grew'}>
                                {sortByCount ? row.growingCountIntervals : row.growingByteIntervals}/{intervals}
                              </td>
                            )}
                          </>
                        ) : (
                          <td className="share-col">
                            <span className="share-bar" aria-hidden="true">
                              <span className="share-fill" style={{ width: `${share}%` }} />
                            </span>
                            <span className="share-text">{formatPercent(share)}</span>
                          </td>
                        )}
                        <td>
                          {row.methodTables.length > 0 && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost dump-root-button"
                              aria-label={`Inspect ${row.typeName}`}
                              disabled={phase !== 'idle'}
                              aria-pressed={selected}
                              onClick={(event) => {
                                inspectButton.current = event.currentTarget;
                                if (!selected) selectType(row.typeName, row.methodTables);
                                else document.getElementById('dump-inspection-title')?.focus();
                              }}
                            >
                              {selected ? 'Viewing' : 'Inspect'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {pageCount > 1 && (
            <div className="table-controls dump-pagination">
              <button type="button" className="btn btn-sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                Previous
              </button>
              <span className="dim" role="status">Page {currentPage + 1} of {pageCount}</span>
              <button type="button" className="btn btn-sm" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>
                Next
              </button>
            </div>
          )}
        </section>
        <DumpInspection analysis={analysis} traces={traces} reports={history} onClose={closeDetails}
          change={types.find((row) => row.typeName === inspection?.typeName) ?? null} baseline={comparison} />
      </div>
    </>
  );
}

function signed(value: number, format: (value: number) => string): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + format(Math.abs(value));
}
