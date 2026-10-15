import type { ComponentType } from 'react';

import type { Capabilities } from '../lib/types';

/**
 * The frontend half of the extension point.
 *
 * A view declares which collector probes it needs and which protocol message types it
 * consumes. The shell then shows, disables or explains each view based on what the connected
 * collector actually reported in its `capabilities` handshake.
 *
 * The consequence is that adding a diagnostic capability is a two-file change — one probe
 * class in the collector, one entry here — and that pointing the app at an older collector
 * degrades into "this view needs the allocations probe" instead of a blank screen.
 */
export interface PanelContext {
  store: import('../lib/store').MetricsStore;
  sessionId: string | null;
  settings: import('../lib/types').Settings;
  collector: import('../lib/types').CollectorLocation;
  capabilities: Capabilities | null;
  recordingsDir: string;
  /** The recording being replayed, if any. */
  activeRecordingPath: string | null;
  /** The file a live session is writing, if any. */
  recordingPath: string | null;
  /** Bumped when a recording finishes, so the library re-reads the folder. */
  recordingsToken: number;
  onReplayRecording: (path: string) => void;
  onOpenTarget: (target?: string) => void;
  onResetCounters: () => void;
  onSaveSettings: (settings: import('../lib/types').Settings) => Promise<void>;
  onRefreshCollector: () => Promise<void>;
}

export interface PanelDefinition {
  id: string;
  label: string;
  /** Short description shown in the view header. */
  hint: string;
  /** Collector probe ids this view needs. Empty means "always available". */
  requires: string[];
  /** Protocol message types this view renders. Shown in the empty state. */
  consumes: string[];
  component: ComponentType<PanelContext>;
}

export const PANELS: PanelDefinition[] = [
  {
    id: 'overview',
    label: 'Overview',
    hint: 'Live memory, allocation and GC cost.',
    requires: ['runtime-counters'],
    consumes: ['counter.sample'],
    component: OverviewPanelLazy,
  },
  {
    id: 'types',
    label: 'Types',
    hint: 'Which class is allocating and growing.',
    requires: ['allocations'],
    consumes: ['allocation.sample'],
    component: TypesPanelLazy,
  },
  {
    id: 'sites',
    label: 'Call Sites',
    hint: 'Which line of code allocates the memory, named from the module’s PDB.',
    requires: ['allocation-sites'],
    consumes: ['allocation.site'],
    component: CallSitesPanelLazy,
  },
  {
    id: 'gc',
    label: 'GC & Heap',
    hint: 'Heap composition, collections and pause reasons.',
    requires: ['gc-stats'],
    consumes: ['heap.stats', 'gc.event', 'gc.summary'],
    component: GcPanelLazy,
  },
  {
    id: 'insights',
    label: 'Diagnosis',
    hint: 'What the numbers mean and what to check next.',
    requires: [],
    consumes: ['counter.sample', 'allocation.sample', 'heap.stats'],
    component: InsightsPanelLazy,
  },
  {
    id: 'logs',
    label: 'Diagnostics',
    hint: 'Collector output and session statistics.',
    requires: [],
    consumes: ['log', 'error', 'session.started', 'target.exited'],
    component: LogPanelLazy,
  },
  {
    id: 'recordings',
    label: 'Recordings',
    hint: 'Recorded sessions on disk, and replaying them offline.',
    requires: [],
    consumes: [],
    component: RecordingsPanelLazy,
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'Collector location, sampling defaults, capabilities.',
    requires: [],
    consumes: [],
    component: SettingsPanelLazy,
  },
];

export interface ResolvedPanel {
  definition: PanelDefinition;
  available: boolean;
  /** Which required probes are missing, for the explanation shown instead of the view. */
  missing: string[];
}

/**
 * Evaluates every panel against the capabilities the collector reported.
 *
 * Before a session exists the check is optimistic: the capabilities endpoint answers even
 * without a live session, so the shell can show the intended layout rather than an empty
 * frame. If capabilities are entirely unavailable the panels stay enabled — it is better to
 * attempt collection and surface a real error than to pre-emptively hide features.
 */
