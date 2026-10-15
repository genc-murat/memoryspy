/**
 * A development-only stand-in for the Rust backend.
 *
 * Enabled by opening the app with `?mock=1` in a dev build. It exists for two reasons:
 * the UI can be built and reviewed on a machine without .NET or a leaking process to
 * attach to, and the rendering of every chart, table and finding can be exercised without
 * a collector in the loop.
 *
 * It deliberately produces the *same* envelope shapes the collector does, so it validates
 * the real protocol rather than a convenient fiction. It is never reachable in a production
 * build: `MOCK_ENABLED` requires `import.meta.env.DEV`.
 */

import type {
  AllocationSampleData,
  AllocationFrame,
  AllocationSite,
  AllocationSiteData,
  AllocationSiteType,
  Capabilities,
  CollectorLocation,
  CollectorMessage,
  CounterReading,
  DotnetProcessInfo,
  EnvironmentInfo,
  HeapSnapshotData,
  HeapStatsData,
  PlaybackState,
  PlaybackStatusEvent,
  RecordingSummary,
  SessionRequest,
  SessionSnapshot,
  Settings,
  TypeSnapshot,
} from './types';

export const MOCK_ENABLED = (() => {
  if (typeof window === 'undefined') return false;
  // `import.meta.env` is undefined outside Vite; guard rather than assume.
  const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  return isDev && new URLSearchParams(window.location.search).has('mock');
})();

const MB = 1024 * 1024;

const SETTINGS: Settings = {
  collectorPath: null,
  defaultProbes: [],
  intervalMs: 1000,
  maxAllocationTypes: 150,
  historySeconds: 300,
  showAllCounters: false,
  verboseCollector: false,
  lastSession: null,
};

const COLLECTOR: CollectorLocation = {
  found: true,
  dotnetPath: '/usr/local/share/dotnet/dotnet',
  assemblyPath: '/mock/collector/bin/Debug/net10.0/MemorySpy.Collector.dll',
  source: 'build-output',
  dotnetVersion: '10.0.301',
  searched: [],
  error: null,
};

const CAPABILITIES: Capabilities = {
  protocolVersion: 1,
  tool: 'MemorySpy.Collector',
  runtime: '.NET 10.0.9',
  os: 'mock',
  architecture: 'Arm64',
  supports: [
    'runtime-counters',
    'per-type-allocation',
    'gc-events',
    'heap-stats',
    'live-reconfigure',
    'raw-capture',
    'allocation-call-sites',
  ],
  probes: [
    {
      id: 'runtime-counters',
      displayName: 'Runtime Counters',
      description: 'Live .NET runtime counters: memory, GC, thread pool, JIT and CPU.',
      icon: 'gauge',
      channel: 'Dynamic',
      eventTypes: ['counter.sample'],
      details: {},
    },
    {
      id: 'allocations',
      displayName: 'Allocations by Type',
      description: 'Sampled allocations per type, ranked by growth.',
      icon: 'layers',
      channel: 'Clr',
      eventTypes: ['allocation.sample'],
      details: {},
    },
    {
      id: 'allocation-sites',
      displayName: 'Allocation Call Sites',
      description: 'Which code allocates the memory, read from a raw capture.',
      icon: 'target',
      channel: 'None',
      eventTypes: ['allocation.site'],
      details: { requiresCapture: true },
    },
    {
      id: 'gc-stats',
      displayName: 'GC & Heap',
      description: 'Per-generation heap composition, collection events and pause durations.',
      icon: 'activity',
      channel: 'Clr',
      eventTypes: ['heap.stats', 'gc.event', 'gc.summary'],
      details: {},
    },
    {
      id: 'heap-snapshot',
      displayName: 'Heap Snapshot',
      description: 'Walks the live object graph on demand: what survives collection, and which root keeps it alive.',
      icon: 'layers',
      channel: 'None',
      eventTypes: ['heap.snapshot'],
      details: {},
    },
  ],
  enabledProbes: ['runtime-counters', 'allocations', 'allocation-sites', 'gc-stats', 'heap-snapshot'],
  options: { pid: 4242, intervalMs: 1000, maxAllocationTypes: 150 },
  target: null,
};

const PROCESSES: DotnetProcessInfo[] = [
  {
    pid: 4242,
    name: 'OrderService.Api',
    commandLine: 'dotnet /srv/orders/OrderService.Api.dll --urls http://0.0.0.0:5080',
    runtimeVersion: '10.0.9',
    workingSetBytes: 1_412 * MB,
    startTimeUnixMs: Date.now() - 1000 * 60 * 143,
  },
  {
    pid: 4310,
    name: 'Rider.Backend',
    commandLine: '/Applications/Rider.app/Contents/lib/ReSharperHost/Rider.Backend --Port=49257',
    runtimeVersion: '10.0.5',
    workingSetBytes: 812 * MB,
    startTimeUnixMs: Date.now() - 1000 * 60 * 61,
  },
  {
    pid: 4477,
    name: 'MemorySpy.Samples.LeakyCache',
    commandLine: 'dotnet samples/LeakyCache/bin/Debug/net10.0/MemorySpy.Samples.LeakyCache.dll cache',
    runtimeVersion: '10.0.9',
    workingSetBytes: 306 * MB,
    startTimeUnixMs: Date.now() - 1000 * 90,
  },
];

let timer: ReturnType<typeof setInterval> | null = null;

