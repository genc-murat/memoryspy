import { dumpReportKey } from './dumpComparison.ts';
import { fileNameOf, formatBytes } from './format.ts';
import type { AllocationSiteData, DumpAnalysis } from './types';
import type { useDumpAnalysis } from './useDumpAnalysis';

export type ReportInspection = NonNullable<ReturnType<typeof useDumpAnalysis>['inspection']>;

export interface DumpReportInput {
  report: DumpAnalysis;
  reports: DumpAnalysis[];
  baseline: DumpAnalysis | null;
  inspection: ReportInspection;
  trace: AllocationSiteData | null;
}

function fence(value: string, minimum: number): string {
  const length = (value.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length + 1), minimum);
  return '`'.repeat(length);
}

function code(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ');
  const ticks = fence(text, 1);
  return `${ticks} ${text} ${ticks}`;
}

function block(value: string): string {
  const ticks = fence(value, 3);
  return `${ticks}text\n${value}\n${ticks}`;
}

function cell(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]|])/g, '\\$1');
}

const count = (value: number) => value.toLocaleString('en-US');
const bytes = (value: number) => `${formatBytes(value)} (${count(value)} bytes)`;
const signed = (value: number, format: (value: number) => string) => `${value > 0 ? '+' : ''}${format(value)}`;

