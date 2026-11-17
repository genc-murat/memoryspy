import { useRef, useState } from 'react';

import { dumpReportKey } from './dumpComparison';
import { fileNameOf } from './format';
import { dumpApi } from './ipc';
import type { DumpAnalysis, DumpMethodTable, DumpObject, DumpReference, DumpRoots, DumpSourceLocation } from './types';

export interface DumpRootView {
  frameIndex: number;
  reference: DumpReference | null;
  source: DumpSourceLocation | null;
  expandedGroups: number[];
}

interface DumpInspection {
  typeName: string;
  methodTables: DumpMethodTable[];
  methodTable: string | null;
  objects: DumpObject[] | null;
  roots: DumpRoots | null;
  minKiB: string;
  selected: string[];
  skipStacks: boolean;
  tab: string;
  rootAddress: string;
  rootViews: Record<string, DumpRootView>;
  reportNotes: string;
  reportFullPaths: boolean;
  reportSos: boolean;
}

interface DumpReportView {
  query: string;
  sortByCount: boolean;
  growingOnly: boolean;
  everyInterval: boolean;
  page: number;
  inspectionOpen: boolean;
  inspection: DumpInspection | null;
}

const EMPTY_VIEW: DumpReportView = {
  query: '', sortByCount: false, growingOnly: true, everyInterval: false, page: 0,
  inspectionOpen: false, inspection: null,
};

interface DumpQueueItem {
  path: string;
  state: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  error: string | null;
}