export function resolvePanels(capabilities: Capabilities | null, enabledProbes: string[]): ResolvedPanel[] {
  const known = capabilities?.probes.map((probe) => probe.id) ?? null;
  const enabled = enabledProbes.length > 0 ? enabledProbes : (capabilities?.probes.map((probe) => probe.id) ?? []);

  return PANELS.map((definition) => {
    if (definition.requires.length === 0 || !known) {
      return { definition, available: true, missing: [] };
    }

    const missing = definition.requires.filter((probe) => !enabled.includes(probe));
    return { definition, available: missing.length === 0, missing };
  });
}

/**
 * Availability when the source is a recording rather than a live collector.
 *
 * A recording carries its own histogram of message types, so the views are enabled by what
 * the file actually contains. That matters because a recording opened on a machine that has
 * never seen the target process has no live capabilities to consult — the evidence is the
 * only handshake available, and it is a better one.
 *
 * Presence of *any* consumed type is enough. A session that lost its GC provider halfway
 * through should still show its counters rather than hiding every view behind one gap.
 */
export function resolvePanelsForRecording(
  messageTypes: Record<string, number> | null | undefined,
): ResolvedPanel[] {
  const present = new Set(Object.keys(messageTypes ?? {}));

  return PANELS.map((definition) => {
    if (definition.requires.length > 0 && definition.consumes.length === 0) {
      return { definition, available: true, missing: [] };
    }

    const missing = definition.consumes.filter((type) => !present.has(type));
    const available = definition.consumes.length === 0 || missing.length < definition.consumes.length;

    return { definition, available, missing: available ? [] : missing };
  });
}

export function panelById(id: string): PanelDefinition | undefined {
  return PANELS.find((panel) => panel.id === id);
}

// The imports at the bottom keep the registry readable: the mapping from view id to
// component is the interesting part, and it should not be buried under a wall of imports.
import { OverviewPanel } from '../components/OverviewPanel';
import { TypesPanel } from '../components/TypesPanel';
import { CallSitesPanel } from '../components/CallSitesPanel';
import { GcPanel } from '../components/GcPanel';
import { InsightsPanel } from '../components/InsightsPanel';
import { LogPanel } from '../components/LogPanel';
import { RecordingsPanel } from '../components/RecordingsPanel';
import { SettingsPanel } from '../components/SettingsPanel';

function OverviewPanelLazy({ store, settings, activeRecordingPath, onOpenTarget }: PanelContext) {
  return (
    <OverviewPanel
      store={store}
      showAllCounters={settings.showAllCounters}
      replaying={activeRecordingPath !== null}
      onOpenFinding={onOpenTarget}
    />
  );
}

function TypesPanelLazy({ store }: PanelContext) {
  return <TypesPanel store={store} />;
}

function CallSitesPanelLazy({ store }: PanelContext) {
  return <CallSitesPanel store={store} />;
}

function GcPanelLazy({ store }: PanelContext) {
  return <GcPanel store={store} />;
}

function InsightsPanelLazy({ store, onOpenTarget }: PanelContext) {
  return <InsightsPanel store={store} onOpenTarget={onOpenTarget} />;
}

function LogPanelLazy({ store, sessionId, onResetCounters }: PanelContext) {
  return <LogPanel store={store} sessionId={sessionId} onReset={onResetCounters} />;
}

function RecordingsPanelLazy({
  recordingsDir,
  activeRecordingPath,
  recordingPath,
  recordingsToken,
  onReplayRecording,
}: PanelContext) {
  return (
    <RecordingsPanel
      recordingsDir={recordingsDir}
      activePath={activeRecordingPath}
      recordingPath={recordingPath}
      refreshToken={recordingsToken}
      onReplay={onReplayRecording}
    />
  );
}

function SettingsPanelLazy({ settings, collector, capabilities, onSaveSettings, onRefreshCollector }: PanelContext) {
  return (
    <SettingsPanel
      settings={settings}
      collector={collector}
      capabilities={capabilities}
      onSave={onSaveSettings}
      onRefreshCollector={onRefreshCollector}
    />
  );
}