/** Set while a mock session is pretending to copy its raw event stream to disk. */
let mockCapture: { path: string; startedAt: number } | null = null;
let seq = 0;

function envelope<T>(type: string, probe: string | null, data: T): CollectorMessage<T> {
  return { v: 1, seq: ++seq, ts: Date.now(), type, probe, data };
}

function counter(name: string, displayName: string, category: string, value: number, unit: string, isMemory: boolean): CounterReading {
  return {
    name,
    displayName,
    category: category as CounterReading['category'],
    value,
    unit: unit as CounterReading['unit'],
    isMemory,
    counterType: unit === 'count' ? 'Sum' : 'Mean',
    rawUnit: unit === 'bytes' ? 'B' : unit === 'percent' ? '%' : undefined,
  };
}

/** One simulated second of a service with a steadily growing Gen 2. */
function tick(elapsedSeconds: number): CollectorMessage[] {
  const messages: CollectorMessage[] = [];
  const jitter = (scale: number) => (Math.random() - 0.5) * scale;

  const gen2 = 148 * MB + elapsedSeconds * 0.78 * MB;
  const loh = 22 * MB + elapsedSeconds * 0.05 * MB;
  const gen1 = 8 * MB + jitter(2 * MB);
  const gen0 = 24 + jitter(200);
  const heap = gen0 + gen1 + gen2 + loh + 8192;
  const workingSet = heap + 62 * MB + jitter(8 * MB);
  const allocRate = 11.4 * MB + jitter(2 * MB);
  const timeInGc = 3.4 + jitter(1.6);
  const cpu = 58 + jitter(14);

  messages.push(
    envelope('counter.sample', 'runtime-counters', {
      intervalMs: 1000,
      sampleIndex: Math.round(elapsedSeconds),
      counters: [
        counter('working-set', 'Working Set', 'Memory', workingSet, 'bytes', true),
        counter('gc-heap-size', 'GC Heap Size', 'Memory', heap, 'bytes', true),
        counter('gen-2-size', 'Gen 2 Size', 'Memory', gen2, 'bytes', true),
        counter('gen-1-size', 'Gen 1 Size', 'Memory', gen1, 'bytes', true),
        counter('gen-0-size', 'Gen 0 Size', 'Memory', gen0, 'bytes', true),
        counter('loh-size', 'LOH Size', 'Memory', loh, 'bytes', true),
        counter('gc-committed', 'GC Committed', 'Memory', heap + 40 * MB, 'bytes', true),
        counter('alloc-rate', 'Allocation Rate', 'Memory', allocRate, 'bytes-per-second', true),
        counter('time-in-gc', 'Time in GC', 'GC', timeInGc, 'percent', false),
        counter('gc-fragmentation', 'GC Fragmentation', 'GC', 1.8 + jitter(0.6), 'percent', false),
        counter('gen-0-gc-count', 'Gen 0 GC Count', 'GC', 40 + jitter(6), 'count', false),
        counter('gen-2-gc-count', 'Gen 2 GC Count', 'GC', 0, 'count', false),
        counter('total-pause-time-by-gc', 'GC Pause Time', 'GC', 18 + jitter(10), 'ms', false),
        counter('cpu-usage', 'CPU Usage', 'CPU', cpu, 'percent', false),
        counter('threadpool-thread-count', 'ThreadPool Threads', 'ThreadPool', 12 + jitter(2), 'count', false),
        counter('threadpool-queue-length', 'ThreadPool Queue', 'ThreadPool', Math.max(0, jitter(2)), 'count', false),
        counter('exception-count', 'Exceptions', 'Exceptions', Math.max(0, 6 + jitter(10)), 'count', false),
        counter('methods-jitted-count', 'Methods Jitted', 'JIT', 1830 + elapsedSeconds * 0.4, 'count', false),
      ],
    }),
  );

  const types: TypeSnapshot[] = [
    type('SessionRecord', 3.1 * MB + jitter(0.3 * MB), elapsedSeconds, 56),
    type('System.Byte[]', 11.0 * MB + jitter(1.5 * MB), elapsedSeconds, 280),
    type('System.String', 2.1 * MB + jitter(0.4 * MB), elapsedSeconds, 96),
    type('Entry[System.Guid,SessionRecord][]', 0.42 * MB + jitter(0.2 * MB), elapsedSeconds, 44 * MB),
    type('System.Int32[]', 0.22 * MB + jitter(0.1 * MB), elapsedSeconds, 5 * MB),
    type('System.Threading.TimerQueueTimer', 0.05 * MB, elapsedSeconds, 108),
  ];

  messages.push(
    envelope('allocation.sample', 'allocations', {
      intervalMs: 1000,
      totalIntervalBytes: types.reduce((sum, entry) => sum + entry.intervalBytes, 0),
      totalIntervalTicks: 168,
      totalBytes: types.reduce((sum, entry) => sum + entry.totalBytes, 0),
      totalTicks: 168 * Math.round(elapsedSeconds),
      // The mock plays the plain (uncaptured) session, which is the tick basis: a real capture
      // session reports 'allocationSampling' and 0 here instead.
      samplingBasis: 'tick',
      tickApproximateBytes: 100 * 1024,
      typeCount: types.length,
      types,
    } satisfies AllocationSampleData),
  );

  if (Math.round(elapsedSeconds) % 2 === 0) {
    const stats: HeapStatsData = {
      totalHeapBytes: heap,
      totalPromotedBytes: 24 * MB,
      gen0Bytes: gen0,
      gen1Bytes: gen1,
      gen2Bytes: gen2,
      lohBytes: loh,
      pohBytes: 8192,
      promotedGen0Bytes: 8 * MB,
      promotedGen1Bytes: 16 * MB,
      promotedGen2Bytes: 0,
      promotedLohBytes: 0,
      promotedPohBytes: 0,
      finalizationPromotedBytes: 0,
      finalizationPromotedCount: 0,
      pinnedObjectCount: 0,
      gcHandleCount: 104 + Math.round(elapsedSeconds * 0.1),
      sinkBlockCount: 1,
      gen0Collections: Math.round(elapsedSeconds * 6),
      gen1Collections: Math.round(elapsedSeconds * 1.2),
      gen2Collections: 0,
    };

    messages.push(envelope('heap.stats', 'gc-stats', stats));
    messages.push(
      envelope('gc.summary', 'gc-stats', {
        intervalMs: 1000,
        gen0Collections: 6,
        gen1Collections: 1,
        gen2Collections: 0,
        finalizedObjects: 0,
      }),
    );

    messages.push(
      envelope('gc.event', 'gc-stats', {
        kind: 'collection',
        gcCount: 400 + Math.round(elapsedSeconds),
        generation: 0,
        generationName: 'Gen 0',
        reason: 0,
        reasonName: 'Small allocation',
        isBackground: false,
        pauseMs: 1.4 + Math.random() * 2,
        startedAt: Date.now(),
      }),
    );
  }

  return messages;
}

