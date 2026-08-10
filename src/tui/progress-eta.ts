const MAX_SAMPLES = 8;

export type ProgressSample = { at: number; downloaded: number };

/** Keep samples that advance `downloaded`; drop older ones past the window. */
export function addAdvancingSample(
  samples: ProgressSample[],
  sample: ProgressSample,
): ProgressSample[] {
  const last = samples[samples.length - 1];
  if (last !== undefined && sample.downloaded <= last.downloaded) {
    return samples;
  }
  const next = [...samples, sample];
  if (next.length > MAX_SAMPLES) {
    return next.slice(-MAX_SAMPLES);
  }
  return next;
}

/**
 * Next ETA sample window for a progress event.
 * Resets when progress regresses or when leaving a completed state so
 * completion/idle time is not folded into the rate.
 */
export function nextProgressSamples(
  samples: ProgressSample[],
  prev: { downloaded: number; total: number },
  ev: { at: number; downloaded: number; total: number },
): ProgressSample[] {
  const wasDone = prev.total > 0 && prev.downloaded >= prev.total;
  const isDone = ev.total > 0 && ev.downloaded >= ev.total;
  if (ev.downloaded < prev.downloaded || (wasDone && !isDone)) {
    return [{ at: ev.at, downloaded: ev.downloaded }];
  }
  return addAdvancingSample(samples, {
    at: ev.at,
    downloaded: ev.downloaded,
  });
}

/** ETA from a sliding window of advancing progress samples. */
export function estimateEtaMs(
  samples: ReadonlyArray<ProgressSample>,
  total: number,
): number | null {
  if (samples.length < 2) return null;

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const timeDelta = last.at - first.at;
  if (timeDelta <= 0) return null;

  const rate = (last.downloaded - first.downloaded) / timeDelta;
  if (total <= last.downloaded) return 0;
  if (rate <= 0) return null;

  const remaining = total - last.downloaded;
  return Math.round(remaining / rate);
}
