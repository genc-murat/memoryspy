import type { DumpMethodTable, DumpType } from './types';

export interface DumpTypeChange {
  typeName: string;
  methodTables: DumpMethodTable[];
  objectCount: number;
  totalBytes: number;
  deltaCount: number;
  deltaBytes: number;
  growingByteIntervals: number;
  growingCountIntervals: number;
}

interface TypeSummary {
  objectCount: number;
  totalBytes: number;
  tables: Map<string, DumpType>;
}

function summarizeTypes(rows: DumpType[]): Map<string, TypeSummary> {
  const totals = new Map<string, TypeSummary>();
  for (const row of rows) {
    const total = totals.get(row.typeName);
    if (total) {
      total.objectCount += row.objectCount;
      total.totalBytes += row.totalBytes;
      total.tables.set(row.methodTable, row);
    } else {
      totals.set(row.typeName, {
        objectCount: row.objectCount,
        totalBytes: row.totalBytes,
        tables: new Map([[row.methodTable, row]]),
      });
    }
  }
  return totals;
}

export function compareDumpTypes(captures: DumpType[][]): DumpTypeChange[] {
  const summaries = captures.map(summarizeTypes);
  const before = summaries[0];
  const after = summaries[summaries.length - 1];
  if (!before || !after) return [];

  const typeNames = new Set([...after.keys(), ...before.keys()]);
  for (const summary of summaries) {
    for (const typeName of summary.keys()) typeNames.add(typeName);
  }

  return Array.from(typeNames, (typeName) => {
    const old = before.get(typeName);
    const next = after.get(typeName);
    const objectCount = next?.objectCount ?? 0;
    const totalBytes = next?.totalBytes ?? 0;
    let growingByteIntervals = 0;
    let growingCountIntervals = 0;
    for (let i = 1; i < summaries.length; i += 1) {
      const previous = summaries[i - 1].get(typeName);
      const current = summaries[i].get(typeName);
      if ((current?.totalBytes ?? 0) > (previous?.totalBytes ?? 0)) growingByteIntervals += 1;
      if ((current?.objectCount ?? 0) > (previous?.objectCount ?? 0)) growingCountIntervals += 1;
    }
    const methodTables = Array.from(next?.tables.values() ?? [], (table) => {
      const oldTable = old?.tables.get(table.methodTable);
      return {
        ...table,
        baselineCount: oldTable?.objectCount ?? null,
        baselineBytes: oldTable?.totalBytes ?? null,
      };
    });
    return {
      typeName,
      methodTables,
      objectCount,
      totalBytes,
      deltaCount: objectCount - (old?.objectCount ?? 0),
      deltaBytes: totalBytes - (old?.totalBytes ?? 0),
      growingByteIntervals,
      growingCountIntervals,
    };
  });
}