export function useDumpAnalysis() {
  const [path, setPath] = useState('');
  const [reachableOnly, setReachableOnly] = useState(false);
  const [reports, setReports] = useState<DumpAnalysis[]>([]);
  const [queue, setQueue] = useState<DumpQueueItem[]>([]);
  const [queueScope, setQueueScope] = useState<boolean | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [baselineIds, setBaselineIds] = useState<Record<'all' | 'reachable', string | null>>({ all: null, reachable: null });
  const [allocationTraces, setAllocationTraces] = useState<Record<string, string>>({});
  // The report key includes the file fingerprint and scope, keeping cached addresses tied to that dump.
  const [views, setViews] = useState<Record<string, DumpReportView>>({});
  const tablePositions = useRef<Record<string, { top: number; left: number }>>({});
  const [phase, setPhase] = useState<'idle' | 'picking' | 'running' | 'cancelling'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [work, setWork] = useState<{ message: string; detail: string; startedAt: number } | null>(null);
  const active = useRef<symbol | null>(null);
  const cancelRequested = useRef(false);
  const result = reports.find((report) => dumpReportKey(report) === currentId) ?? null;
  const view = currentId ? views[currentId] ?? EMPTY_VIEW : EMPTY_VIEW;
  const inspection = view.inspectionOpen ? view.inspection : null;
  const baselineScope = result?.reachableOnly ? 'reachable' : 'all';
  const baseline = reports.find((report) => dumpReportKey(report) === baselineIds[baselineScope]) ?? null;

  function setBaselineId(id: string | null) {
    setBaselineIds((current) => ({ ...current, [baselineScope]: id }));
    updateView({ page: 0 });
  }

  function updateView(patch: Partial<DumpReportView>) {
    if (!currentId) return;
    if (['query', 'sortByCount', 'growingOnly', 'everyInterval', 'page'].some((key) => key in patch)) {
      tablePositions.current[currentId] = { top: 0, left: 0 };
    }
    setViews((current) => ({
      ...current, [currentId]: { ...EMPTY_VIEW, ...current[currentId], ...patch },
    }));
  }

  function rememberTablePosition(top: number, left: number) {
    if (currentId) tablePositions.current[currentId] = { top, left };
  }

  function getTablePosition() {
    return currentId ? tablePositions.current[currentId] : undefined;
  }

  function updateInspection(patch: Partial<DumpInspection>) {
    if (!currentId) return;
    setViews((current) => {
      const saved = current[currentId];
      if (!saved?.inspection) return current;
      return { ...current, [currentId]: { ...saved, inspection: { ...saved.inspection, ...patch } } };
    });
  }

  function updateRootView(address: string, patch: Partial<DumpRootView>) {
    if (!currentId) return;
    setViews((current) => {
      const saved = current[currentId];
      const inspected = saved?.inspection;
      const path = inspected?.roots?.paths.find((path) => path.address === address);
      if (!inspected || !path) return current;
      const rootView = inspected.rootViews[address] ?? {
        frameIndex: path.applicationFrameIndex ?? Math.max(0, path.frames.length - 2),
        reference: path.reference, source: null, expandedGroups: [],
      };
      return {
        ...current,
        [currentId]: {
          ...saved,
          inspection: {
            ...inspected,
            rootViews: { ...inspected.rootViews, [address]: { ...rootView, ...patch } },
          },
        },
      };
    });
  }

  function viewReport(report: DumpAnalysis) {
    setCurrentId(dumpReportKey(report));
    setPath(report.path);
    setReachableOnly(report.reachableOnly);
    setError(null);
    setStatus(null);
  }

  async function pick() {
    if (phase !== 'idle') return;
    setError(null);
    setPhase('picking');
    try {
      const selected = await dumpApi.pickDumps();
      if (selected?.length) {
        const paths = [...new Set(selected)];
        setQueue(paths.map((path) => ({ path, state: 'pending', error: null })));
        setQueueScope(null);
        setPath(paths[0]);
        setStatus(null);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPhase('idle');
    }
  }

  async function run<T>(message: string, task: (progress: (detail: string) => void) => Promise<T | null>) {
    if (active.current) return null;
    const token = Symbol();
    active.current = token;
    cancelRequested.current = false;
    setError(null);
    setStatus(null);
    setWork({ message, detail: '', startedAt: Date.now() });
    setPhase('running');
    try {
      const value = await task((detail) => {
        if (active.current === token) setWork((current) => current && { ...current, detail });
      });
      setStatus(value === null ? 'Analysis cancelled.' : null);
      return value;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setStatus(null);
      return null;
    } finally {
      active.current = null;
      setWork(null);
      setPhase('idle');
    }
  }

  async function analyze() {
    if (queue.length) {
      await analyzeQueue(queue.filter((item) => item.state === 'pending' || item.state === 'cancelled').map((item) => item.path));
      return;
    }
    if (!path.trim() || phase !== 'idle') return;
    const next = await run(reachableOnly ? 'Finding reachable objects…' : 'Scanning the managed heap…',
      (progress) => dumpApi.analyze(path, reachableOnly, progress));
    if (next) {
      storeReport(next);
    }
  }

  function storeReport(report: DumpAnalysis) {
    const key = dumpReportKey(report);
    setReports((current) => current.some((item) => dumpReportKey(item) === key)
      ? current.map((item) => dumpReportKey(item) === key ? report : item)
      : [...current, report]);
    viewReport(report);
  }

  async function analyzeQueue(paths: string[]) {
    if (!paths.length || phase !== 'idle') return;
    const scope = queueScope ?? reachableOnly;
    setQueueScope(scope);
    const outcome = await run('Analyzing dump files…', async (progress) => {
      let completed = 0;
      let failed = 0;
      let stopped = false;
      for (const [index, path] of paths.entries()) {
        if (cancelRequested.current) {
          stopped = true;
          break;
        }
        setQueue((current) => current.map((item) => item.path === path ? { ...item, state: 'running', error: null } : item));
        setWork({
          message: `Analyzing dump ${index + 1} of ${paths.length} · ${fileNameOf(path)}`,
          detail: path,
          startedAt: Date.now(),
        });
        try {
          const report = await dumpApi.analyze(path, scope, progress);
          if (report === null) {
            setQueue((current) => current.map((item) => item.path === path ? { ...item, state: 'cancelled' } : item));
            stopped = true;
            break;
          }
          storeReport(report);
          completed += 1;
          setQueue((current) => current.map((item) => item.path === path ? { ...item, state: 'complete' } : item));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed += 1;
          setQueue((current) => current.map((item) => item.path === path ? { ...item, state: 'failed', error: message } : item));
        }
      }
      return { completed, failed, stopped: stopped || cancelRequested.current };
    });
    if (outcome) {
      setStatus(`${outcome.stopped ? 'Queue stopped. ' : ''}${outcome.completed} analyzed, ${outcome.failed} failed.`);
    }
  }

  function retryFailed() {
    return analyzeQueue(queue.filter((item) => item.state === 'failed').map((item) => item.path));
  }

  function clearQueue() {
    if (phase !== 'idle') return;
    setQueue([]);
    setQueueScope(null);
  }

  function changePath(path: string) {
    clearQueue();
    setPath(path);
  }

  function moveQueuedFile(path: string, direction: number) {
    if (phase !== 'idle' || queue.some((item) => item.state !== 'pending')) return;
    setQueue((current) => {
      const from = current.findIndex((item) => item.path === path);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }

  function moveReport(key: string, direction: number) {
    if (phase !== 'idle') return;
    updateView({ page: 0 });
    setReports((current) => {
      const report = current.find((item) => dumpReportKey(item) === key);
      if (!report) return current;
      const peers = current.filter((item) => item.reachableOnly === report.reachableOnly);
      const target = peers[peers.indexOf(report) + direction];
      if (!target) return current;
      const from = current.indexOf(report);
      const to = current.indexOf(target);
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }

  function selectType(typeName: string, methodTables: DumpMethodTable[]) {
    if (view.inspection?.typeName === typeName) {
      updateView({ inspectionOpen: true });
      return;
    }
    const methodTable = methodTables.length === 1 ? methodTables[0].methodTable : null;
    updateView({ inspectionOpen: true, inspection: {
      typeName, methodTables, methodTable, objects: null, roots: null,
      minKiB: '0', selected: [], skipStacks: false, tab: 'retention', rootAddress: '', rootViews: {},
      reportNotes: '', reportFullPaths: false, reportSos: false,
    } });
  }

  function selectMethodTable(methodTable: string | null) {
    updateInspection({ methodTable, objects: null, roots: null, selected: [], rootAddress: '', rootViews: {} });
  }

  function closeInspection() {
    updateView({ inspectionOpen: false });
  }

  function dismissError() {
    setError(null);
  }

  function linkAllocationTrace(trace: string) {
    if (result) setAllocationTraces((current) => ({ ...current, [result.id]: trace }));
  }

  async function findObjects(minBytes: number) {
    if (!result || !inspection?.methodTable || phase !== 'idle') return;
    const methodTable = inspection.methodTable;
    updateInspection({ objects: null, roots: null, selected: [], rootAddress: '', rootViews: {} });
    const objects = await run('Finding objects of this type…',
      (progress) => dumpApi.sampleObjects(result, methodTable, minBytes, progress));
    if (objects) updateInspection({ objects, roots: null, selected: objects[0] ? [objects[0].address] : [] });
    return objects;
  }

  async function inspectRoots(addresses: string[], skipStacks: boolean) {
    if (!result || !inspection || phase !== 'idle') return;
    updateInspection({ roots: null, rootAddress: '', rootViews: {} });
    const roots = await run('Tracing GC roots…', (progress) => dumpApi.inspectRoots(result, addresses, skipStacks, progress));
    if (roots) updateInspection({ roots });
  }

  function inspectReference(parent: string, child: string | null) {
    if (!result || phase !== 'idle') return Promise.resolve(null);
    return run('Reading the reference fields…', () => dumpApi.inspectReference(result, parent, child));
  }

  function resolveSource(assembly: string, reference: DumpReference, methodName: string | null) {
    if (!result || phase !== 'idle') return Promise.resolve(null);
    return run('Matching the dump module and PDB…', () =>
      dumpApi.resolveSource(result, assembly, reference.methodTable, reference.typeName, methodName));
  }

  async function cancel() {
    cancelRequested.current = true;
    setPhase('cancelling');
    await dumpApi.cancel().catch((error: Error) => {
      setError(error.message);
      setPhase((current) => current === 'cancelling' ? 'running' : current);
    });
  }

  return {
    path, setPath: changePath, reachableOnly, setReachableOnly, result, baseline, reports, viewReport, setBaselineId, inspection, view,
    queue, queueScope, clearQueue, moveQueuedFile, moveReport, retryFailed,
    updateView, updateInspection, updateRootView, rememberTablePosition, getTablePosition,
    allocationTrace: result ? allocationTraces[result.id] ?? '' : '', linkAllocationTrace,
    phase, error, status, work, pick, analyze, cancel, selectType, selectMethodTable, closeInspection, dismissError,
    findObjects, inspectRoots, inspectReference, resolveSource,
  };
}