export function dumpReportFileName(path: string, typeName: string): string {
  const name = `${fileNameOf(path)}-${typeName}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 150);
  return `${name || 'dump'}-investigation.md`;
}

/** Builds a report from evidence already loaded in the UI; exporting never scans the dump. */
export function buildDumpReport({ report, reports, baseline, inspection, trace }: DumpReportInput): string {
  const { typeName, roots, reportNotes, reportFullPaths, reportSos } = inspection;
  const file = (path: string) => code(reportFullPaths ? path : fileNameOf(path));
  const totals = (capture: DumpAnalysis) => capture.types.reduce((total, type) => type.typeName === typeName
    ? { objects: total.objects + type.objectCount, bytes: total.bytes + type.totalBytes } : total,
  { objects: 0, bytes: 0 });
  const current = totals(report);
  const scoped = reports.filter((capture) => capture.reachableOnly === report.reachableOnly);
  const currentIndex = scoped.findIndex((capture) => dumpReportKey(capture) === dumpReportKey(report));
  const history = currentIndex < 0 ? [report] : scoped.slice(0, currentIndex + 1);
  const baselineIndex = baseline ? history.findIndex((capture) => dumpReportKey(capture) === dumpReportKey(baseline)) : -1;
  const comparison = baselineIndex >= 0 && baselineIndex < history.length - 1 ? history[baselineIndex] : null;
  const captures = comparison ? history.slice(baselineIndex) : history;
  const lines = [
    '# MemorySpy investigation', '',
    `- Type: ${code(typeName)}`,
    `- Dump: ${file(report.path)}`,
    `- Dump fingerprint: ${code(report.id)}`,
    `- Heap scope: ${report.reachableOnly ? 'Reachable objects only' : 'All managed objects (includes objects awaiting collection)'}`,
    `- Type objects: ${count(current.objects)}`,
    `- Type shallow size: ${bytes(current.bytes)}`,
    `- Selected method table: ${inspection.methodTable ? code(inspection.methodTable) : 'None'}`,
    '', '## Growth across captures', '',
  ];
  if (comparison) {
    const before = totals(comparison);
    const intervals = captures.length - 1;
    const growing = captures.slice(1).filter((capture, index) => totals(capture).bytes > totals(captures[index]).bytes).length;
    lines.push(`Baseline: ${file(comparison.path)}.`, '',
      `- Object change: ${signed(current.objects - before.objects, count)}`,
      `- Shallow size change: ${signed(current.bytes - before.bytes, bytes)}`,
      `- Shallow size grew in ${growing} of ${intervals} intervals.`, '');
  } else {
    lines.push('No earlier baseline selected. Growth has not been established.', '');
  }
  lines.push('Captures are listed in the chosen comparison order. Compare dumps from the same process run and heap scope.', '',
    '| Capture | Dump | Fingerprint | Objects of this type | Shallow bytes |', '| --- | --- | --- | ---: | ---: |');
  captures.forEach((capture, index) => {
    const total = totals(capture);
    lines.push(`| ${index + 1} | ${cell(reportFullPaths ? capture.path : fileNameOf(capture.path))} | ${cell(capture.id)} | ${count(total.objects)} | ${count(total.bytes)} |`);
  });

  lines.push('', '## GC root evidence', '');
  if (!roots) {
    lines.push('GC roots have not been searched for this type.');
  } else {
    lines.push(`Searched ${roots.samplesChecked} sample objects: ${roots.paths.length} rooted, ${roots.unrooted.length} with no ${roots.skipStacks ? 'non-stack ' : ''}root found, ${roots.failures.length} failed.`,
      `Stack roots: ${roots.skipStacks ? 'excluded' : 'included'}.`, '');
    for (const [index, path] of roots.paths.entries()) {
      lines.push(`### Root path ${index + 1}`, '', `- Sample object: ${code(path.address)}`,
        `- Root kind: ${path.rootKind ? code(path.rootKind) : 'Not identified'}`);
      if (path.stackMethod) lines.push(`- Stack method: ${code(path.stackMethod)}`);
      const holder = path.applicationFrameIndex === null ? null : path.frames[path.applicationFrameIndex];
      if (holder) lines.push(`- Likely application holder: ${code(holder.typeName)} at ${code(holder.address)} (candidate from this path)`);
      lines.push('', 'Reference chain, from GC root to sampled instance:', '');
      path.frames.forEach((frame, frameIndex) => {
        lines.push(`${frameIndex + 1}. ${code(frame.typeName)} at ${code(frame.address)}${frame.staticField ? ` · static field ${code(frame.staticField)}` : ''}`);
      });
      if (!path.frames.length) lines.push('No structured reference chain was parsed.');

      const saved = inspection.rootViews[path.address];
      const frameIndex = saved?.frameIndex ?? path.applicationFrameIndex ?? Math.max(0, path.frames.length - 2);
      const frame = path.frames[frameIndex];
      const reference = saved ? saved.reference : path.reference;
      if (frame && reference) {
        lines.push('', `Inspected chain object: ${code(frame.typeName)} at ${code(frame.address)}.`);
        if (reference.assemblyPath) lines.push(`Assembly: ${file(reference.assemblyPath)}.`);
        if (path.frames[frameIndex + 1]) {
          lines.push(reference.fields.length
            ? `Named reference fields to the next object: ${reference.fields.map(code).join(', ')}.`
            : 'SOS did not identify a named field for this link.');
        }
      }
      if (saved?.source) {
        const source = saved.source;
        lines.push('', `${source.isMethodLocation ? 'Method source anchor' : 'Type source anchor'}: ${file(source.sourceFile)}, line ${source.sourceLine}, ${code(source.methodName)}.`);
        if (source.sha256) lines.push(`Source SHA-256: ${code(source.sha256)}.`);
      }
      if (reportSos) lines.push('', 'Raw SOS output:', '', block(path.trace));
      if (path.traceTruncated) lines.push('', 'SOS output was shortened during analysis.');
      lines.push('');
    }
    for (const address of roots.unrooted) lines.push(`- ${code(address)}: no ${roots.skipStacks ? 'non-stack ' : ''}GC root found; this does not establish that the object is unreachable.`);
    for (const failure of roots.failures) lines.push('', `GC root search failed for ${code(failure.address)}:`, '', block(failure.message));
  }

  lines.push('', '## Allocation evidence', '');
  const allocation = trace?.types.find((type) => type.typeName === typeName);
  if (trace) {
    lines.push(`Linked trace (selected by investigator): ${file(trace.captureFile)}.`,
      'Allocation sites describe sampled creation activity in this trace, not which objects survived in this dump.', '');
    if (allocation) {
      const sites = allocation.sites.slice(0, 5);
      lines.push(`Top ${sites.length} of ${allocation.sites.length} recorded sites for this type:`, '');
      for (const site of sites) {
        lines.push(`- ${code(site.site)} · ${bytes(site.sampledBytes)} sampled${site.sourceFile ? ` · ${file(site.sourceFile)}${site.sourceLine ? `:${site.sourceLine}` : ''}` : ''}`);
      }
    } else lines.push('The linked trace has no allocation samples for this type.');
  } else lines.push('No allocation trace linked.');

  if (report.notices.length) lines.push('', '## Analysis diagnostics', '', block(report.notices.join('\n')));
  if (reportNotes.trim()) lines.push('', '## Investigator notes', '', block(reportNotes.trim()));
  lines.push('', '## Interpretation and next checks', '',
    '- A GC root path proves reachability at capture time. It does not by itself prove a leak.',
    '- Type bytes measure shallow object size, not the memory released by removing a reference.',
    '- PDB source anchors locate a type or method. They do not identify a faulty statement.');
  if (!comparison) lines.push('- Select an earlier dump from the same process run to establish growth.');
  if (!roots) lines.push('- Find sample objects and search GC roots to identify what keeps them alive.');
  else if (roots.paths.length) lines.push('- Check whether the holder should outlive these objects, and verify its removal or cleanup path in code.');
  if (roots?.skipStacks) lines.push('- Repeat the root search with stack roots included if needed.');
  if (roots?.failures.length) lines.push('- Resolve the root search failures before drawing conclusions about those samples.');
  return `${lines.join('\n')}\n`;
}
