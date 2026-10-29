/**
 * Process-wide gate on concurrent OCR work: one range at a time (`ocrConfig.concurrency`
 * is 1 — one browser session on one profile can only answer one request).
 */
import { Semaphore } from "../lib/semaphore";
import { ocrConfig } from "./config";

const lanes = new Semaphore(() => ocrConfig.concurrency);

export function acquireOcrSlot(signal?: AbortSignal): Promise<() => void> {
  return lanes.acquire(signal);
}

export function ocrUsageSnapshot() {
  return {
    inFlight: lanes.active,
    waiting: lanes.waiting,
    concurrency: lanes.limit,
  };
}
