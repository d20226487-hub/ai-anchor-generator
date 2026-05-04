"use client";

import * as React from "react";

/**
 * Two-tab guard for the job orchestrator.
 *
 * The job runs as a client-side loop on whichever tab is open. If the user opens the
 * same job in two tabs and both have status==running, both will hit actionGenerateBatch
 * for the same indices → doubled spend + duplicate anchors. There's no DB-side claim
 * (audit High #7) so we approximate with a localStorage heartbeat:
 *
 *   - Each tab gets a random tabId at mount.
 *   - The "running" tab writes {tabId, ts} every HEARTBEAT_MS.
 *   - All tabs poll the lock every POLL_MS.
 *   - A lock is "fresh" if its ts is within FRESH_MS.
 *   - If a tab sees a fresh lock with a different tabId, it considers another tab
 *     to be the active runner.
 *
 * This is approximate by design: localStorage is per-origin per-browser, so it does
 * not cover "two different browsers" or "private window". For a fully reliable claim
 * we'd need a DB-side lease (deferred).
 */

const HEARTBEAT_MS = 2000;
const POLL_MS = 2500;
const FRESH_MS = 6000; // ~3 missed heartbeats

function lockKey(jobId: string): string {
  return `anchor-gen:job-lock:${jobId}`;
}

interface LockPayload {
  tabId: string;
  ts: number;
}

function readLock(jobId: string): LockPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lockKey(jobId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LockPayload;
    if (typeof parsed?.tabId !== "string" || typeof parsed?.ts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLock(jobId: string, payload: LockPayload) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(lockKey(jobId), JSON.stringify(payload)); } catch { /* quota / disabled */ }
}

function clearLock(jobId: string, ourTabId: string) {
  if (typeof window === "undefined") return;
  try {
    const cur = readLock(jobId);
    // Only clear if WE own it — never stomp another tab's lock on unmount.
    if (cur?.tabId === ourTabId) window.localStorage.removeItem(lockKey(jobId));
  } catch { /* noop */ }
}

export interface JobTabLock {
  /** True iff a different tab's heartbeat is fresh right now. */
  otherTabActive: boolean;
  /** Heartbeat tabId of the other tab, if any (for display). */
  otherTabId: string | null;
  /**
   * Take over the lock from the other tab. Use sparingly — only when the user has
   * confirmed the other tab is stuck or closed.
   */
  takeOver: () => void;
}

/**
 * @param jobId    The job being viewed
 * @param iAmRunning  True only if THIS tab is actively orchestrating (status === "running").
 *                    When true, this tab heartbeats. When false, this tab only polls.
 */
export function useJobTabLock(jobId: string, iAmRunning: boolean): JobTabLock {
  // Stable per tab. Using useRef ensures it survives re-renders but not full reloads.
  const tabIdRef = React.useRef<string>("");
  if (!tabIdRef.current) {
    tabIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
  }

  const [other, setOther] = React.useState<{ id: string } | null>(null);
  const takeOverRef = React.useRef(false);

  // Heartbeat — only when we're the runner.
  React.useEffect(() => {
    if (!iAmRunning) return;
    const beat = () => writeLock(jobId, { tabId: tabIdRef.current, ts: Date.now() });
    beat(); // immediate
    const id = window.setInterval(beat, HEARTBEAT_MS);
    return () => {
      window.clearInterval(id);
      clearLock(jobId, tabIdRef.current);
    };
  }, [jobId, iAmRunning]);

  // Poll — always while the component is mounted.
  React.useEffect(() => {
    const check = () => {
      const lock = readLock(jobId);
      if (!lock) { setOther(null); return; }
      if (lock.tabId === tabIdRef.current) { setOther(null); return; }
      const fresh = Date.now() - lock.ts < FRESH_MS;
      if (!fresh || takeOverRef.current) { setOther(null); return; }
      setOther({ id: lock.tabId });
    };
    check();
    const id = window.setInterval(check, POLL_MS);
    const onStorage = (e: StorageEvent) => { if (e.key === lockKey(jobId)) check(); };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("storage", onStorage);
    };
  }, [jobId]);

  const takeOver = React.useCallback(() => {
    takeOverRef.current = true;
    writeLock(jobId, { tabId: tabIdRef.current, ts: Date.now() });
    setOther(null);
  }, [jobId]);

  return {
    otherTabActive: other !== null,
    otherTabId: other?.id ?? null,
    takeOver,
  };
}