function type(name: string, intervalBytes: number, elapsed: number, averageObjectBytes: number): TypeSnapshot {
  return {
    typeName: name,
    intervalBytes,
    intervalBytesPerSecond: intervalBytes,
    totalBytes: intervalBytes * Math.max(1, elapsed),
    tickCount: Math.round(intervalBytes / (100 * 1024)),
    sizedSampleCount: 120,
    averageObjectBytes,
    largestObjectBytes: averageObjectBytes,
    firstSeenUnixMs: Date.now() - 1000,
    lastSeenUnixMs: Date.now(),
  };
}

type MessageHandler = (batch: { sessionId: string; messages: CollectorMessage[] }) => void;
type LogHandler = (entry: { sessionId: string; level: string; message: string }) => void;
type PlaybackHandler = (status: PlaybackStatusEvent) => void;
type StatusHandler = (status: {
  sessionId: string;
  pid: number;
  state: SessionSnapshot['state'];
  detail?: string | null;
  stats: SessionSnapshot['stats'];
}) => void;

const SESSION_ID = 'mock-session';

let handlers: {
  messages: MessageHandler;
  log: LogHandler;
  status: StatusHandler;
  playback: PlaybackHandler;
} | null = null;

/**
 * Registers the app's event handlers. The simulated stream stays idle until `startSession`
 * runs, so the mock behaves like the real backend: nothing arrives until you attach.
 */
export function startMockStream(
  onMessages: MessageHandler,
  onLog: LogHandler,
  onStatus: StatusHandler,
  onPlayback: PlaybackHandler,
) {
  handlers = { messages: onMessages, log: onLog, status: onStatus, playback: onPlayback };
  return () => {
    handlers = null;
    stopMockStream();
  };
}

/** Begins streaming synthetic metrics, mirroring what an attach would produce. */
export function beginMockSession(capturePath: string | null = null): SessionSnapshot {
  const started = new Date();
  mockCapture = capturePath ? { path: capturePath, startedAt: started.getTime() } : null;

  handlers?.status({
    sessionId: SESSION_ID,
    pid: MOCK_TARGET_PID,
    state: 'running',
    detail: null,
    stats: emptyStats(),
  });

  handlers?.log({
    sessionId: SESSION_ID,
    level: 'info',
    message: 'Mock backend active — no real process is being inspected.',
  });

  handlers?.messages({
    sessionId: SESSION_ID,
    messages: [
      envelope('session.started', null, {
        pid: MOCK_TARGET_PID,
        intervalMs: 1000,
        probes: CAPABILITIES.probes.map((probe) => ({
          id: probe.id,
          displayName: probe.displayName,
          eventTypes: probe.eventTypes,
        })),
        providers: [],
        // Mirrors the real collector: the handshake carries where the capture is going, which
        // is what the rail and the call-site view read while the session is still running.
        deepCapture: capturePath ? { path: capturePath, maxBytes: 256 * 1024 * 1024 } : null,
      }),
    ],
  });

  const elapsed = () => (Date.now() - started.getTime()) / 1000;
  const counter = { messages: 1, counters: 0, allocationSamples: 0, gcEvents: 0 };

  timer = setInterval(() => {
    const messages = tick(elapsed());
    for (const message of messages) {
      counter.messages += 1;
      if (message.type === 'counter.sample') counter.counters += 1;
      if (message.type === 'allocation.sample') counter.allocationSamples += 1;
      if (message.type === 'gc.event') counter.gcEvents += 1;
    }

    handlers?.messages({ sessionId: SESSION_ID, messages });
    handlers?.status({
      sessionId: SESSION_ID,
      pid: MOCK_TARGET_PID,
      state: 'running',
      detail: null,
      stats: {
        ...counter,
        dropped: 0,
        uptimeMs: Date.now() - started.getTime(),
        messageCounts: {},
      },
    });
  }, 1000);

  return {
    sessionId: SESSION_ID,
    pid: MOCK_TARGET_PID,
    state: 'running',
    stats: emptyStats(),
  };
}

