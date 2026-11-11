//! Measures the host's per-message pipeline: the parse/serialize round trip every collector
//! envelope used to take, against the raw-line path it takes now.
//!
//! Run with:
//!
//! ```sh
//! cargo run --release --example message_pipeline_bench
//! ```
//!
//! Each iteration does what the stdout pump does for one message: classify it, write its
//! recording line, count it by type, and fold it into the webview batch payload. `old` is the
//! pipeline as it was before the raw-line rework — kept here verbatim so the comparison stays
//! reproducible — and `new` calls the functions the host actually ships. Excluded from both
//! sides is the webview's own parse of the delivered batch, which is the same work either way.
//!
//! The `new` side clones each corpus line into its batch where the live pump merely moves the
//! line it already owns, so the reported gain is a lower bound.

use std::collections::HashMap;
use std::hint::black_box;
use std::io::{self, BufWriter, Write};
use std::time::{Duration, Instant};

use memoryspy_lib::collector::{message_type_of, messages_payload};
use memoryspy_lib::recording::recording_message_line;

const SESSION_ID: &str = "s-1b2f4c8e-0a1d-4f6b-9c3e-5d7a9e1c3b5d";
const BATCH: usize = 64;
const RUNS: usize = 5;

fn main() {
    let corpus = corpus();
    let bytes: usize = corpus.iter().map(String::len).sum();
    println!(
        "{} messages, {:.2} MB of envelope text per run, {} runs per pipeline (median shown)",
        corpus.len(),
        bytes as f64 / (1024.0 * 1024.0),
        RUNS
    );

    // One warm-up run each, so neither side pays page faults and lazy init alone.
    black_box(run_old(&corpus));
    black_box(run_new(&corpus));

    let old = median((0..RUNS).map(|_| run_old(&corpus)).collect());
    let new = median((0..RUNS).map(|_| run_new(&corpus)).collect());

    report("old (parse + re-serialize)", old, corpus.len(), bytes);
    report("new (raw line, one pass)", new, corpus.len(), bytes);
    println!(
        "\nspeedup: {:.2}x  (old {:.0} ns/message -> new {:.0} ns/message)",
        old.as_secs_f64() / new.as_secs_f64(),
        old.as_nanos() as f64 / corpus.len() as f64,
        new.as_nanos() as f64 / corpus.len() as f64,
    );
}

/// The pipeline as it was: every line is parsed into a document tree, re-printed to the
/// recording inside a wrapper object, and printed again into the webview batch.
fn run_old(corpus: &[String]) -> Duration {
    let started = Instant::now();
    let mut recorder = BufWriter::new(io::sink());
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut batch: Vec<serde_json::Value> = Vec::with_capacity(BATCH);
    let mut emitted = 0usize;

    for line in corpus {
        let value: serde_json::Value =
            serde_json::from_str(line).expect("the corpus is valid JSON");

        let mut record_line =
            serde_json::json!({ "kind": "message", "envelope": value }).to_string();
        record_line.push('\n');
        recorder.write_all(record_line.as_bytes()).unwrap();

        let message_type = value
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("unknown");
        *counts.entry(message_type.to_string()).or_insert(0) += 1;

        batch.push(value);
        if batch.len() >= BATCH {
            let payload = serde_json::json!({
                "sessionId": SESSION_ID,
                "messages": std::mem::take(&mut batch),
            });
            emitted += serde_json::to_string(&payload).unwrap().len();
        }
    }

    if !batch.is_empty() {
        let payload = serde_json::json!({ "sessionId": SESSION_ID, "messages": batch });
        emitted += serde_json::to_string(&payload).unwrap().len();
    }

    recorder.flush().unwrap();
    black_box((counts, emitted));
    started.elapsed()
}

/// The shipped pipeline: one skim for the type, the recording line spliced from the raw text,
/// and the batch payload spliced from the raw lines.
fn run_new(corpus: &[String]) -> Duration {
    let started = Instant::now();
    let mut recorder = BufWriter::new(io::sink());
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut batch: Vec<String> = Vec::with_capacity(BATCH);
    let mut emitted = 0usize;

    for line in corpus {
        let message_type = message_type_of(line).expect("the corpus is valid JSON");

        let record_line = recording_message_line(line);
        recorder.write_all(record_line.as_bytes()).unwrap();
        recorder.write_all(b"\n").unwrap();

        *counts.entry(message_type).or_insert(0) += 1;

        // The live pump owns its line and moves it in; this clone is bench scaffolding and
        // makes the reported gain a lower bound.
        batch.push(line.clone());
        if batch.len() >= BATCH {
            emitted += messages_payload(SESSION_ID, &batch).len();
            batch.clear();
        }
    }

    if !batch.is_empty() {
        emitted += messages_payload(SESSION_ID, &batch).len();
    }

    recorder.flush().unwrap();
    black_box((counts, emitted));
    started.elapsed()
}

