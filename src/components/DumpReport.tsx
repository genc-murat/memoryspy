import { useEffect, useMemo, useState } from 'react';

import { buildDumpReport, dumpReportFileName } from '../lib/dumpReport';
import type { DumpReportInput } from '../lib/dumpReport';
import { dumpApi } from '../lib/ipc';
import type { useDumpAnalysis } from '../lib/useDumpAnalysis';

export function DumpReport({ analysis, ...input }: DumpReportInput & { analysis: ReturnType<typeof useDumpAnalysis> }) {
  const { report, inspection } = input;
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markdown = useMemo(() => buildDumpReport(input),
    [report, input.reports, input.baseline, inspection, input.trace]);
  const disabled = saving || analysis.phase !== 'idle';
  useEffect(() => { setStatus(null); setError(null); }, [markdown]);

  async function copy() {
    setStatus(null);
    setError(null);
    try {
      await navigator.clipboard.writeText(markdown);
      setStatus('Markdown copied.');
    } catch {
      setError('Could not copy. Select the report preview to copy it, or save a Markdown file.');
    }
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const path = await dumpApi.saveReport(dumpReportFileName(report.path, inspection.typeName), markdown);
      if (path) setStatus(`Saved to ${path}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dump-inspection-part dump-report-export">
      <div>
        <h3>Investigation report</h3>
        <p className="caveat">Share the growth history and evidence already collected for this type.</p>
      </div>
      <label className="field">
        <span className="field-label">Investigator notes</span>
        <textarea className="input" rows={3} value={inspection.reportNotes} disabled={disabled}
          placeholder="Expected object lifetime, suspected cause, and what to check in code…"
          onChange={(event) => analysis.updateInspection({ reportNotes: event.target.value })} />
      </label>
      <div className="dump-report-options">
        <label className="dump-growth-filter">
          <input type="checkbox" checked={inspection.reportFullPaths} disabled={disabled}
            onChange={(event) => analysis.updateInspection({ reportFullPaths: event.target.checked })} />
          Show full dump, source and trace file paths
        </label>
        <label className="dump-growth-filter">
          <input type="checkbox" checked={inspection.reportSos} disabled={disabled}
            onChange={(event) => analysis.updateInspection({ reportSos: event.target.checked })} />
          Include raw SOS output (may contain file paths)
        </label>
      </div>
      <div className="table-controls">
        <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={() => void copy()}>Copy Markdown</button>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save Markdown…'}
        </button>
      </div>
      {status && <p className="dim" role="status">{status}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <label className="field">
        <span className="field-label">Report preview · Markdown</span>
        <textarea className="input dump-report-preview" readOnly value={markdown} rows={18} spellCheck={false} />
      </label>
    </div>
  );
}