export function stopMockStream() {
  if (timer) clearInterval(timer);
  timer = null;

  // A deep capture answers only once the stream has ended, so the mock does the same thing the
  // real collector does: the analysis lands after the session stops, never during it.
  const capture = mockCapture;
  mockCapture = null;
  if (capture) {
    const bytes = 28_640_512;
    handlers?.messages({
      sessionId: SESSION_ID,
      messages: [
        envelope('target.exited', null, {
          pid: MOCK_TARGET_PID,
          eventsProcessed: 190_412,
          flushOverruns: 0,
          capture: { path: capture.path, bytes, truncated: false },
        }),
        envelope('allocation.site', 'allocation-sites', buildMockCallSites(bytes, Date.now() - capture.startedAt)),
      ],
    });
  }

  handlers?.status({
    sessionId: SESSION_ID,
    pid: MOCK_TARGET_PID,
    state: 'stopped',
    detail: 'The mock session was detached.',
    stats: emptyStats(),
  });
}

const MOCK_TARGET_PID = 4242;

/**
 * Where each method in the mock's story lives.
 *
 * Mapped by method because that is exactly what a PDB does: the runtime's stack names the method,
 * and the symbol file turns its IL offset into a file and line. Everything missing from this map
 * plays the part of a module whose PDB was not readable — the framework's own assemblies, in the
 * same way a real capture reports them.
 */
const MOCK_SOURCES: Record<string, { file: string; line: number }> = {
  'OrderService.Messaging.PayloadWriter.Serialize(Order)': {
    file: '/srv/orderservice/src/OrderService/Messaging/PayloadWriter.cs',
    line: 118,
  },
  'OrderService.Messaging.OutboxDispatcher.Drain()': {
    file: '/srv/orderservice/src/OrderService/Messaging/OutboxDispatcher.cs',
    line: 203,
  },
  'OrderService.Storage.OrderRepository.Append(Order)': {
    file: '/srv/orderservice/src/OrderService/Storage/OrderRepository.cs',
    line: 412,
  },
  'OrderService.Pipeline.OrderHandled(Order)': {
    file: '/srv/orderservice/src/OrderService/Pipeline/OrderPipeline.cs',
    line: 87,
  },
  'OrderService.Logging.OrderLogBuffer.Append(Order)': {
    file: '/srv/orderservice/src/OrderService/Logging/OrderLogBuffer.cs',
    line: 77,
  },
  'OrderService.Caching.PriceCache.GetOrAdd(System.Guid,System.Func`2[System.Guid,OrderService.Pricing.Price])': {
    file: '/srv/orderservice/src/OrderService/Caching/PriceCache.cs',
    line: 64,
  },
  'OrderService.Pricing.PriceCalculator.Total(Order)': {
    file: '/srv/orderservice/src/OrderService/Pricing/PriceCalculator.cs',
    line: 51,
  },
};

/**
 * A synthetic call-site analysis.
 *
 * The story it tells is the reason the feature exists: the biggest contributors are framework
 * types (`byte[]`, `string`), which no type leaderboard can place in the user's code, and each
 * one is attributed to the statement that allocates it — with a runtime frame chain beneath, and
 * one framework site deliberately left without a line to show the method-name fallback.
 */