fn median(mut runs: Vec<Duration>) -> Duration {
    runs.sort();
    runs[runs.len() / 2]
}

fn report(label: &str, took: Duration, messages: usize, bytes: usize) {
    println!(
        "{label:<28} {:>9.2} ms total  {:>7.0} ns/message  {:>8.1} MB/s",
        took.as_secs_f64() * 1000.0,
        took.as_nanos() as f64 / messages as f64,
        bytes as f64 / took.as_secs_f64() / (1024.0 * 1024.0),
    );
}

/// A corpus that looks like a real session: the envelope shapes the collector emits, in the
/// mix a busy service produces. Sizes matter — the pipeline's cost scales with message size,
/// so a corpus of tiny messages would understate the win of not re-serialising them.
fn corpus() -> Vec<String> {
    let mut lines = Vec::with_capacity(1200);

    let envelope = |seq: u64, kind: &str, probe: &str, data: serde_json::Value| {
        serde_json::json!({
            "v": 1,
            "seq": seq,
            "ts": 1_760_000_000_000u64 + seq * 250,
            "type": kind,
            "probe": probe,
            "data": data,
        })
        .to_string()
    };

    // Runtime counters: a few dozen readings every interval.
    for index in 0..300u64 {
        let counters: Vec<serde_json::Value> = (0..24)
            .map(|c| {
                serde_json::json!({
                    "name": format!("counter-{c}"),
                    "displayName": format!("Counter {c} of the runtime"),
                    "value": index as f64 * 1.5 + c as f64,
                    "unit": if c % 3 == 0 { "bytes" } else { "percent" },
                    "category": "Memory",
                    "description": "One runtime counter, with the metadata the panel shows.",
                })
            })
            .collect();
        lines.push(envelope(
            index,
            "counter.sample",
            "runtime-counters",
            serde_json::json!({ "counters": counters, "intervalMs": 1000 }),
        ));
    }

    // Allocation samples: the biggest messages on the wire — the type table per interval.
    for index in 0..300u64 {
        let types: Vec<serde_json::Value> = (0..50)
            .map(|t| {
                serde_json::json!({
                    "typeName": format!("System.Collections.Generic.Dictionary`2[System.Guid, Namespace.Service.Record{t}]"),
                    "intervalBytes": 12_345 + t * 977,
                    "intervalBytesPerSecond": 4_000.0 + t as f64 * 31.5,
                    "totalBytes": 9_876_543 + t * 100_000,
                    "tickCount": 40 + t,
                    "sizedSampleCount": 12 + t,
                    "averageObjectBytes": 280.5 + t as f64 * 3.25,
                    "largestObjectBytes": 65_536 + t * 128,
                    "firstSeenUnixMs": 1_760_000_000_000u64,
                    "lastSeenUnixMs": 1_760_000_060_000u64,
                })
            })
            .collect();
        lines.push(envelope(
            300 + index,
            "allocation.sample",
            "allocations",
            serde_json::json!({
                "intervalMs": 1000,
                "totalIntervalBytes": 2_345_678,
                "totalIntervalTicks": 23,
                "totalBytes": 456_789_012,
                "totalTicks": 4_321,
                "samplingBasis": "tick",
                "tickApproximateBytes": 102_400,
                "typeCount": 50,
                "types": types,
            }),
        ));
    }

    // GC events and heap snapshots: small and frequent, plus a couple of large-ish summaries.
    for index in 0..400u64 {
        lines.push(envelope(
            600 + index,
            "gc.event",
            "gc-stats",
            serde_json::json!({
                "generation": index % 3,
                "reason": "Alloc",
                "compacted": false,
                "concurrent": false,
                "pauseMs": 12.5 + (index % 17) as f64 * 0.25,
                "totalHeapSizeBytes": 987_654_321u64,
                "index": index,
            }),
        ));
    }

    for index in 0..150u64 {
        lines.push(envelope(
            1000 + index,
            "heap.stats",
            "runtime-counters",
            serde_json::json!({
                "totalHeapBytes": 1_234_567_890u64,
                "gen0Bytes": 34_567_890u64,
                "gen1Bytes": 45_678_901u64,
                "gen2Bytes": 789_012_345u64,
                "lohBytes": 345_678_901u64,
                "pohBytes": 12_345_678u64,
                "gcHandleCount": 4_321,
                "pinnedObjectCount": 87,
                "gen0Collections": 412,
                "gen1Collections": 87,
                "gen2Collections": 12,
                "fragmentationPercent": 3.5,
            }),
        ));
    }

    // Collector stderr lines: small, and there are never many.
    for index in 0..50u64 {
        lines.push(envelope(
            1150 + index,
            "log",
            "session",
            serde_json::json!({
                "level": "debug",
                "message": format!("event stream tick {index}: buffers drained, 3 providers active"),
            }),
        ));
    }

    lines
}
