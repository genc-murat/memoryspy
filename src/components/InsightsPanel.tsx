import { useMemo } from 'react';

import { diagnose, type Finding, type Severity } from '../lib/analysis';
import { formatBytes, formatBytesPerSecond, formatPercent, formatSignedRate } from '../lib/format';
import { palette, severityColor } from '../lib/palette';
import type { MetricsStore } from '../lib/store';

interface Props {
  store: MetricsStore;
  onOpenTarget: (target?: string) => void;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Act now',
  warning: 'Worth a look',
  info: 'Context',
  good: 'Clear',
};

function FindingCard({ finding, onOpenTarget }: { finding: Finding; onOpenTarget: (target?: string) => void }) {
  return (
    <article className="finding" style={{ borderLeftColor: severityColor(finding.severity) }}>
      <header className="finding-head">
        <span className={`chip chip-${finding.severity}`}>{SEVERITY_LABEL[finding.severity]}</span>
        <h3>{finding.title}</h3>
      </header>

      <p className="finding-summary">{finding.summary}</p>

      {finding.evidence.length > 0 && (
        <div className="finding-block">
          <span className="eyebrow">What the numbers show</span>
          <ul className="finding-evidence">
            {finding.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {finding.actions.length > 0 && (
        <div className="finding-block">
          <span className="eyebrow">Next steps</span>
          <ol className="finding-actions">
            {finding.actions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
      )}

      {finding.target && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenTarget(finding.target)}>
          Open the relevant view
        </button>
      )}
    </article>
  );
}

/**
 * The diagnosis view: what is wrong, why the tool says so, and what to do next.
 *
 * Every finding carries its own evidence. That is a deliberate choice — an analysis tool
 * that only says "there is a leak" trains people to ignore it, while one that shows the fit
 * quality, the numbers behind it and the counter it came from can be argued with.
 */
export function InsightsPanel({ store, onOpenTarget }: Props) {
  // `store` is stable, so the findings would otherwise be computed once and never revisited as
  // the session grows; `store.version` is the value that actually changes.
  const diagnosis = useMemo(() => diagnose(store), [store, store.version]);

  const criticalCount = diagnosis.findings.filter((finding) => finding.severity === 'critical').length;

  return (
    <div className="panel">
      <section className="metrics-strip">
        <div className="metric-tile">
          <span className="eyebrow">GC heap trend</span>
          <span className="metric-value" style={{ color: diagnosis.overall === 'good' ? undefined : severityColor(diagnosis.overall) }}>
            {diagnosis.gcHeap ? formatSignedRate(diagnosis.gcHeap.ratePerMinute / 60) : '—'}
          </span>
          <span className="metric-sub">
            {diagnosis.gcHeap ? `fit quality r² ${diagnosis.gcHeap.r2.toFixed(2)}` : 'collecting…'}
          </span>
        </div>
        <div className="metric-tile">
          <span className="eyebrow">Working set trend</span>
          <span className="metric-value">
            {diagnosis.workingSet ? formatSignedRate(diagnosis.workingSet.ratePerMinute / 60) : '—'}
          </span>
          <span className="metric-sub">
            {diagnosis.workingSet
              ? `${formatBytes(diagnosis.workingSet.first)} → ${formatBytes(diagnosis.workingSet.last)}`
              : 'collecting…'}
          </span>
        </div>
        <div className="metric-tile">
          <span className="eyebrow">Findings</span>
          <span className="metric-value">
            {diagnosis.findings.length}
            {criticalCount > 0 && <span className="metric-badge" style={{ color: palette.critical }}> {criticalCount} critical</span>}
          </span>
          <span className="metric-sub">{store.samples.toLocaleString()} samples analysed</span>
        </div>
        <div className="metric-tile">
          <span className="eyebrow">Allocation share leader</span>
          <span className="metric-value metric-value-sm">{diagnosis.suspects[0]?.record.typeName ?? '—'}</span>
          <span className="metric-sub">
            {diagnosis.suspects[0]
              ? `${formatPercent(diagnosis.suspects[0].share * 100)} · ${formatBytesPerSecond(diagnosis.suspects[0].record.currentRate)}`
              : 'no allocation samples yet'}
          </span>
        </div>
      </section>

      {store.samples < 20 && (
        <div className="notice notice-info">
          Analysis needs a bit of history. The trend rules want at least 20 samples before they will commit to a
          conclusion, so let the session run for {Math.max(5, 20 - store.samples)} more intervals.
        </div>
      )}

      <div className="findings">
        {diagnosis.findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} onOpenTarget={onOpenTarget} />
        ))}
      </div>

      <section className="chart-block">
        <header className="block-head">
          <h2>How the ranking works</h2>
          <p>
            Suspects are ranked by share of sampled allocation, whether the rate is still rising, and average object
            size — a rising rate on large objects outranks a bigger but flat allocation share, because that is the
            combination that actually leaks.
          </p>
        </header>

        <ul className="suspect-list">
          {diagnosis.suspects.map((suspect, index) => (
            <li key={suspect.record.typeName}>
              <span className="suspect-rank">{index + 1}</span>
              <span className="suspect-type" title={suspect.record.typeName}>
                {suspect.record.typeName}
              </span>
              <span className="suspect-bar">
                <span
                  className="suspect-fill"
                  style={{
                    width: `${Math.max(2, (suspect.score / Math.max(1, diagnosis.suspects[0]?.score ?? 1)) * 100)}%`,
                    background: suspect.accelerating ? palette.warning : palette.gen1,
                  }}
                />
              </span>
              <span className="suspect-share">{formatPercent(suspect.share * 100, 1)}</span>
              <span className="suspect-reason">{suspect.reason}</span>
            </li>
          ))}
          {diagnosis.suspects.length === 0 && <li className="empty-note">No allocation data yet.</li>}
        </ul>
      </section>
    </div>
  );
}