function buildMockCallSites(captureBytes: number, durationMs: number): AllocationSiteData {
  const runtimeChain = [
    'System.Threading.ExecutionContext.RunInternal(System.Threading.ExecutionContext,System.Threading.ContextCallback,System.Object)',
    'System.Runtime.CompilerServices.AsyncTaskMethodBuilder`1+AsyncStateMachineBox`1[System.Threading.Tasks.VoidTaskResult,System.__Canon].MoveNext()',
    'System.Threading.Tasks.Task.RunContinuations(System.Object)',
  ];

  const raw: {
    site: string;
    frames: string[];
    userCode: boolean;
    types: { typeName: string; sampledBytes: number; samples: number }[];
  }[] = [
    {
      site: 'OrderService.Messaging.PayloadWriter.Serialize(Order)',
      frames: ['OrderService.Messaging.PayloadWriter.Serialize(Order)', 'OrderService.Messaging.OutboxDispatcher.Drain()', ...runtimeChain],
      userCode: true,
      types: [
        { typeName: 'System.Byte[]', sampledBytes: 986_431_488, samples: 7_428 },
        { typeName: 'System.Object[]', sampledBytes: 41_238_528, samples: 1_204 },
      ],
    },
    {
      site: 'OrderService.Storage.OrderRepository.Append(Order)',
      frames: ['OrderService.Storage.OrderRepository.Append(Order)', 'OrderService.Pipeline.OrderHandled(Order)', ...runtimeChain],
      userCode: true,
      types: [
        { typeName: 'OrderService.Storage.SessionRecord', sampledBytes: 452_984_832, samples: 21_566 },
        { typeName: 'System.Collections.Generic.Dictionary`2+Entry[System.Guid,OrderService.Storage.SessionRecord][]', sampledBytes: 118_489_088, samples: 942 },
      ],
    },
    {
      site: 'OrderService.Logging.OrderLogBuffer.Append(Order)',
      frames: ['OrderService.Logging.OrderLogBuffer.Append(Order)', 'OrderService.Pipeline.OrderHandled(Order)', ...runtimeChain],
      userCode: true,
      types: [
        { typeName: 'System.String', sampledBytes: 388_241_408, samples: 48_219 },
        { typeName: 'System.Char[]', sampledBytes: 74_317_824, samples: 12_884 },
      ],
    },
    {
      site: 'OrderService.Caching.PriceCache.GetOrAdd(System.Guid,System.Func`2[System.Guid,OrderService.Pricing.Price])',
      frames: ['OrderService.Caching.PriceCache.GetOrAdd(System.Guid,System.Func`2[System.Guid,OrderService.Pricing.Price])', 'OrderService.Pricing.PriceCalculator.Total(Order)', ...runtimeChain],
      userCode: true,
      types: [
        { typeName: 'System.Collections.Generic.Dictionary`2+Entry[System.Guid,OrderService.Pricing.Price][]', sampledBytes: 142_606_336, samples: 1_886 },
        { typeName: 'System.Guid[]', sampledBytes: 22_020_096, samples: 462 },
      ],
    },
    {
      site: 'System.Text.StringBuilder.AppendFormat(System.String,System.Object[])',
      frames: ['System.Text.StringBuilder.AppendFormat(System.String,System.Object[])', 'System.Text.StringBuilder.AppendFormat(System.String,System.Object)', 'OrderService.Logging.OrderLogBuffer.Append(Order)', ...runtimeChain],
      userCode: false,
      types: [{ typeName: 'System.Char[]', sampledBytes: 31_457_280, samples: 6_302 }],
    },
  ];

  const totalSampledBytes = raw.reduce(
    (sum, entry) => sum + entry.types.reduce((inner, type) => inner + type.sampledBytes, 0),
    0,
  );

  const sites: AllocationSite[] = raw.map((entry) => {
    const sampledBytes = entry.types.reduce((sum, type) => sum + type.sampledBytes, 0);
    const samples = entry.types.reduce((sum, type) => sum + type.samples, 0);
    const types = [...entry.types]
      .sort((a, b) => b.sampledBytes - a.sampledBytes)
      .map((type) => ({
        typeName: type.typeName,
        sampledBytes: type.sampledBytes,
        share: type.sampledBytes / Math.max(1, sampledBytes),
      }));
    // Spread rather than null: the protocol omits null properties, so a frame or a site with no
    // PDB arrives *without* these keys. The mock keeps that shape so the view exercises the same
    // code path against the mock as against a real capture.
    const frames: AllocationFrame[] = entry.frames.map((method) => {
      const source = MOCK_SOURCES[method];
      return { method, ...(source ? { sourceFile: source.file, sourceLine: source.line } : {}) };
    });
    const own = MOCK_SOURCES[entry.site];

    return {
      site: entry.site,
      ...(own ? { sourceFile: own.file, sourceLine: own.line } : {}),
      frames,
      userCode: entry.userCode,
      frameworkOnly: !entry.userCode,
      sampledBytes,
      samples,
      share: sampledBytes / Math.max(1, totalSampledBytes),
      averageObjectBytes: sampledBytes / Math.max(1, samples),
      dominantTypeName: types[0]?.typeName ?? null,
      types,
    };
  });

  // Folded from the raw entries rather than from the sites, so a type's sample count is the
  // sum over every site that produced it — which is what the collector reports.
  const typeTotals = new Map<string, { sampledBytes: number; samples: number; sites: Map<string, number> }>();
  for (const entry of raw) {
    for (const type of entry.types) {
      const totals = typeTotals.get(type.typeName) ?? { sampledBytes: 0, samples: 0, sites: new Map<string, number>() };
      totals.sampledBytes += type.sampledBytes;
      totals.samples += type.samples;
      totals.sites.set(entry.site, (totals.sites.get(entry.site) ?? 0) + type.sampledBytes);
      typeTotals.set(type.typeName, totals);
    }
  }

  const types: AllocationSiteType[] = [...typeTotals.entries()]
    .map(([typeName, totals]) => {
      const breakdown = [...totals.sites.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([site, sampledBytes]) => {
          const source = MOCK_SOURCES[site];
          return {
            site,
            ...(source ? { sourceFile: source.file, sourceLine: source.line } : {}),
            sampledBytes,
            share: sampledBytes / Math.max(1, totals.sampledBytes),
          };
        });

      return {
        typeName,
        sampledBytes: totals.sampledBytes,
        samples: totals.samples,
        share: totals.sampledBytes / Math.max(1, totalSampledBytes),
        dominantSite: breakdown[0]?.site ?? null,
        dominantSourceFile: breakdown[0]?.sourceFile ?? null,
        dominantSourceLine: breakdown[0]?.sourceLine ?? null,
        sites: breakdown,
      };
    })
    .sort((a, b) => b.sampledBytes - a.sampledBytes);

  return {
    captureFile: 'capture-4242.nettrace',
    captureBytes,
    eventsScanned: 1_284_912,
    sampledEvents: 1_284_912,
    totalSampledBytes,
    totalSamples: 98_893,
    largeObjectSamples: 9_846,
    distinctSites: sites.length,
    distinctTypes: types.length,
    droppedSites: 0,
    droppedTypes: 0,
    unresolvedFrames: 0,
    frameworkOnlySites: 1,
    sitesWithSource: sites.filter((site) => Boolean(site.sourceFile)).length,
    sitesWithoutSource: sites.filter((site) => !site.sourceFile).length,
    modulesWithoutSource: ['System.Private.CoreLib.dll'],
    symbolPath: null,
    symbolMs: 38,
    windowStartUnixMs: Date.now() - durationMs,
    windowEndUnixMs: Date.now(),
    durationMs,
    conversionMs: 604,
    analysisMs: 1_142,
    sampling:
      'Sampled allocation volumes, not exact accounting: the runtime reports a sample rather than every allocation. Shares between sites are unbiased.',
    sites,
    types,
  };
}

