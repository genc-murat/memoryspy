import { useEffect, useMemo, useState } from 'react';

import { DumpInspection } from './DumpInspection';
import { compareDumpTypes, dumpReportKey } from '../lib/dumpComparison';
import { fileNameOf, formatBytes, formatDuration, formatMilliseconds, formatPercent } from '../lib/format';
import { isTauri } from '../lib/ipc';
import type { AllocationSiteData, DumpAnalysis } from '../lib/types';
import type { useDumpAnalysis } from '../lib/useDumpAnalysis';

const PAGE_SIZE = 100;

type Analysis = ReturnType<typeof useDumpAnalysis>;

export function DumpPanel({ analysis, traces }: { analysis: Analysis; traces: AllocationSiteData[] }) {
  const { path, setPath, reachableOnly, setReachableOnly, result, phase, error, status, work, pick, analyze, cancel } = analysis;
  const available = isTauri();

  return (
    <div className="panel">
      <div className="block-head">
        <div>
          <h2>Analyze a .NET memory dump</h2>
          <p>Open a Full or Heap dump collected with <code>dotnet-dump collect</code>.</p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void analyze();
        }}
      >
        <label className="field-label" htmlFor="dump-path">Dump file path</label>
        <div className="recording-import-row dump-import-row">
          <input
            id="dump-path"
            className="input"
            placeholder="C:\dumps\common1.dmp"
            value={path}
            spellCheck={false}
            disabled={!available || phase !== 'idle'}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="button" className="btn btn-sm" disabled={!available || phase !== 'idle'} onClick={() => void pick()}>
            Browse…
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!available || !path.trim() || phase !== 'idle'}>
            Analyze
          </button>
        </div>
        <div className="dump-scope">
          <label className="field">
            <span className="field-label">Heap scope</span>
            <select className="input input-sm" value={reachableOnly ? 'reachable' : 'all'}
              disabled={!available || phase !== 'idle'} onChange={(event) => setReachableOnly(event.target.value === 'reachable')}>
              <option value="all">All managed objects</option>
              <option value="reachable">Reachable objects only</option>
            </select>
          </label>
          {reachableOnly && <span className="caveat">Walks the GC reference graph. Large heaps can take more time and RAM.</span>}
        </div>
      </form>
      {!available && <p className="caveat">Open MemorySpy on the desktop to analyze a local file.</p>}
      {status && <p className="dim" role="status">{status}</p>}
      {error && <div className="inline-error inline-error-wide dump-error dump-operation-error" role="alert">{error}</div>}
      {work && <DumpProgress work={work} cancelling={phase === 'cancelling'} cancel={cancel} />}
      {result && <DumpResults key={dumpReportKey(result)} result={result} analysis={analysis} traces={traces} />}
    </div>
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
        {work.detail && <p>{work.detail}</p>}
        <progress aria-label={work.message} max={100} value={percent === undefined ? undefined : Number(percent)} />
      </div>
      <span className="tag-mono">{formatDuration(elapsed)}</span>
      <button type="button" className="btn btn-sm" disabled={cancelling} onClick={() => void cancel()}>
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  );
}

