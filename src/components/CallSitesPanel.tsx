import { Fragment, useMemo, useState } from 'react';

import { formatBytes, formatDuration, formatPercent, formatSourceLocation, formatSourcePath } from '../lib/format';
import type { AllocationSite, AllocationSiteData } from '../lib/types';
import type { MetricsStore } from '../lib/store';

interface Props {
  store: MetricsStore;
}

type SortKey = 'bytes' | 'samples' | 'size';
type View = 'sites' | 'types';

const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'bytes', label: 'Sampled volume', hint: 'Sampled allocation bytes attributed to the site — the best signal for “who creates the most”.' },
  { key: 'samples', label: 'Sample count', hint: 'How many allocations were sampled here. A low count means the share is noisy.' },
  { key: 'size', label: 'Average object size', hint: 'Average sampled object size at this site. Large values point at the Large Object Heap.' },
];

const VIEWS: { key: View; label: string; hint: string }[] = [
  { key: 'sites', label: 'By call site', hint: 'Ranked by code: which statement creates the memory.' },
  { key: 'types', label: 'By type', hint: 'Ranked by type: where each type is created — the answer for framework types.' },
];

/**
 * Identity of a row.
 *
 * Not the method name on its own: with a PDB two statements inside one method are two rows, so
 * the method name alone would collide and break row expansion.
 */
function rowKey(site: Pick<AllocationSite, 'site' | 'sourceFile' | 'sourceLine'>): string {
  return `${site.site}|${site.sourceFile ?? ''}:${site.sourceLine ?? ''}`;
}

/** Says how far the source lookup got, and what to do about it when it did not. */
function sourceNote(analysis: AllocationSiteData): string {
  const total = analysis.sitesWithSource + analysis.sitesWithoutSource;
  const missing = analysis.modulesWithoutSource;

  // An empty window has no sites to locate, so blaming the PDBs would be a wrong diagnosis of a
  // different problem — usually a target that allocated almost nothing while it was attached.
  if (total === 0) {
    return 'No allocation was sampled in this window, so there is nothing to locate yet.';
  }

  // A truncated lookup outranks the other explanations: when the phase stopped early, "no PDB was
  // found" is a wrong diagnosis of a lookup that was never finished, and the only honest thing to
  // say is why it stopped. The collector's reason is quoted rather than paraphrased, because it
  // carries two numbers the UI does not have — the budget and the wall clock it really cost.
  if (analysis.symbolStopReason) {
    return analysis.sitesWithSource === 0
      ? `No line could be read: the lookup ${analysis.symbolStopReason}, so every site is named by method alone.`
      : `${analysis.sitesWithSource} of ${total} sites resolved to a file and line; the lookup ` +
          `${analysis.symbolStopReason}, so the rest keep a method name.`;
  }

  if (analysis.sitesWithSource === 0) {
    return (
      'No PDB could be read for the allocating modules, so every site is named by method alone. Keep the .pdb next to the ' +
      'assembly, or set _NT_SYMBOL_PATH so a symbol server can supply it.'
    );
  }

  if (analysis.sitesWithoutSource === 0) {
    return `Every site resolved to a file and line, read from the modules' PDBs.`;
  }

  const share = `${analysis.sitesWithSource} of ${total} sites resolved to a file and line`;
  const because =
    missing.length > 0
      ? `; the rest keep a method name because no PDB was found for ${missing.join(', ')}`
      : '; the rest keep a method name because their PDB had no line for that address';

  return `${share}${because}.`;
}

/**
 * Answers “which code block is responsible?”.
 *
 * The whole reason this panel exists is the gap the other views leave. A type name only
 * identifies a culprit when the type is yours; when the growth is `byte[]`, `string` or a
 * dictionary's internals there is no `new byte[]` to search for, and the type leaderboard is a
 * dead end. Here the runtime's own allocation stacks are resolved to a file and line — the
 * statement, not merely the method — so the answer is a block of code even for framework types.
 *
 * Two facts shape the presentation, and both are stated in the UI rather than hidden:
 *
 * *The numbers are sampled.* The runtime reports samples proportional to allocated bytes, so
 * shares between sites are trustworthy while absolute totals are not. Every volume is shown
 * with its share for exactly that reason.
 *
 * *The line needs a PDB.* The runtime's stacks carry an IL offset, and only the PDB can turn
 * that into a file and line, so a site whose module has no symbols falls back to the method
 * name — and the panel says so on the row instead of quietly showing less.
 *
 * The answer also arrives after the session stops: call stacks cannot be resolved on a live
 * EventPipe stream, which is why this view is fed by analysing a raw capture once the session
 * ends, and why a replay of that session shows the same call sites offline.
 */