function emptyStats(): SessionSnapshot['stats'] {
  return {
    messages: 0,
    dropped: 0,
    counters: 0,
    allocationSamples: 0,
    gcEvents: 0,
    uptimeMs: 0,
    messageCounts: {},
  };
}

// ---------------------------------------------------------------------------------------
// Recording and replay
// ---------------------------------------------------------------------------------------

const RECORDINGS_DIR = '/mock/Library/Application Support/MemorySpy/recordings';

function syntheticRecording(
  fileName: string,
  targetName: string,
  pid: number,
  durationSeconds: number,
  startedAtUnixMs: number,
  complete: boolean,
): RecordingSummary {
  const samples = Math.round(durationSeconds / 2);
  return {
    path: `${RECORDINGS_DIR}/${fileName}`,
    fileName,
    targetName,
    targetPid: pid,
    runtimeVersion: '10.0.9',
    startedAtUnixMs,
    lastEventUnixMs: startedAtUnixMs + durationSeconds * 1000,
    durationMs: durationSeconds * 1000,
    sizeBytes: Math.round(durationSeconds * 38 * 1024),
    lineCount: samples * 4 + 2,
    messageCount: samples * 4,
    logCount: complete ? 3 : 0,
    skippedLines: 0,
    endReason: complete ? 'detached' : null,
    complete,
    formatVersion: 1,
    startedMidSession: false,
    messageTypes: {
      'session.started': 1,
      'counter.sample': samples,
      'allocation.sample': samples,
      'heap.stats': samples,
      'gc.event': samples,
    },
    error: null,
  };
}

let mockRecordingSequence = 0;

/**
 * A synthetic heap walk of the same story the mock's allocation numbers tell: a session cache that
 * is only ever added to.
 *
 * The retention chain is the point of the payload, so it is a real chain rather than filler — a
 * static field on the service's cache type, the dictionary it holds, that dictionary's entry array,
 * and the record the chain was built for. The sizes descend the way a real walk reports them, which
 * is what makes the panel's question (“which of these do I cut?”) answerable from the mock.
 */
function buildMockSnapshot(): HeapSnapshotData {
  const MB = 1024 * 1024;

  return {
    snapshotId: 1,
    startedAtUnixMs: Date.now() - 3_400,
    durationMs: 3_412,
    pauseMs: 1_284,
    gcNumber: 41,
    incomplete: false,
    objectCount: 3_412_887,
    totalBytes: 812 * MB,
    reachableObjects: 3_412_140,
    heapBytesReportedByGc: 826 * MB,
    edgeCount: 4_120_338,
    rootCount: 214,
    staticRootCount: 402,
    typeCount: 187,
    unknownTypeObjects: 0,
    types: [
      { typeName: 'System.Byte[]', objectCount: 1_204_882, liveBytes: 322 * MB, share: 0.397, retainedBytes: 322 * MB },
      { typeName: 'OrderService.Storage.SessionRecord', objectCount: 1_204_879, liveBytes: 96 * MB, share: 0.118, retainedBytes: 618 * MB },
      { typeName: 'System.String', objectCount: 1_204_774, liveBytes: 88 * MB, share: 0.108, retainedBytes: 88 * MB },
      {
        typeName: 'System.Collections.Generic.Dictionary`2+Entry[System.Guid,OrderService.Storage.SessionRecord][]',
        objectCount: 1,
        liveBytes: 74 * MB,
        share: 0.091,
        retainedBytes: 700 * MB,
      },
      { typeName: 'System.Char[]', objectCount: 611_204, liveBytes: 31 * MB, share: 0.038, retainedBytes: 31 * MB },
      { typeName: 'System.Object[]', objectCount: 41_882, liveBytes: 9 * MB, share: 0.011, retainedBytes: 9 * MB },
    ],
    retention: [
      {
        typeName: 'OrderService.Storage.SessionRecord',
        rootLabel: 'static OrderService.Storage.SessionCache.Instances',
        depth: 4,
        truncated: false,
        frames: [
          {
            label: 'static OrderService.Storage.SessionCache.Instances',
            typeName: 'System.Collections.Generic.Dictionary`2[System.Guid,OrderService.Storage.SessionRecord]',
            size: 80,
            retainedBytes: 700 * MB,
          },
          {
            label: 'field #0',
            typeName: 'System.Collections.Generic.Dictionary`2+Entry[System.Guid,OrderService.Storage.SessionRecord][]',
            size: 74 * MB,
            retainedBytes: 700 * MB,
          },
          { label: 'field #3', typeName: 'OrderService.Storage.SessionRecord', size: 84, retainedBytes: 364 },
        ],
      },
      {
        typeName: 'System.Byte[]',
        rootLabel: 'static OrderService.Storage.SessionCache.Instances',
        depth: 5,
        truncated: false,
        frames: [
          {
            label: 'static OrderService.Storage.SessionCache.Instances',
            typeName: 'System.Collections.Generic.Dictionary`2[System.Guid,OrderService.Storage.SessionRecord]',
            size: 80,
            retainedBytes: 700 * MB,
          },
          {
            label: 'field #0',
            typeName: 'System.Collections.Generic.Dictionary`2+Entry[System.Guid,OrderService.Storage.SessionRecord][]',
            size: 74 * MB,
            retainedBytes: 700 * MB,
          },
          { label: 'field #3', typeName: 'OrderService.Storage.SessionRecord', size: 84, retainedBytes: 364 },
          { label: 'field #1', typeName: 'System.Byte[]', size: 280, retainedBytes: 280 },
        ],
      },
      {
        typeName: 'System.String',
        rootLabel: 'GC root (Handle)',
        depth: 6,
        truncated: false,
        frames: [
          { label: 'GC root (Handle)', typeName: 'System.Threading.TimerQueue', size: 80, retainedBytes: 700 * MB },
          { label: 'field #0', typeName: 'System.Threading.TimerQueueTimer', size: 96, retainedBytes: 700 * MB },
          { label: 'field #0', typeName: 'OrderService.Storage.SessionSweeper+<>c__DisplayClass2_0', size: 48, retainedBytes: 700 * MB },
          {
            label: 'field #0',
            typeName: 'System.Collections.Generic.Dictionary`2[System.Guid,OrderService.Storage.SessionRecord]',
            size: 80,
            retainedBytes: 700 * MB,
          },
          { label: 'field #0', typeName: 'System.String', size: 62, retainedBytes: 62 },
        ],
      },
    ],
    inventory: [
      'GC/BulkNode x1871',
      'GC/BulkEdge x402',
      'Type/BulkType x9',
      'GC/Start x4',
      'GC/Stop x4',
      'GC/HeapStats x4',
      'GC/BulkRootStaticVar x1',
      'GC/BulkRootEdge x1',
    ],
    edgeAlignmentNote: null,
    coverageNote: null,
    note:
      'Exact live objects at the snapshot collection, not a sampled estimate. Live bytes is what a type\u2019s ' +
      'objects occupy; freed-if-removed is the different question — the live bytes that would no longer be ' +
      'reachable if every object of that type went away — which is why a small type can free far more than it ' +
      'occupies.',
  };
}

