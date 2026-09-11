import { runContinuousPool } from "../extension/sync-core.js";

const NOTE_WORKERS = 8;
const MEDIA_CONCURRENCY = 12;
const OLD_NOTE_CONCURRENCY = 2;

const scenarios = [
  { name: "30 notes / 10 images", counts: Array(30).fill(10) },
  { name: "30 notes / 20-30 images", counts: Array.from({ length: 30 }, (_, index) => 20 + (index % 11)) },
  { name: "mixed images and video", counts: Array.from({ length: 30 }, (_, index) => index % 5 === 0 ? 3 : index % 3 === 0 ? 24 : 10), videos: true },
];

const report = scenarios.map((scenario, scenarioIndex) => {
  const notes = fixture(scenario.counts, scenarioIndex, scenario.videos);
  const oldResult = simulateBatchSerial(notes, OLD_NOTE_CONCURRENCY);
  const newResult = simulateContinuous(notes, NOTE_WORKERS, MEDIA_CONCURRENCY);
  return {
    scenario: scenario.name,
    notes: notes.length,
    media: notes.reduce((total, note) => total + note.media.length, 0),
    old: summarize(oldResult),
    continuous: summarize(newResult),
    improvement: {
      totalTime: Number((oldResult.totalMs / newResult.totalMs).toFixed(2)),
      notesPerMinute: Number((newResult.notesPerMinute / oldResult.notesPerMinute).toFixed(2)),
      mediaPerMinute: Number((newResult.mediaPerMinute / oldResult.mediaPerMinute).toFixed(2)),
    },
  };
});

console.log(JSON.stringify({ benchmark: "extension-repair-scheduler-v1", noteWorkers: NOTE_WORKERS,
  mediaConcurrency: MEDIA_CONCURRENCY, oldNoteConcurrency: OLD_NOTE_CONCURRENCY, scenarios: report }, null, 2));

// Keep the benchmark coupled to the same continuous-claim primitive used by
// regression tests. This zero-delay probe fails if an item is dropped.
const probe = await runContinuousPool(Array.from({ length: 30 }, (_, index) => index), NOTE_WORKERS, async (item) => item);
if (probe.some((item) => item.status !== "fulfilled")) throw new Error("Continuous worker probe dropped a task.");

function fixture(counts, seed, videos = false) {
  return counts.map((count, noteIndex) => ({
    loadMs: 1_800 + ((noteIndex * 971 + seed * 389) % 7_000),
    extractionMs: 600 + ((noteIndex * 211) % 1_400),
    submitMs: 300 + ((noteIndex * 137) % 900),
    media: Array.from({ length: count }, (_, mediaIndex) => {
      const video = videos && mediaIndex === count - 1 && noteIndex % 5 === 0;
      return (video ? 8_000 : 700) + ((noteIndex * 313 + mediaIndex * 173 + seed * 97) % (video ? 10_000 : 2_000));
    }),
  }));
}

function simulateBatchSerial(notes, concurrency) {
  let clock = 0;
  let busyMs = 0;
  const mediaBusyMs = notes.flatMap((note) => note.media).reduce((sum, duration) => sum + duration, 0);
  const durations = [];
  for (let offset = 0; offset < notes.length; offset += concurrency) {
    const batch = notes.slice(offset, offset + concurrency).map(noteDurationSerial);
    durations.push(...batch);
    busyMs += batch.reduce((sum, duration) => sum + duration, 0);
    clock += Math.max(...batch);
  }
  return result(notes, clock, durations, busyMs / (clock * concurrency), mediaBusyMs / (clock * concurrency), {
    workerLimit: concurrency, peakMediaPipelines: concurrency, approximatePeakMemoryMb: concurrency * 4,
  });
}

function simulateContinuous(notes, workerCount, mediaLimit) {
  const events = [];
  const mediaQueue = [];
  const workerStartedAt = Array(workerCount).fill(null);
  const noteStartedAt = new Map();
  const noteDurations = [];
  let nextNote = 0;
  let activeMedia = 0;
  let mediaBusyMs = 0;
  let noteBusyMs = 0;
  let clock = 0;

  const schedule = (event) => events.push(event);
  const startNote = (worker, at) => {
    if (nextNote >= notes.length) return;
    const noteIndex = nextNote++;
    const note = notes[noteIndex];
    workerStartedAt[worker] = at;
    noteStartedAt.set(noteIndex, at);
    schedule({ at: at + note.loadMs + note.extractionMs, type: "note_ready", worker, noteIndex });
  };
  const dispatchMedia = (at) => {
    while (activeMedia < mediaLimit && mediaQueue.length) {
      const task = mediaQueue.shift();
      activeMedia += 1;
      mediaBusyMs += task.duration;
      schedule({ at: at + task.duration, type: "media_done", ...task });
    }
  };
  for (let worker = 0; worker < workerCount; worker += 1) startNote(worker, 0);

  while (events.length) {
    events.sort((left, right) => left.at - right.at || eventOrder(left.type) - eventOrder(right.type));
    const event = events.shift();
    clock = event.at;
    const note = notes[event.noteIndex];
    if (event.type === "note_ready") {
      note.remaining = note.media.length;
      if (!note.remaining) schedule({ at: clock + note.submitMs, type: "note_done", worker: event.worker, noteIndex: event.noteIndex });
      else for (const duration of note.media) mediaQueue.push({ duration, worker: event.worker, noteIndex: event.noteIndex });
      dispatchMedia(clock);
    } else if (event.type === "media_done") {
      activeMedia -= 1;
      note.remaining -= 1;
      if (!note.remaining) schedule({ at: clock + note.submitMs, type: "note_done", worker: event.worker, noteIndex: event.noteIndex });
      dispatchMedia(clock);
    } else {
      const startedAt = noteStartedAt.get(event.noteIndex);
      noteDurations.push(clock - startedAt);
      noteBusyMs += clock - workerStartedAt[event.worker];
      startNote(event.worker, clock);
    }
  }
  return result(notes, clock, noteDurations, noteBusyMs / (clock * workerCount), mediaBusyMs / (clock * mediaLimit), {
    workerLimit: workerCount, peakMediaPipelines: mediaLimit, approximatePeakMemoryMb: mediaLimit * 4,
  });
}

function result(notes, totalMs, noteDurations, workerUtilization, mediaUtilization, capacity) {
  const media = notes.reduce((total, note) => total + note.media.length, 0);
  const mediaDurations = notes.flatMap((note) => note.media);
  return {
    totalMs,
    notesPerMinute: notes.length * 60_000 / totalMs,
    mediaPerMinute: media * 60_000 / totalMs,
    workerUtilization,
    mediaUtilization,
    averageEffectiveConcurrency: workerUtilization * capacity.workerLimit,
    noteP50Ms: percentile(noteDurations, 0.5),
    noteP95Ms: percentile(noteDurations, 0.95),
    mediaP50Ms: percentile(mediaDurations, 0.5),
    mediaP95Ms: percentile(mediaDurations, 0.95),
    retryRate: 0,
    timeoutRate: 0,
    rateLimitOccurrence: 0,
    verificationOccurrence: 0,
    peakMediaPipelines: capacity.peakMediaPipelines,
    approximatePeakMemoryMb: capacity.approximatePeakMemoryMb,
  };
}

function summarize(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Number(item.toFixed(2))]));
}
function noteDurationSerial(note) { return note.loadMs + note.extractionMs + note.media.reduce((sum, item) => sum + item, 0) + note.submitMs; }
function percentile(values, quantile) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] || 0; }
function eventOrder(type) { return { media_done: 0, note_done: 1, note_ready: 2 }[type] ?? 3; }