export function CallSitesPanel({ store }: Props) {
  const [sort, setSort] = useState<SortKey>('bytes');
  const [view, setView] = useState<View>('sites');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const analysis = store.allocationSites[0] ?? null;

  const sites = useMemo(() => {
    if (!analysis) return [];
    const all = [...analysis.sites];
    const comparator = (a: AllocationSite, b: AllocationSite) => {
      switch (sort) {
        case 'samples':
          return b.samples - a.samples;
        case 'size':
          return b.averageObjectBytes - a.averageObjectBytes;
        default:
          return b.sampledBytes - a.sampledBytes;
      }
    };
    return all.sort(comparator);
  }, [analysis, sort]);

  const needle = filter.trim().toLowerCase();
  const filteredSites = needle
    ? sites.filter(
        (site) =>
          site.site.toLowerCase().includes(needle) ||
          (site.sourceFile ?? '').toLowerCase().includes(needle) ||
          (site.dominantTypeName ?? '').toLowerCase().includes(needle) ||
          site.frames.some(
            (frame) => frame.method.toLowerCase().includes(needle) || (frame.sourceFile ?? '').toLowerCase().includes(needle),
          ),
      )
    : sites;

  const filteredTypes = analysis
    ? needle
      ? analysis.types.filter(
          (type) =>
            type.typeName.toLowerCase().includes(needle) ||
            (type.dominantSite ?? '').toLowerCase().includes(needle) ||
            (type.dominantSourceFile ?? '').toLowerCase().includes(needle),
        )
      : analysis.types
    : [];

  if (!analysis) {
    return (
      <div className="panel">
        <div className="notice notice-info">
          <strong>No call sites yet.</strong> Naming the code that allocates needs the raw event stream, because call
          stacks — and the source lines behind them — can only be resolved from a finished capture, so this view is
          filled by a <em>deep capture</em>, not by the live session.
          <ul className="notice-list">
            <li>Switch on <strong>Deep capture</strong> in the rail, then attach — it has to be armed before the session starts.</li>
            <li>Let the target run for a while so the sampler sees enough allocations.</li>
            <li>Detach. The capture is converted and this view fills in a second or two later.</li>
          </ul>
          <p className="caveat">
            Sites are shown as <code>File.cs:412</code> when the module's PDB can be read, and as a method name when it
            cannot — a Debug or Release build with its <code>.pdb</code> next to the assembly gives the line.
          </p>
          {store.capturePath && (
            <p className="caveat">
              Capturing now: <code>{store.capturePath}</code>
              {store.captureBytes > 0 ? ` (${formatBytes(store.captureBytes)} so far)` : ''}
            </p>
          )}
        </div>
      </div>
    );
  }

  const top = sites[0];
  const topLocation = top ? formatSourceLocation(top.sourceFile, top.sourceLine) : null;
  const captureDate = new Date(analysis.windowEndUnixMs).toLocaleTimeString();

  return (
    <div className="panel">
      {top && (
        <section className="suspect-banner">
          <div className="suspect-lead">
            <span className="eyebrow">Top allocating code</span>
            <span className="suspect-name site-name" title={formatSourcePath(top.sourceFile, top.sourceLine) ?? top.site}>
              {topLocation ?? top.site}
            </span>
            <span className="suspect-meta">
              {formatPercent(top.share * 100)} of sampled bytes · {formatBytes(top.sampledBytes)}
              {top.dominantTypeName && <span className="chip">{top.dominantTypeName}</span>}
              {!top.userCode && <span className="chip chip-warning">runtime-internal</span>}
              {!topLocation && <span className="chip chip-quiet">no PDB</span>}
            </span>
          </div>
          {topLocation && (
            <p className="suspect-subject">
              <code>{top.site}</code>
            </p>
          )}
          <p className="suspect-advice">
            {formatBytes(top.sampledBytes)} of sampled allocations in this capture came from{' '}
            {topLocation ? 'this statement' : 'this method'}
            {top.dominantTypeName ? `, mostly ${top.dominantTypeName}` : ''}. Open it and check whether the objects it
            creates are being retained — allocation volume alone is not a leak, so pair this with the heap trend.
          </p>
        </section>
      )}

      <section className="block-head block-head-sticky">
        <div>
          <h2>Allocation call sites</h2>
          <p className="caveat">
            {analysis.sampling} Resolved from <code>{analysis.captureFile}</code> ({formatBytes(analysis.captureBytes)}) —
            the {formatDuration(analysis.durationMs)} window ending at {captureDate}. Conversion took{' '}
            {analysis.conversionMs} ms, analysis {analysis.analysisMs} ms
            {analysis.symbolMs > 0 ? ` (${analysis.symbolMs} ms of it reading PDBs)` : ''}.{' '}
            {analysis.sampledEvents.toLocaleString()} sampled allocations across {analysis.distinctSites} sites and{' '}
            {analysis.distinctTypes} types
            {analysis.droppedSites > 0 ? `, with ${analysis.droppedSites} sites dropped at the reporting cap` : ''}
            {analysis.unresolvedFrames > 0 ? `; ${analysis.unresolvedFrames} frames had no resolvable method` : ''}.
          </p>
          <p className="caveat">
            {sourceNote(analysis)}
            {analysis.symbolPath ? ` Symbols were looked up along _NT_SYMBOL_PATH (${analysis.symbolPath}).` : ''}
          </p>
        </div>
        <div className="table-controls">
          <input
            className="input input-sm"
            placeholder="Filter files, methods, types"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
          />
          <select className="input input-sm" value={view} onChange={(event) => setView(event.target.value as View)}>
            {VIEWS.map((option) => (
              <option key={option.key} value={option.key} title={option.hint}>
                {option.label}
              </option>
            ))}
          </select>
          {view === 'sites' && (
            <select className="input input-sm" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              {SORTS.map((option) => (
                <option key={option.key} value={option.key} title={option.hint}>
                  Sort: {option.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </section>

      {view === 'sites' ? (
        <table className="data-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Call site</th>
              <th className="num">Sampled</th>
              <th className="share-col">Share</th>
              <th className="num">Samples</th>
              <th className="num">Avg obj</th>
              <th>Mostly allocates</th>
            </tr>
          </thead>
          <tbody>
            {filteredSites.slice(0, 200).map((site, index) => {
              const key = rowKey(site);
              const location = formatSourceLocation(site.sourceFile, site.sourceLine);
              const tip = formatSourcePath(site.sourceFile, site.sourceLine);

              return (
                <Fragment key={key}>
                  <tr
                    className={index === 0 ? 'row-suspect' : undefined}
                    onClick={() => setExpanded(expanded === key ? null : key)}
                    title="Click to show the call chain"
                  >
                    <td className="num dim">{index + 1}</td>
                    <td className="type-name site-cell" title={tip ? `${tip}\n${site.site}` : site.site}>
                      <span className="disclosure">{expanded === key ? '▾' : '▸'}</span>
                      <span className="site-labels">
                        <span className={`site-location${location ? '' : ' site-location-method'}`} title={site.site}>
                          {location ?? site.site}
                        </span>
                        {location && <span className="site-method">{site.site}</span>}
                      </span>
                      {!site.userCode && <span className="chip chip-quiet">runtime</span>}
                      {!location && (
                        <span
                          className="chip chip-quiet"
                          title="No PDB was found for this site's module, so only the method name is known."
                        >
                          no PDB
                        </span>
                      )}
                    </td>
                    <td className="num">{formatBytes(site.sampledBytes)}</td>
                    <td className="share-col">
                      <span className="share-bar">
                        <span className="share-fill" style={{ width: `${Math.min(100, site.share * 100)}%` }} />
                      </span>
                      <span className="share-text">{formatPercent(site.share * 100, 1)}</span>
                    </td>
                    <td className="num dim">{site.samples.toLocaleString()}</td>
                    <td className="num">{formatBytes(site.averageObjectBytes)}</td>
                    <td className="type-name" title={site.dominantTypeName ?? ''}>
                      {site.dominantTypeName ?? '—'}
                    </td>
                  </tr>
                  {expanded === key && (
                    <tr className="row-detail">
                      <td />
                      <td colSpan={6}>
                        <div className="frame-detail">
                          <span className="eyebrow">
                            Call chain, allocation first{location ? '' : ' (method names: no PDB was readable)'}
                          </span>
                          <ol className="frame-list">
                            {site.frames.map((frame, frameIndex) => {
                              const frameLocation = formatSourceLocation(frame.sourceFile, frame.sourceLine);
                              return (
                                <li key={`${frame.method}-${frameIndex}`} className={frameIndex === 0 ? 'frame-site' : undefined}>
                                  {frameLocation ? (
                                    <>
                                      <code title={formatSourcePath(frame.sourceFile, frame.sourceLine) ?? frame.method}>
                                        {frameLocation}
                                      </code>{' '}
                                      <span className="frame-method">{frame.method}</span>
                                    </>
                                  ) : (
                                    <code>{frame.method}</code>
                                  )}
                                </li>
                              );
                            })}
                          </ol>
                          {site.types.length > 0 && (
                            <>
                              <span className="eyebrow">Types allocated here</span>
                              <ul className="frame-list">
                                {site.types.map((type) => (
                                  <li key={type.typeName}>
                                    <code>{type.typeName}</code>{' '}
                                    <span className="dim">
                                      {formatBytes(type.sampledBytes)} · {formatPercent(type.share * 100)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Type</th>
              <th className="num">Sampled</th>
              <th className="share-col">Share</th>
              <th className="num">Samples</th>
              <th>Mostly allocated by</th>
            </tr>
          </thead>
          <tbody>
            {filteredTypes.slice(0, 200).map((type, index) => {
              const location = formatSourceLocation(type.dominantSourceFile, type.dominantSourceLine);
              const tip = formatSourcePath(type.dominantSourceFile, type.dominantSourceLine);

              return (
                <tr key={type.typeName}>
                  <td className="num dim">{index + 1}</td>
                  <td className="type-name" title={type.typeName}>
                    {type.typeName}
                  </td>
                  <td className="num">{formatBytes(type.sampledBytes)}</td>
                  <td className="share-col">
                    <span className="share-bar">
                      <span className="share-fill" style={{ width: `${Math.min(100, type.share * 100)}%` }} />
                    </span>
                    <span className="share-text">{formatPercent(type.share * 100, 1)}</span>
                  </td>
                  <td className="num dim">{type.samples.toLocaleString()}</td>
                  <td className="type-name site-cell" title={tip ? `${tip}\n${type.dominantSite ?? ''}` : type.dominantSite ?? ''}>
                    <span className="site-labels">
                      <span className={`site-location${location ? '' : ' site-location-method'}`}>
                        {location ?? type.dominantSite ?? '—'}
                      </span>
                      {location && type.dominantSite && <span className="site-method">{type.dominantSite}</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="empty-note">
        A site is the method the runtime reported, plus its line when the module's PDB could be read — which is what
        separates two allocation sites inside one method. Method names are exactly what the runtime reports, so they can
        be pasted into an IDE's “find usages”; code compiled from top-level statements shows up under compiler-generated
        names such as <code>Program.&lt;&lt;&lt;Main&gt;$&gt;g__RunCache|0_7&gt;d.MoveNext()</code>.
        {analysis.frameworkOnlySites > 0 &&
          (analysis.frameworkOnlySites === 1
            ? ' 1 allocation was entirely inside the runtime, with no user frame to point at.'
            : ` ${analysis.frameworkOnlySites} allocations were entirely inside the runtime, with no user frame to point at.`)}
      </p>
    </div>
  );
}