/** Begins a synthetic recording, exactly as `start_recording` would. */
function openMockRecording(targetName: string): RecordingSummary {
  const recording = syntheticRecording(
    `memoryspy-${targetName}-${MOCK_TARGET_PID}-mock-${++mockRecordingSequence}.jsonl`,
    targetName,
    MOCK_TARGET_PID,
    0,
    Date.now(),
    false,
  );
  mockRecordings = [recording, ...mockRecordings];
  return recording;
}

let mockRecordings: RecordingSummary[] = [
  syntheticRecording(
    'memoryspy-OrderService.Api-4242-20261014-031502.jsonl',
    'OrderService.Api',
    4242,
    740,
    Date.now() - 1000 * 60 * 60 * 26,
    true,
  ),
  syntheticRecording(
    'memoryspy-LeakyCache-4477-20261013-221011.jsonl',
    'MemorySpy.Samples.LeakyCache',
    4477,
    47,
    Date.now() - 1000 * 60 * 60 * 4,
    false,
  ),
];

interface MockPlayback {
  id: string;
  recording: RecordingSummary;
  state: PlaybackState;
  speed: number;
  positionMs: number;
  generation: number;
  emitted: number;
  nextEmitMs: number;
  timer: ReturnType<typeof setInterval> | null;
}

let playback: MockPlayback | null = null;
let playbackSequence = 0;

function reportPlayback(): void {
  if (!playback) return;

  handlers?.playback({
    playbackId: playback.id,
    state: playback.state,
    speed: playback.speed,
    positionMs: playback.positionMs,
    durationMs: playback.recording.durationMs,
    generation: playback.generation,
    emitted: playback.emitted,
    error: null,
    recording: playback.recording,
  });
}

function stopMockPlayback(state: PlaybackState): void {
  if (!playback) return;
  if (playback.timer) clearInterval(playback.timer);
  playback.timer = null;
  playback.state = state;
  reportPlayback();
}

/**
 * Replays a synthetic session at the requested speed.
 *
 * The point is not fidelity — there is no file — but that the UI's replay path is exercised
 * for real: the same message envelopes arrive on the same channel, and the same playback
 * statuses drive the transport, so the controls can be reviewed without .NET installed.
 */
