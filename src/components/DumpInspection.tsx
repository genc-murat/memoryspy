import { useEffect, useMemo, useRef, useState } from 'react';

import { fileNameOf, formatBytes } from '../lib/format';
import { dumpApi } from '../lib/ipc';
import type { AllocationSiteData, DumpAnalysis, DumpMethodTable, DumpReference, DumpRootPath, DumpSourceLocation, SourcePreview } from '../lib/types';
import type { useDumpAnalysis } from '../lib/useDumpAnalysis';

type Analysis = ReturnType<typeof useDumpAnalysis>;

export function DumpInspection({ analysis, traces, reports }: {
  analysis: Analysis;
  traces: AllocationSiteData[];
  reports: DumpAnalysis[];
}) {
  const { inspection } = analysis;
  if (!inspection) return null;
  return (
    <Inspection
      key={`${inspection.typeName}|${inspection.methodTables.map((table) => table.methodTable).join(',')}`}
      analysis={analysis}
      inspection={inspection}
      traces={traces}
      reports={reports}
    />
  );
}

function Inspection({ analysis, inspection, traces, reports }: {
  analysis: Analysis;
  inspection: NonNullable<Analysis['inspection']>;
  traces: AllocationSiteData[];
  reports: DumpAnalysis[];
}) {
  const details = useRef<HTMLElement>(null);
  const [minKiB, setMinKiB] = useState('0');
  const [selected, setSelected] = useState<string[]>([]);
  const [skipStacks, setSkipStacks] = useState(false);
  const busy = analysis.phase !== 'idle';
  const minBytes = Number(minKiB) * 1024;
  const validMinimum = minKiB.trim() !== '' && Number.isInteger(Number(minKiB)) &&
    Number.isSafeInteger(minBytes) && minBytes >= 0;
  useEffect(() => details.current?.focus(), []);

  const sampled = inspection.objects;
  const roots = inspection.roots;
  const candidates = sampled?.filter((object) => selected.includes(object.address)) ?? [];

  return (
    <section className="dump-roots dump-inspection" ref={details} tabIndex={-1} aria-labelledby="dump-inspection-title">
      <div className="block-head">
        <div>
          <span className="field-label">Inspect type</span>
          <h2 id="dump-inspection-title"><code>{inspection.typeName}</code></h2>
        </div>
      </div>
      {reports.length > 1 && <TypeHistory reports={reports} typeName={inspection.typeName} />}
      <AllocationEvidence traces={traces} typeName={inspection.typeName}
        selectedTrace={analysis.allocationTrace} linkTrace={analysis.linkAllocationTrace} />
      <div className="dump-inspection-part">
        <h3>What keeps it alive</h3>
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
          setSelected([]);
          void analysis.findObjects(minBytes);
        }}>
          <label className="field">
            <span className="field-label">Minimum object size (KiB)</span>
            <input className="input input-sm" type="number" min={0} step={1} value={minKiB}
              disabled={busy} onChange={(event) => setMinKiB(event.target.value)} />
          </label>
          <button type="submit" className="btn btn-sm" disabled={busy || !validMinimum || !inspection.methodTable}>Find objects</button>
        </form>
        {sampled?.length === 0 && <p className="dim">No objects meet the size filter.</p>}
        {sampled && sampled.length > 0 && (
          <>
            <p className="caveat">Select up to three of the {sampled.length} listed objects.</p>
            <div className="dump-object-list">
              {sampled.map((object) => (
                <label key={object.address}>
                  <input type="checkbox" checked={selected.includes(object.address)}
                    disabled={busy || (selected.length >= 3 && !selected.includes(object.address))}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelected((current) => checked
                        ? [...current, object.address]
                        : current.filter((address) => address !== object.address));
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
              <label className="dump-growth-filter">
                <input type="checkbox" checked={skipStacks} disabled={busy} onChange={(event) => setSkipStacks(event.target.checked)} />
                Skip stack roots
              </label>
            </div>
          </>
        )}
        {roots && <RootEvidence analysis={analysis} roots={roots} />}
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

function traceKey(trace: AllocationSiteData): string {
  return JSON.stringify([trace.captureFile, trace.windowStartUnixMs, trace.windowEndUnixMs]);
}

function AllocationEvidence({ traces, typeName, selectedTrace, linkTrace }: {
  traces: AllocationSiteData[];
  typeName: string;
  selectedTrace: string;
  linkTrace: (trace: string) => void;
}) {
  const trace = traces.find((item) => traceKey(item) === selectedTrace);
  const allocation = trace?.types.find((type) => type.typeName === typeName);
  return (
    <div className="dump-inspection-part">
      <h3>Where allocations came from</h3>
      {traces.length > 0 && (
        <label className="field dump-trace-picker">
          <span className="field-label">Allocation trace for this dump</span>
          <select className="input input-sm" value={trace ? selectedTrace : ''} onChange={(event) => linkTrace(event.target.value)}>
            <option value="">Choose the trace from the same process run…</option>
            {traces.map((item) => <option key={traceKey(item)} value={traceKey(item)}>
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
        : traces.length === 0 && <p className="dim">Finish a deep capture or replay a recording with allocation sites.</p>}
    </div>
  );
}

function holderAddress(path: DumpRootPath): string | null {
  if (path.frames.length < 2) return null;
  const index = path.applicationFrameIndex ?? Math.max(0, path.frames.length - 2);
  return path.frames[index].address;
}

function RootEvidence({ roots, analysis }: { roots: NonNullable<NonNullable<Analysis['inspection']>['roots']>; analysis: Analysis }) {
  const [selectedPath, setSelectedPath] = useState('');
  const path = roots.paths.find((entry) => entry.address === selectedPath) ?? roots.paths[0];
  const holder = path ? holderAddress(path) : null;
  const sharedHolderCount = holder ? roots.paths.filter((entry) => holderAddress(entry) === holder).length : 0;
  return (
    <div className="dump-root-evidence">
      <div className="dump-allocation-row">
        <p className="caveat" role="status">
          Found a GC path for {roots.paths.length} of {roots.samplesChecked} selected objects.
          {roots.skipStacks && ' Stack roots were excluded.'}
        </p>
        {path && <label className="field">
          <span className="field-label">Root path for object</span>
          <select className="input input-sm" value={path.address} onChange={(event) => setSelectedPath(event.target.value)}>
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
      {sharedHolderCount > 1 && <p className="dump-growth">Holder <code>{holder}</code> appears in {sharedHolderCount} paths.</p>}
      {path && <>
        {path.rootKind && <p>Root · <strong>{path.rootKind}</strong>{path.stackMethod && <> · <code>{path.stackMethod}</code></>}</p>}
        <RootPath key={path.address} analysis={analysis} path={path} />
      </>}
    </div>
  );
}

function RootPath({ path, analysis }: { path: DumpRootPath; analysis: Analysis }) {
  const initialIndex = path.applicationFrameIndex ?? Math.max(0, path.frames.length - 2);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [reference, setReference] = useState(path.reference);
  const selected = path.frames[selectedIndex];
  const stackMethod = path.stackMethod?.split('(')[0];
  const typePrefix = selected && `${selected.typeName}.`;
  const methodName = typePrefix && stackMethod?.startsWith(typePrefix)
    ? stackMethod.slice(typePrefix.length)
    : null;

  async function inspect(index: number) {
    setSelectedIndex(index);
    setReference(null);
    const frame = path.frames[index];
    const child = path.frames[index + 1]?.address ?? null;
    setReference(await analysis.inspectReference(frame.address, child));
  }

  return (
    <>
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
          {reference && <ReferenceSource key={selected.address} analysis={analysis} reference={reference} methodName={methodName} />}
          {!reference && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={analysis.phase !== 'idle'}
              onClick={() => void inspect(selectedIndex)}>Inspect fields and symbols</button>
          )}
        </div>
      )}
      {path.frames.length > 0 && (
        <ol className="dump-reference-chain" aria-label="References from GC root to selected instance">
          {path.frames.map((frame, index) => (
            <li key={`${frame.address}|${index}`}>
              <button type="button" className="btn btn-sm btn-ghost" title={frame.typeName}
                aria-pressed={index === selectedIndex} disabled={analysis.phase !== 'idle'}
                onClick={() => void inspect(index)}>
                <code>{friendlyFrame(frame.typeName)}</code>
                <code className="dim">{frame.address}</code>
                {frame.staticField && <span className="dim">{frame.staticField}</span>}
              </button>
            </li>
          ))}
        </ol>
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

function ReferenceSource({ analysis, reference, methodName }: {
  analysis: Analysis;
  reference: DumpReference;
  methodName: string | null;
}) {
  const [source, setSource] = useState<DumpSourceLocation | null>(null);
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
      if (match) setSource(match);
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
