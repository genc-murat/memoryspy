import { useEffect, useMemo, useRef, useState } from 'react';

import { fileNameOf, formatBytes } from '../lib/format';
import type { DumpTypeChange } from '../lib/dumpComparison';
import { allocationTraceKey, groupDumpChain } from '../lib/dumpEvidence';
import { DumpReport } from './DumpReport';
import { dumpApi } from '../lib/ipc';
import type { AllocationSiteData, DumpAnalysis, DumpMethodTable, DumpReference, DumpRootPath, DumpSourceLocation, SourcePreview } from '../lib/types';
import type { useDumpAnalysis } from '../lib/useDumpAnalysis';

type Analysis = ReturnType<typeof useDumpAnalysis>;

export function DumpInspection({ analysis, traces, reports, onClose, change, baseline }: {
  analysis: Analysis;
  traces: AllocationSiteData[];
  reports: DumpAnalysis[];
  onClose: () => void;
  change: DumpTypeChange | null;
  baseline: DumpAnalysis | null;
}) {
  const { inspection } = analysis;
  if (!inspection) return null;
  return (
    <Inspection
      key={`${inspection.typeName}|${inspection.methodTables.map((table) => table.methodTable).join(',')}`}
      analysis={analysis}
      inspection={{ ...inspection, methodTables: change?.methodTables ?? inspection.methodTables }}
      traces={traces}
      reports={reports}
      onClose={onClose}
      change={change}
      baseline={baseline}
    />
  );
}

