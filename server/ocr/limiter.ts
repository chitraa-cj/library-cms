/**
 * Process-wide gate on concurrent OCR work. The engine is local, so the only
 * budget is CPU: at most `OCR_CONCURRENCY` page ranges are being rendered or
 * recognised at once, across every job and user. (The old per-minute and per-day
 * request windows existed to protect a Gemini API quota and are gone with it.)
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