function beginMockPlayback(recording: RecordingSummary, speed: number): PlaybackStatusEvent {
  stopMockPlayback('stopped');

  playback = {
    id: `replay-${recording.fileName}-${++playbackSequence}`,
    recording,
    state: 'playing',
    speed,
    positionMs: 0,
    generation: 1,
    emitted: 0,
    nextEmitMs: 0,
    timer: null,
  };

  // 5 simulated seconds of recording time per interval, so the mock cannot flood the UI at
  // high speeds the way a real replay legitimately would.
  const stepMs = 200;
  playback.timer = setInterval(() => {
    const current = playback;
    if (!current || current.state !== 'playing') return;

    current.positionMs = Math.min(current.recording.durationMs, current.positionMs + stepMs * current.speed);

    let budget = 25;
    while (current.nextEmitMs <= current.positionMs && budget-- > 0) {
      // Timestamps are rewritten onto the recording's own timeline, exactly as a real replay
      // does: the charts must show when things happened, not when the replay reached them.
      const at = current.recording.startedAtUnixMs + current.nextEmitMs;
      const messages = tick(current.nextEmitMs / 1000).map((message) => ({ ...message, ts: at }));
      current.emitted += messages.length;
      handlers?.messages({ sessionId: current.id, messages });
      current.nextEmitMs += 1000;
    }

    reportPlayback();

    if (current.positionMs >= current.recording.durationMs) {
      stopMockPlayback('finished');
    }
  }, stepMs);

  reportPlayback();

  return {
    playbackId: playback.id,
    state: playback.state,
    speed: playback.speed,
    positionMs: 0,
    durationMs: recording.durationMs,
    generation: playback.generation,
    emitted: 0,
    error: null,
    recording,
  };
}

export const mockApi = {
  getEnvironment: async (): Promise<EnvironmentInfo> => ({
    collector: COLLECTOR,
    settings: SETTINGS,
    sessions: [],
    recordingsDir: RECORDINGS_DIR,
  }),
  refreshCollector: async () => COLLECTOR,
  listProcesses: async () => PROCESSES,
  getCapabilities: async () => CAPABILITIES,
  // The request is honoured where it is observable: a session that was asked to record gets
  // the same `recording` field back that the real host returns, so the rail and the library
  // behave identically against the mock.
  startSession: async (request: SessionRequest): Promise<SessionSnapshot> => {
    const snapshot = beginMockSession(
      request.deepCapture ? '/mock/recordings/capture-4242.nettrace' : null,
    );
    if (!request.record && !request.recordPath) return snapshot;
    return { ...snapshot, recording: openMockRecording(request.targetName ?? 'process') };
  },
  stopSession: async () => {
    stopMockStream();
  },
  stopAllSessions: async () => {
    stopMockStream();
  },
  /**
   * Honours the heap walk the way the collector does: it acknowledges the request at once and the
   * snapshot itself arrives later, because a real walk stops the target for a collection. The
   * delay is what makes the button's “walking” state visible in the mock.
   */
  sendSessionCommand: async (_sessionId: string, command: Record<string, unknown>) => {
    if (command?.cmd !== 'snapshot') return;

    handlers?.messages({
      sessionId: SESSION_ID,
      messages: [
        envelope('command.result', null, {
          cmd: 'snapshot',
          ok: true,
          detail: 'Heap snapshot started: the target will pause for one Gen 2 collection while it is walked.',
        }),
      ],
    });

    setTimeout(() => {
      handlers?.messages({
        sessionId: SESSION_ID,
        messages: [envelope('heap.snapshot', 'heap-snapshot', buildMockSnapshot())],
      });
    }, 2500);
  },
  listSessions: async (): Promise<SessionSnapshot[]> => [],
  pruneSessions: async () => 0,
  getSettings: async () => SETTINGS,
  saveSettings: async (settings: Settings) => settings,

  startRecording: async (
    _sessionId: string,
    _path: string | null,
    targetName: string | null,
    _targetRuntime: string | null,
  ) => openMockRecording(targetName ?? 'process'),
  stopRecording: async (): Promise<RecordingSummary | null> => {
    const first = mockRecordings[0];
    if (!first) return null;

    const finished: RecordingSummary = {
      ...first,
      endReason: 'detached',
      complete: true,
      durationMs: 12_000,
      sizeBytes: 196_608,
      messageCount: 48,
      lineCount: 50,
    };
    mockRecordings = [finished, ...mockRecordings.slice(1)];
    return finished;
  },
  listRecordings: async (): Promise<RecordingSummary[]> => mockRecordings,
  deleteRecording: async (path: string) => {
    mockRecordings = mockRecordings.filter((recording) => recording.path !== path);
  },
  startPlayback: async (path: string, speed?: number): Promise<PlaybackStatusEvent> => {
    const recording =
      mockRecordings.find((candidate) => candidate.path === path) ??
      syntheticRecording(path.split('/').pop() ?? 'recording.jsonl', 'Imported', 0, 120, Date.now() - 60_000, true);
    return beginMockPlayback(recording, speed ?? 1);
  },
  pausePlayback: async () => {
    if (playback && playback.state === 'playing') {
      playback.state = 'paused';
      reportPlayback();
    }
  },
  resumePlayback: async () => {
    if (playback && playback.state === 'paused') {
      playback.state = 'playing';
      reportPlayback();
    }
  },
  setPlaybackSpeed: async (_playbackId: string, speed: number) => {
    if (playback) {
      playback.speed = speed;
      reportPlayback();
    }
  },
  seekPlayback: async (_playbackId: string, positionMs: number) => {
    if (!playback) return;
    // Same contract as the real player: restart and forward to the target, which is why the
    // generation — and therefore the UI's buffers — starts over.
    playback.generation += 1;
    playback.positionMs = positionMs;
    playback.nextEmitMs = 0;
    playback.emitted = 0;
    reportPlayback();
  },
  stopPlayback: async () => stopMockPlayback('stopped'),
};
