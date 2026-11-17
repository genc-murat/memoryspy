import { useRef, useState } from 'react';

import { dumpReportKey } from './dumpComparison';
import { dumpApi } from './ipc';
import type { DumpAnalysis, DumpMethodTable, DumpObject, DumpReference, DumpRoots } from './types';

interface DumpInspection {
  typeName: string;
  methodTables: DumpMethodTable[];
  methodTable: string | null;
  objects: DumpObject[] | null;
  roots: DumpRoots | null;
}

export function useDumpAnalysis() {
  const [path, setPath] = useState('');
  const [reachableOnly, setReachableOnly] = useState(false);
  const [reports, setReports] = useState<DumpAnalysis[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [baselineIds, setBaselineIds] = useState<Record<'all' | 'reachable', string | null>>({ all: null, reachable: null });
  const [allocationTraces, setAllocationTraces] = useState<Record<string, string>>({});
  const [inspection, setInspection] = useState<DumpInspection | null>(null);
  const [phase, setPhase] = useState<'idle' | 'picking' | 'running' | 'cancelling'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [work, setWork] = useState<{ message: string; detail: string; startedAt: number } | null>(null);
  const active = useRef<symbol | null>(null);
  const result = reports.find((report) => dumpReportKey(report) === currentId) ?? null;
  const baselineScope = result?.reachableOnly ? 'reachable' : 'all';
  const baseline = reports.find((report) => dumpReportKey(report) === baselineIds[baselineScope]) ?? null;

  function setBaselineId(id: string | null) {
    setBaselineIds((current) => ({ ...current, [baselineScope]: id }));
  }

  function viewReport(report: DumpAnalysis) {
    setCurrentId(dumpReportKey(report));
    setPath(report.path);
    setReachableOnly(report.reachableOnly);
    setInspection(null);
    setError(null);
  }

  async function pick() {
    setError(null);
    setPhase('picking');
    try {
      const selected = await dumpApi.pick();
      if (selected !== null) setPath(selected);
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
    if (!path.trim() || phase !== 'idle') return;
    const next = await run(reachableOnly ? 'Finding reachable objects…' : 'Scanning the managed heap…',
      (progress) => dumpApi.analyze(path, reachableOnly, progress));
    if (next) {
      const key = dumpReportKey(next);
      setReports((current) => current.some((report) => dumpReportKey(report) === key)
        ? current.map((report) => dumpReportKey(report) === key ? next : report)
        : [...current, next]);
      viewReport(next);
    }
  }

  function selectType(typeName: string, methodTables: DumpMethodTable[]) {
    const methodTable = methodTables.length === 1 ? methodTables[0].methodTable : null;
    setInspection({ typeName, methodTables, methodTable, objects: null, roots: null });
  }

  function selectMethodTable(methodTable: string | null) {
    setInspection((current) => current && { ...current, methodTable, objects: null, roots: null });
  }

  function linkAllocationTrace(trace: string) {
    if (result) setAllocationTraces((current) => ({ ...current, [result.id]: trace }));
  }

  async function findObjects(minBytes: number) {
    if (!result || !inspection?.methodTable || phase !== 'idle') return;
    const methodTable = inspection.methodTable;
    setInspection({ ...inspection, objects: null, roots: null });
    const objects = await run('Finding objects of this type…',
      (progress) => dumpApi.sampleObjects(result, methodTable, minBytes, progress));
    if (objects) setInspection({ ...inspection, objects, roots: null });
  }

  async function inspectRoots(addresses: string[], skipStacks: boolean) {
    if (!result || !inspection || phase !== 'idle') return;
    setInspection({ ...inspection, roots: null });
    const roots = await run('Tracing GC roots…', (progress) => dumpApi.inspectRoots(result, addresses, skipStacks, progress));
    if (roots) setInspection({ ...inspection, roots });
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
    setPhase('cancelling');
    await dumpApi.cancel().catch((error: Error) => {
      setError(error.message);
      setPhase((current) => current === 'cancelling' ? 'running' : current);
    });
  }

  return {
    path, setPath, reachableOnly, setReachableOnly, result, baseline, reports, viewReport, setBaselineId, inspection,
    allocationTrace: result ? allocationTraces[result.id] ?? '' : '', linkAllocationTrace,
    phase, error, status, work, pick, analyze, cancel, selectType, selectMethodTable, findObjects, inspectRoots, inspectReference, resolveSource,
  };
}
