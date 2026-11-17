import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDumpReport, dumpReportFileName } from '../src/lib/dumpReport.ts';

const typeName = 'Example.SessionRecord';
const type = (methodTable, objectCount, totalBytes) => ({ typeName, methodTable, objectCount, totalBytes });
const report = (id, types, reachableOnly = false) => ({
  id, path: `C:\\dumps\\${id}.dmp`, types, reachableOnly,
  durationMs: 50, totalBytes: 10240, freeBytes: 0, objectCount: 100, notices: [],
});
const before = report('before', [type('0x1', 1, 1024), type('0x2', 2, 2048)]);
const current = report('current', [type('0x1', 2, 2048), type('0x2', 4, 4096)]);
function input(patch = {}) {
  return {
    report: current, reports: [before, current], baseline: before, trace: null,
    inspection: {
      typeName, methodTable: '0x1', roots: null, rootViews: {},
      reportNotes: '', reportFullPaths: false, reportSos: false,
    },
    ...patch,
  };
}
function rooted() {
  const value = input();
  value.inspection.roots = {
    samplesChecked: 3, skipStacks: true,
    paths: [{
      address: '0x300', rootKind: 'Handle', applicationFrameIndex: 0, stackMethod: null,
      frames: [
        { address: '0x100', typeName: 'Example.Cache', staticField: 'Instance' },
        { address: '0x200', typeName: 'System.Object[]', staticField: null },
        { address: '0x300', typeName, staticField: null },
      ],
      reference: { typeName: 'Example.Cache', methodTable: '0x9', fields: ['_items'], assemblyPath: 'C:\\app\\Example.dll' },
      trace: 'RAW SOS\n```\nC:\\private\\build', traceTruncated: true,
    }],
    unrooted: ['0x400'], failures: [{ address: '0x500', message: 'Tool unavailable\nPlease check DAC.' }],
  };
  return value;
}

test('growth aggregates every method table and records capture identity', () => {
  const text = buildDumpReport(input());
  assert.ok(text.includes('- Type objects: 6'));
  assert.ok(text.includes('- Object change: +3'));
  assert.ok(text.includes('- Shallow size change: +3.00 KB (3,072 bytes)'));
  assert.ok(text.includes('| 1 | before.dmp | before | 3 | 3,072 |'));
  assert.ok(text.includes('| 2 | current.dmp | current | 6 | 6,144 |'));
  assert.ok(text.includes('Growth has not been established.') === false);
});

test('comparison respects scope and stops at the current capture', () => {
  const otherScope = report('other-scope', [type('0x1', 99, 99999)], true);
  const future = report('future', [type('0x1', 20, 20000)]);
  const value = input({ reports: [before, otherScope, current, future] });
  const text = buildDumpReport(value);
  assert.ok(!text.includes('other-scope'));
  assert.ok(!text.includes('future'));
  assert.ok(text.includes('grew in 1 of 1 intervals'));
  for (const baseline of [otherScope, current, future, null]) {
    const withoutBaseline = buildDumpReport({ ...value, baseline });
    assert.ok(withoutBaseline.includes('Growth has not been established.'));
    assert.ok(!withoutBaseline.includes('Shallow size change:'));
  }
});

test('a type absent from the current dump can report a decrease', () => {
  const empty = report('empty', []);
  const text = buildDumpReport(input({ report: empty, reports: [before, empty] }));
  assert.ok(text.includes('- Type objects: 0'));
  assert.ok(text.includes('- Object change: -3'));
  assert.ok(text.includes('- Shallow size change: -3.00 KB (-3,072 bytes)'));
});

test('root outcomes preserve missing evidence and search scope', () => {
  const text = buildDumpReport(rooted());
  assert.ok(text.includes('3 sample objects: 1 rooted, 1 with no non-stack root found, 1 failed'));
  assert.ok(text.includes('Stack roots: excluded'));
  assert.ok(text.includes('Named reference fields to the next object: ` _items `'));
  assert.ok(text.includes('this does not establish that the object is unreachable'));
  assert.ok(text.includes('Tool unavailable\nPlease check DAC.'));
  assert.ok(text.includes('Repeat the root search with stack roots included'));
  assert.ok(!text.includes('RAW SOS'));
  assert.ok(text.includes('does not by itself prove a leak'));
});

test('source anchors and fields stay tied to the inspected chain object', () => {
  const value = rooted();
  value.inspection.rootViews['0x300'] = {
    frameIndex: 1,
    reference: { typeName: 'System.Object[]', methodTable: '0x8', fields: [], assemblyPath: null },
    source: { sourceFile: 'C:\\code\\Cache.cs', sourceLine: 42, methodName: 'Example.Cache', isMethodLocation: false, sha256: 'abc' },
  };
  const text = buildDumpReport(value);
  assert.ok(text.includes('Inspected chain object: ` System.Object[] ` at ` 0x200 `'));
  assert.ok(text.includes('SOS did not identify a named field for this link'));
  assert.ok(!text.includes('Named reference fields to the next object:'));
  assert.ok(text.includes('Type source anchor: ` Cache.cs `, line 42'));
  assert.ok(!text.includes('C:\\code\\Cache.cs'));
  value.inspection.reportFullPaths = true;
  assert.ok(buildDumpReport(value).includes('C:\\code\\Cache.cs'));
});

test('raw output and notes cannot terminate their Markdown fences', () => {
  const value = rooted();
  value.inspection.reportSos = true;
  value.inspection.reportNotes = 'Check cleanup\n```\n# not a report heading';
  const text = buildDumpReport(value);
  assert.ok(text.includes('````text\nRAW SOS\n```\nC:\\private\\build\n````'));
  assert.ok(text.includes('````text\nCheck cleanup\n```\n# not a report heading\n````'));
  assert.ok(text.includes('SOS output was shortened during analysis.'));
});

test('linked allocation samples are separated from surviving objects', () => {
  const trace = {
    captureFile: '/tmp/capture.nettrace',
    types: [{ typeName, sites: Array.from({ length: 6 }, (_, i) => ({
      site: `Example.Create${i}`, sampledBytes: 1024, sourceFile: '/src/Cache.cs', sourceLine: i + 1,
    })) }],
  };
  const text = buildDumpReport(input({ trace }));
  assert.ok(text.includes('Top 5 of 6 recorded sites'));
  assert.ok(text.includes('Example.Create4'));
  assert.ok(!text.includes('Example.Create5'));
  assert.ok(text.includes('not which objects survived in this dump'));
  assert.ok(!text.includes('/src/Cache.cs'));
});

test('partial investigations and unusual names remain exportable', () => {
  const value = input({ baseline: null });
  value.report.path = 'C:\\dumps\\part|<one>.dmp';
  value.inspection.typeName = 'Example.`Name`';
  const text = buildDumpReport(value);
  assert.ok(text.includes('`` Example.`Name` ``'));
  assert.ok(text.includes('part\\|&lt;one&gt;.dmp'));
  assert.ok(text.includes('GC roots have not been searched'));
  const fileName = dumpReportFileName('C:\\dumps\\common.dmp', 'Example.Type`<>/..:X');
  assert.match(fileName, /^[a-zA-Z0-9._-]+-investigation\.md$/);
  assert.ok(fileName.length < 180);
});
