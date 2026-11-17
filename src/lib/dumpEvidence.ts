import type { AllocationSiteData, DumpRootFrame } from './types';

export function allocationTraceKey(trace: AllocationSiteData): string {
  return JSON.stringify([trace.captureFile, trace.windowStartUnixMs, trace.windowEndUnixMs]);
}

export type DumpChainItem =
  | { kind: 'frame'; index: number }
  | { kind: 'framework'; start: number; end: number };

export function groupDumpChain(frames: DumpRootFrame[], applicationIndex: number | null): DumpChainItem[] {
  const items: DumpChainItem[] = [];
  const canGroup = (index: number) => index > 0 && index < frames.length - 1 &&
    index !== applicationIndex && !frames[index].staticField &&
    ['System.', 'Microsoft.', 'Internal.'].some((prefix) => frames[index].typeName.startsWith(prefix));
  let start = 0;
  while (start < frames.length) {
    if (!canGroup(start)) {
      items.push({ kind: 'frame', index: start++ });
      continue;
    }
    let end = start + 1;
    while (end < frames.length && canGroup(end)) end += 1;
    items.push(end - start > 1 ? { kind: 'framework', start, end } : { kind: 'frame', index: start });
    start = end;
  }
  return items;
}