function DumpResults({ result, analysis, traces }: { result: DumpAnalysis; analysis: Analysis; traces: AllocationSiteData[] }) {
  const { baseline, setBaselineId, reports, viewReport, selectType, phase } = analysis;
  const [query, setQuery] = useState('');
  const [sortByCount, setSortByCount] = useState(false);
  const [growingOnly, setGrowingOnly] = useState(true);
  const [everyInterval, setEveryInterval] = useState(false);
  const [page, setPage] = useState(0);
  const scopedReports = useMemo(() => reports.filter((report) => report.reachableOnly === result.reachableOnly),
    [reports, result.reachableOnly]);
  const first = baseline ? scopedReports.indexOf(baseline) : -1;
  const last = scopedReports.indexOf(result);
  const comparison = first >= 0 && last > first ? baseline : null;
  const history = useMemo(() => scopedReports.slice(comparison ? first : 0, last + 1),
    [comparison, scopedReports, first, last]);
  const intervals = comparison ? history.length - 1 : 0;

  const types = useMemo(() => comparison
    ? compareDumpTypes(history.map((report) => report.types))
    : result.types.map((row) => ({
      ...row, methodTables: [{ ...row, baselineCount: null, baselineBytes: null }],
      deltaCount: 0, deltaBytes: 0, growingCountIntervals: 0, growingByteIntervals: 0,
    })),
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
    } else if (sortByCount) {
      filtered.sort((a, b) => b.objectCount - a.objectCount);
    }
    return filtered;
  }, [query, types, sortByCount, comparison, growingOnly, everyInterval, intervals]);
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const currentPage = Math.max(0, Math.min(page, pageCount - 1));
  const firstRow = currentPage * PAGE_SIZE;
  const duration = result.durationMs < 1000 ? formatMilliseconds(result.durationMs) : formatDuration(result.durationMs);
  const metrics = [
    { label: 'Object bytes', value: formatBytes(result.totalBytes), delta: comparison
      ? signed(result.totalBytes - comparison.totalBytes, formatBytes)
      : null },
    { label: 'Objects', value: result.objectCount.toLocaleString(), delta: comparison
      ? signed(result.objectCount - comparison.objectCount, (value) => value.toLocaleString())
      : null },
    { label: 'Type entries', value: result.types.length.toLocaleString() },
    ...(!result.reachableOnly ? [{ label: 'Free block bytes', value: formatBytes(result.freeBytes) }] : []),
  ];

  return (
    <>
      <section className="block-head">
        <div>
          <h2 title={result.path} className="dump-file-name">{fileNameOf(result.path)}</h2>
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
      {baseline && (
        <div className="notice notice-info dump-baseline">
          <div>
            <strong title={baseline.path}>Baseline · {fileNameOf(baseline.path)}</strong>
            <p>{comparison ? `Comparing ${history.length} captures in the order added.`
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
          <span className="field-label">Captures · in the order added</span>
          <ol>
            {reports.map((report, index) => (
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
              </li>
            ))}
          </ol>
        </section>
      )}
      {result.notices.length > 0 && (
        <div className="notice notice-warning dump-error">{result.notices.join('\n')}</div>
      )}
      <div className="metrics-strip">
        {metrics.map(({ label, value, delta }) => (
          <div className="metric-tile" key={label}>
            <span className="field-label">{label}</span>
            <span className="metric-value">{value}</span>
            {delta && <span className="metric-sub">{delta} vs baseline</span>}
          </div>
        ))}
      </div>
      <DumpInspection analysis={analysis} traces={traces} reports={history} />
      <section>
        <div className="block-head dump-table-head">
          <h2>{comparison ? 'Type growth since baseline' : 'Managed heap by type'}</h2>
          <div className="table-controls">
            {comparison && (
              <label className="dump-growth-filter">
                <input type="checkbox" checked={growingOnly} onChange={(event) => {
                  setGrowingOnly(event.target.checked);
                  setPage(0);
                }} />
                Growing only
              </label>
            )}
            {intervals > 1 && (
              <label className="dump-growth-filter">
                <input type="checkbox" checked={everyInterval} onChange={(event) => {
                  setEveryInterval(event.target.checked);
                  setPage(0);
                }} />
                Grew in every interval
              </label>
            )}
            <input
              type="search"
              className="input input-sm"
              aria-label="Filter by type or method table"
              placeholder="Filter types"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
            <select
              className="input input-sm"
              aria-label="Sort heap types"
              value={sortByCount ? 'count' : 'bytes'}
              onChange={(event) => {
                setSortByCount(event.target.value === 'count');
                setPage(0);
              }}
            >
              <option value="bytes">{comparison ? 'By byte growth' : 'By bytes'}</option>
              <option value="count">{comparison ? 'By object growth' : 'By object count'}</option>
            </select>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="empty-note">
            {comparison && growingOnly && !everyInterval && !query.trim()
              ? 'No types grew since the baseline.' : 'No types match this view.'}
          </p>
        ) : (
          <table className="data-table dump-table">
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
                return (
                  <tr key={comparison ? row.typeName : table.methodTable}>
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
                          onClick={() => selectType(row.typeName, row.methodTables)}
                        >
                          Inspect
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
    </>
  );
}

function signed(value: number, format: (value: number) => string): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + format(Math.abs(value));
}