function Inspection({ analysis, inspection, traces, reports, onClose, change, baseline }: {
  analysis: Analysis;
  inspection: NonNullable<Analysis['inspection']>;
  traces: AllocationSiteData[];
  reports: DumpAnalysis[];
  onClose: () => void;
  change: DumpTypeChange | null;
  baseline: DumpAnalysis | null;
}) {
  const details = useRef<HTMLElement>(null);
  const { minKiB, selected, skipStacks, tab } = inspection;
  const setMinKiB = (minKiB: string) => analysis.updateInspection({ minKiB });
  const setSelected = (selected: string[]) => analysis.updateInspection({ selected });
  const setTab = (tab: string) => analysis.updateInspection({ tab });
  const busy = analysis.phase !== 'idle';
  const minBytes = Number(minKiB) * 1024;
  const validMinimum = minKiB.trim() !== '' && Number.isInteger(Number(minKiB)) &&
    Number.isSafeInteger(minBytes) && minBytes >= 0;
  useEffect(() => {
    details.current?.focus({ preventScroll: true });
    details.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const sampled = inspection.objects;
  const roots = inspection.roots;
  const candidates = sampled?.filter((object) => selected.includes(object.address)) ?? [];
  const totals = inspection.methodTables.reduce((total, table) => ({
    objects: total.objects + table.objectCount,
    bytes: total.bytes + table.totalBytes,
  }), { objects: 0, bytes: 0 });
  const tabs = [
    { id: 'retention', label: 'Retaining references' },
    { id: 'allocations', label: 'Allocation sites' },
    ...(reports.length > 1 ? [{ id: 'history', label: 'Growth history' }] : []),
    { id: 'report', label: 'Report' },
  ];

  async function findSamples(minimum: number) {
    await analysis.findObjects(minimum);
  }

  return (
    <section className="dump-roots dump-inspection" ref={details} tabIndex={-1} aria-labelledby="dump-inspection-title">
      <div className="block-head dump-inspection-head">
        <div>
          <span className="field-label">Inspect type</span>
          <h2 id="dump-inspection-title" tabIndex={-1}><code>{inspection.typeName}</code></h2>
          <p>{totals.objects.toLocaleString()} objects · {formatBytes(totals.bytes)}</p>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onClose}>Close inspection</button>
      </div>
      <div className="dump-inspection-tabs" role="tablist" aria-label="Type investigation" onKeyDown={(event) => {
        const index = tabs.findIndex((item) => item.id === tab);
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        setTab(tabs[next].id);
        document.getElementById(`dump-tab-${tabs[next].id}`)?.focus();
      }}>
        {tabs.map((item) => <button key={item.id} type="button" role="tab" id={`dump-tab-${item.id}`}
          aria-selected={tab === item.id} aria-controls={`dump-tabpanel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <div role="tabpanel" id="dump-tabpanel-history" aria-labelledby="dump-tab-history" hidden={tab !== 'history'}>
        {reports.length > 1 && <TypeHistory reports={reports} typeName={inspection.typeName} />}
      </div>
      <div role="tabpanel" id="dump-tabpanel-allocations" aria-labelledby="dump-tab-allocations" hidden={tab !== 'allocations'}>
        <AllocationEvidence traces={traces} typeName={inspection.typeName}
          selectedTrace={analysis.allocationTrace} linkTrace={analysis.linkAllocationTrace} />
      </div>
      <div role="tabpanel" id="dump-tabpanel-report" aria-labelledby="dump-tab-report" hidden={tab !== 'report'}>
        {analysis.result && <DumpReport analysis={analysis} report={analysis.result} inspection={inspection}
          reports={reports} baseline={baseline}
          trace={traces.find((trace) => allocationTraceKey(trace) === analysis.allocationTrace) ?? null} />}
      </div>
      <div className="dump-retention-panel" role="tabpanel" id="dump-tabpanel-retention" aria-labelledby="dump-tab-retention"
        hidden={tab !== 'retention'}>
        <details className="dump-samples" open={!roots}>
          <summary>{sampled?.length ? `${candidates.length} of ${sampled.length} samples selected` : 'Choose objects to trace'}</summary>
          {inspection.methodTables.length > 1 && (
            <MethodTables tables={inspection.methodTables} selected={inspection.methodTable} disabled={busy}
              onSelect={(methodTable) => {
                setSelected([]);
                analysis.selectMethodTable(methodTable);
              }} />
          )}
          <form className="table-controls dump-sample-controls" onSubmit={(event) => {
            event.preventDefault();
            if (!validMinimum || !inspection.methodTable) return;
            void findSamples(minBytes);
          }}>
            <button type="submit" className="btn btn-sm" disabled={busy || !validMinimum || !inspection.methodTable}>
              {sampled ? 'Refresh objects' : 'Find objects'}
            </button>
            <details className="dump-sample-filter">
              <summary>Object size filter{minBytes > 0 && validMinimum ? ` · ≥ ${formatBytes(minBytes)}` : ''}</summary>
              <label className="field">
                <span className="field-label">Minimum object size (KiB)</span>
                <input className="input input-sm" type="number" min={0} step={1} value={minKiB}
                  aria-invalid={!validMinimum}
                  disabled={busy} onChange={(event) => setMinKiB(event.target.value)} />
              </label>
              {!validMinimum && <span className="inline-error">Enter a whole number of KiB, starting at 0.</span>}
            </details>
          </form>
          {sampled === null && <p className="caveat">Find sample objects, then trace up to three back to their GC roots.</p>}
          {sampled?.length === 0 && <div className="dump-sample-empty">
            <p className="dim">No objects match this size filter.</p>
            {minBytes > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => {
              setMinKiB('0');
              void findSamples(0);
            }}>Find without size filter</button>}
          </div>}
          {sampled && sampled.length > 0 && (
            <>
              <div className="dump-allocation-row dump-selection-actions">
                <span className="field-label" role="status">{candidates.length} / 3 selected</span>
                <div className="table-controls">
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
                    onClick={() => setSelected(sampled.slice(0, 3).map((object) => object.address))}>Select first 3</button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy || !selected.length}
                    onClick={() => setSelected([])}>Clear selection</button>
                </div>
              </div>
              <div className="dump-object-list">
                {sampled.map((object) => (
                  <label key={object.address} className={selected.includes(object.address) ? 'is-selected' : undefined}>
                    <input type="checkbox" checked={selected.includes(object.address)}
                      disabled={busy || (selected.length >= 3 && !selected.includes(object.address))}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelected(checked
                          ? [...selected, object.address]
                          : selected.filter((address) => address !== object.address));
                      }} />
                    <code>{object.address}</code>
                    <span>{formatBytes(object.sizeBytes)}</span>
                  </label>
                ))}
              </div>
              <div className="table-controls dump-root-actions">
                <button className="btn btn-primary btn-sm" type="button" disabled={busy || !candidates.length}
                  onClick={() => void analysis.inspectRoots(candidates.map((object) => object.address), skipStacks)}>
                  Find GC roots{candidates.length ? ` (${candidates.length})` : ''}
                </button>
                <details className="dump-root-options">
                  <summary>Search options{skipStacks ? ' · stacks excluded' : ''}</summary>
                  <label className="dump-growth-filter">
                    <input type="checkbox" checked={skipStacks} disabled={busy}
                      onChange={(event) => analysis.updateInspection({ skipStacks: event.target.checked })} />
                    Skip stack roots
                  </label>
                  <p className="caveat">Search GC handles and finalizer roots.</p>
                </details>
              </div>
            </>
          )}
        </details>
        {roots && <RootEvidence analysis={analysis} roots={roots} change={change} baseline={baseline} />}
      </div>
    </section>
  );
}

function MethodTables({ tables, selected, disabled, onSelect }: {
  tables: DumpMethodTable[];
  selected: string | null;
  disabled: boolean;
  onSelect: (methodTable: string | null) => void;
}) {
  return (
    <label className="field dump-trace-picker">
      <span className="field-label">Method table to inspect</span>
      <select className="input input-sm" value={selected ?? ''} disabled={disabled}
        onChange={(event) => onSelect(event.target.value || null)}>
        <option value="">Choose a method table…</option>
        {tables.map((table) => {
          const countChange = table.baselineCount === null ? null : table.objectCount - table.baselineCount;
          const byteChange = table.baselineBytes === null ? null : table.totalBytes - table.baselineBytes;
          const signed = (value: number, formatted: string) => value > 0 ? `+${formatted}` : formatted;
          const delta = countChange !== null && byteChange !== null
            ? ` · ${signed(countChange, countChange.toLocaleString())} objects, ${signed(byteChange, formatBytes(byteChange))} vs baseline`
            : ' · no matching baseline address';
          return <option key={table.methodTable} value={table.methodTable}>
            {table.methodTable} · {table.objectCount.toLocaleString()} objects · {formatBytes(table.totalBytes)}{delta}
          </option>;
        })}
      </select>
      <span className="caveat">Table changes compare matching addresses in captures from the same process run.</span>
    </label>
  );
}

function TypeHistory({ reports, typeName }: { reports: DumpAnalysis[]; typeName: string }) {
  const totals = useMemo(() => reports.map((report) => report.types.reduce((total, type) => {
    if (type.typeName === typeName) {
      total.count += type.objectCount;
      total.bytes += type.totalBytes;
    }
    return total;
  }, { count: 0, bytes: 0 })), [reports, typeName]);
  return (
    <div className="dump-inspection-part">
      <h3>Type growth across captures</h3>
      <ul className="dump-history-values">
        {reports.map((report, index) => (
          <li key={report.id} title={report.path}>
            <span>{fileNameOf(report.path)}
              {reports.some((other) => other.id !== report.id && fileNameOf(other.path) === fileNameOf(report.path))
                ? ` · capture ${index + 1}` : ''}
            </span>
            <strong>{totals[index].count.toLocaleString()} objects · {formatBytes(totals[index].bytes)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AllocationEvidence({ traces, typeName, selectedTrace, linkTrace }: {
  traces: AllocationSiteData[];
  typeName: string;
  selectedTrace: string;
  linkTrace: (trace: string) => void;
}) {
  const trace = traces.find((item) => allocationTraceKey(item) === selectedTrace);
  const allocation = trace?.types.find((type) => type.typeName === typeName);
  return (
    <div className="dump-inspection-part">
      <h3>Where allocations came from</h3>
      {traces.length > 0 && (
        <label className="field dump-trace-picker">
          <span className="field-label">Allocation trace for this dump</span>
          <select className="input input-sm" value={trace ? selectedTrace : ''} onChange={(event) => linkTrace(event.target.value)}>
            <option value="">Choose the trace from the same process run…</option>
            {traces.map((item) => <option key={allocationTraceKey(item)} value={allocationTraceKey(item)}>
              {fileNameOf(item.captureFile)} · {new Date(item.windowStartUnixMs).toLocaleString()}
            </option>)}
          </select>
        </label>
      )}
      {allocation ? (
        <>
          <p className="caveat">Sampled allocation sites for this type in the selected trace.</p>
          <ul className="dump-allocation-sites">
            {allocation.sites.slice(0, 5).map((site) => (
              <li key={`${site.site}|${site.sourceFile}|${site.sourceLine}`}>
                <div className="dump-allocation-row">
                  <code>{site.site}</code>
                  <span className="dim">{formatBytes(site.sampledBytes)} sampled</span>
                </div>
                {site.sourceFile && site.sourceLine && (
                  <SourceCode key={`${site.sourceFile}|${site.sourceLine}`}
                    file={site.sourceFile} line={site.sourceLine} />
                )}
              </li>
            ))}
          </ul>
        </>
      ) : trace ? <p className="dim">The selected trace has no samples for this type.</p>
        : <p className="dim">{traces.length === 0
          ? 'Finish a deep capture or replay a recording with allocation sites to see where this type was created.'
          : 'Choose a trace captured from the same process run to see allocation call stacks.'}</p>}
    </div>
  );
}

function holderAddress(path: DumpRootPath): string | null {
  if (path.frames.length < 2) return null;
  const index = path.applicationFrameIndex ?? Math.max(0, path.frames.length - 2);
  return path.frames[index].address;
}

function RootEvidence({ roots, analysis, change, baseline }: {
  roots: NonNullable<NonNullable<Analysis['inspection']>['roots']>;
  analysis: Analysis;
  change: DumpTypeChange | null;
  baseline: DumpAnalysis | null;
}) {
  const selectedPath = analysis.inspection?.rootAddress;
  const path = roots.paths.find((entry) => entry.address === selectedPath) ?? roots.paths[0];
  const holder = path ? holderAddress(path) : null;
  const sharedHolderCount = holder ? roots.paths.filter((entry) => holderAddress(entry) === holder).length : 0;
  return (
    <div className="dump-root-evidence">
      <h3>GC root results</h3>
      <dl className="dump-root-summary">
        <div><dt>Rooted</dt><dd>{roots.paths.length}</dd></div>
        <div><dt>{roots.skipStacks ? 'No non-stack root' : 'No root found'}</dt><dd>{roots.unrooted.length}</dd></div>
        <div className={roots.failures.length ? 'has-failures' : undefined}><dt>Failed</dt><dd>{roots.failures.length}</dd></div>
      </dl>
      <div className="dump-allocation-row">
        <p className="caveat" role="status">
          Found a GC path for {roots.paths.length} of {roots.samplesChecked} selected objects.
          {roots.skipStacks && ' Stack roots were excluded.'}
        </p>
        {path && <label className="field">
          <span className="field-label">Root path for object</span>
          <select className="input input-sm" value={path.address}
            onChange={(event) => analysis.updateInspection({ rootAddress: event.target.value })}>
            {roots.paths.map((entry) => <option key={entry.address}>{entry.address}</option>)}
          </select>
        </label>}
      </div>
      {(roots.unrooted.length > 0 || roots.failures.length > 0) && (
        <ul className="dump-root-outcomes">
          {roots.unrooted.map((address) => <li className="dim" key={address}>
            <code>{address}</code> · {roots.skipStacks ? 'No non-stack root found' : 'No GC root found'}
          </li>)}
          {roots.failures.map(({ address, message }) => <li key={address}>
            <details>
              <summary><code>{address}</code> · GC root search failed</summary>
              <p className="dump-error">{message}</p>
            </details>
          </li>)}
        </ul>
      )}
      {path && <>
        <RootPath key={path.address} analysis={analysis} path={path} change={change} baseline={baseline}
          sharedHolderCount={sharedHolderCount} samplesChecked={roots.samplesChecked} />
      </>}
    </div>
  );
}

function RootPath({ path, analysis, change, baseline, sharedHolderCount, samplesChecked }: {
  path: DumpRootPath;
  analysis: Analysis;
  change: DumpTypeChange | null;
  baseline: DumpAnalysis | null;
  sharedHolderCount: number;
  samplesChecked: number;
}) {
  const initialIndex = path.applicationFrameIndex ?? Math.max(0, path.frames.length - 2);
  const rootView = analysis.inspection?.rootViews[path.address];
  const selectedIndex = rootView?.frameIndex ?? initialIndex;
  const reference = rootView ? rootView.reference : path.reference;
  const expandedGroups = rootView?.expandedGroups ?? [];
  const items = useMemo(() => groupDumpChain(path.frames, path.applicationFrameIndex), [path]);
  const selected = path.frames[selectedIndex];
  const stackMethod = path.stackMethod?.split('(')[0];
  const typePrefix = selected && `${selected.typeName}.`;
  const methodName = typePrefix && stackMethod?.startsWith(typePrefix)
    ? stackMethod.slice(typePrefix.length)
    : null;

  async function inspect(index: number) {
    analysis.updateRootView(path.address, { frameIndex: index, reference: null, source: null });
    const frame = path.frames[index];
    const child = path.frames[index + 1]?.address ?? null;
    const inspected = await analysis.inspectReference(frame.address, child);
    if (inspected) analysis.updateRootView(path.address, { reference: inspected });
  }

  function frameButton(index: number) {
    const frame = path.frames[index];
    return (
      <li key={frame.address}>
        <button type="button" className="btn btn-sm btn-ghost" title={frame.typeName}
          aria-pressed={index === selectedIndex} disabled={analysis.phase !== 'idle'}
          onClick={() => void inspect(index)}>
          {(index === 0 || index === path.frames.length - 1) && <span className="field-label">
            {index === 0 && 'GC root'}{index === 0 && index === path.frames.length - 1 && ' · '}
            {index === path.frames.length - 1 && 'Selected instance'}
          </span>}
          <code>{friendlyFrame(frame.typeName)}</code>
          <code className="dim">{frame.address}</code>
          {frame.staticField && <span className="dim">{frame.staticField}</span>}
        </button>
      </li>
    );
  }

  return (
    <>
      <section className="dump-finding" aria-label="Retention evidence">
        <div className="dump-allocation-row">
          <h3>Retention evidence</h3>
          {path.rootKind && <span className="dim">{path.rootKind}</span>}
        </div>
        <p className="dump-finding-type"><code>{analysis.inspection?.typeName}</code></p>
        <dl className="dump-finding-metrics">
          <div>
            <dt>{baseline ? 'Type growth' : 'Type memory'}</dt>
            <dd className={baseline && change && change.deltaBytes > 0 ? 'dump-growth' : undefined}>
              {baseline && change
                ? `${change.deltaBytes > 0 ? '+' : ''}${formatBytes(change.deltaBytes)}`
                : formatBytes(change?.totalBytes ?? 0)}
            </dd>
            {baseline && <dd className="dump-finding-caption dim" title={baseline.path}>vs {fileNameOf(baseline.path)}</dd>}
          </div>
          <div>
            <dt>Paths sharing a holder</dt>
            <dd>{sharedHolderCount ? `${sharedHolderCount} / ${samplesChecked}` : '—'}</dd>
            <dd className="dump-finding-caption dim">selected objects searched</dd>
          </div>
        </dl>
        {selected && (
          <div className="dump-owner">
            <span className="field-label">
              {selectedIndex === path.applicationFrameIndex ? 'Likely application holder' : 'Selected object'}
            </span>
            <strong title={selected.typeName}>{friendlyFrame(selected.typeName)}</strong>
            {selected.staticField && <span>Static field <code>{selected.staticField}</code></span>}
            {!!reference?.fields.length && (
              <span>Reference field <code title={reference.fields.join(', ')}>
                {reference.fields.map(friendlyField).join(', ')}
              </code></span>
            )}
            {reference && path.frames[selectedIndex + 1] && !reference.fields.length && (
              <span className="dim">SOS did not identify a named field for this link.</span>
            )}
            {selectedIndex !== initialIndex && <button type="button" className="btn btn-sm btn-ghost"
              disabled={analysis.phase !== 'idle'} onClick={() => void inspect(initialIndex)}>
              {path.applicationFrameIndex === null ? 'Show sampled holder' : 'Show application holder'}
            </button>}
            {path.stackMethod && <span className="dump-root-origin">Stack method <code>{path.stackMethod}</code></span>}
            {reference && <ReferenceSource key={selected.address} analysis={analysis} reference={reference} methodName={methodName}
              source={rootView?.source ?? null} onSource={(source) => analysis.updateRootView(path.address, { source })} />}
            {!reference && (
              <button type="button" className="btn btn-sm btn-ghost" disabled={analysis.phase !== 'idle'}
                onClick={() => void inspect(selectedIndex)}>Inspect fields and symbols</button>
            )}
          </div>
        )}
      </section>
      {path.frames.length > 0 && (
        <div className="dump-chain">
          <h3>Reference chain</h3>
          <p className="caveat">Select an object to inspect its fields and source.</p>
          <ol className="dump-reference-chain" aria-label="References from GC root to selected instance">
            {items.map((item) => {
              if (item.kind === 'frame') return frameButton(item.index);
              const expanded = expandedGroups.includes(item.start);
              const containsSelected = selectedIndex >= item.start && selectedIndex < item.end;
              const groupId = `dump-framework-${item.start}`;
              return <li className="dump-framework-group" key={item.start}>
                <button type="button" className="btn btn-sm btn-ghost" aria-expanded={expanded} aria-controls={groupId}
                  onClick={() => analysis.updateRootView(path.address, {
                    expandedGroups: expanded ? expandedGroups.filter((start) => start !== item.start) : [...expandedGroups, item.start],
                  })}>
                  <span>{expanded ? 'Hide' : 'Show'} {item.end - item.start} framework objects</span>
                  {containsSelected && <span className="dim">Includes the selected object</span>}
                </button>
                <ol className="dump-reference-chain" id={groupId} hidden={!expanded}>
                  {Array.from({ length: item.end - item.start }, (_, offset) => frameButton(item.start + offset))}
                </ol>
              </li>;
            })}
          </ol>
        </div>
      )}
      <details open={path.frames.length === 0}>
        <summary>SOS output</summary>
        <pre tabIndex={0}>{path.trace}</pre>
        {path.traceTruncated && <p className="caveat">SOS output was shortened.</p>}
      </details>
    </>
  );
}

function friendlyFrame(name: string): string {
  const local = name.match(/^(.*?)\+<.*>g__([^|]+)\|[^>]+>d$/);
  if (local) return `${local[1]}.${local[2]}`;
  const asyncMethod = name.match(/^(.*?)\+<([^<>]+)>d__\d+$/);
  return asyncMethod ? `${asyncMethod[1]}.${asyncMethod[2]}` : name;
}

function friendlyField(field: string): string {
  return field.match(/^<([^<>]+)>5__\d+$/)?.[1] ?? field;
}

function ReferenceSource({ analysis, reference, methodName, source, onSource }: {
  analysis: Analysis;
  reference: DumpReference;
  methodName: string | null;
  source: DumpSourceLocation | null;
  onSource: (source: DumpSourceLocation) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = busy || analysis.phase !== 'idle';

  async function locate(chooseAssembly: boolean) {
    setError(null);
    setBusy(true);
    try {
      const assembly = chooseAssembly ? await dumpApi.pick('assembly') : reference.assemblyPath;
      if (!assembly) return;
      const match = await analysis.resolveSource(assembly, reference, methodName);
      if (match) onSource(match);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dump-symbols">
      {source ? (
        <>
          <span className="dim">{source.isMethodLocation ? 'Method' : 'Type source anchor'} <code>{source.methodName}</code></span>
          <SourceCode key={`${source.sourceFile}|${source.sourceLine}`} file={source.sourceFile}
            line={source.sourceLine} sha256={source.sha256} openByDefault />
        </>
      ) : (
        <div className="table-controls">
          {reference.assemblyPath && <button type="button" className="btn btn-sm" disabled={disabled}
            onClick={() => void locate(false)}>Find source in PDB</button>}
          <button type="button" className="btn btn-sm btn-ghost" disabled={disabled}
            onClick={() => void locate(true)}>Choose assembly from dump build…</button>
        </div>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}

function SourceCode({ file, line, sha256, openByDefault = false }: {
  file: string;
  line: number;
  sha256?: string | null;
  openByDefault?: boolean;
}) {
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!openByDefault) return;
    let current = true;
    void dumpApi.previewSource(file, line, sha256).then(
      (value) => { if (current) setPreview(value); },
      (error: Error) => { if (current) setError(error.message); },
    );
    return () => { current = false; };
  }, [file, line, sha256, openByDefault]);

  async function open(chooseFile: boolean) {
    setBusy(true);
    try {
      const path = chooseFile ? await dumpApi.pick('source') : file;
      if (!path) return;
      setError(null);
      setPreview(await dumpApi.previewSource(path, line, sha256));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => preview?.lines.map((text, index) => ({
    number: preview.firstLine + index,
    text,
  })) ?? [], [preview]);

  return (
    <div className="dump-source-code">
      <div className="table-controls">
        <code title={file}>{fileNameOf(file)}:{line}</code>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
          onClick={() => preview ? setPreview(null) : void open(false)}>
          {preview ? 'Hide code' : 'View code'}
        </button>
        {error && <button type="button" className="btn btn-sm" disabled={busy}
          onClick={() => void open(true)}>Choose local source…</button>}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {preview && (
        <pre tabIndex={0} aria-label={`Source near line ${line}`}>
          {rows.map(({ number, text }) => (
            <span key={number} className={number === line ? 'dump-source-line dump-source-highlight' : 'dump-source-line'}>
              <span className="dim">{number.toString().padStart(5)}  </span>{text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
