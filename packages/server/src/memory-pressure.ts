// How much memory this machine and this service have left, so that background work can wait instead of pushing a
// small computer into the kernel's OOM killer. A 7.4 GiB laptop without swap once froze with 188 MB
// available while Bogen started Chromium for a background preview; the service's cgroup peaked at 1 GiB.
//
// Three readings, each optional: MemAvailable from /proc/meminfo, the time tasks stalled on memory from PSI
// (/proc/pressure/memory, `full avg10`), and the headroom of this process's cgroup (memory.max - memory.current).
// Whatever is missing is left out; no reading means "ok", so other systems behave as before.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MemoryLevel = 'ok' | 'low' | 'critical';

export interface MemoryReading {
  /** MemAvailable, bytes. */
  available?: number;
  /** PSI `full avg10`: percent of the last ten seconds in which every task waited for memory. */
  stallFull?: number;
  /** The cgroup's limit minus its use, bytes, when it has a limit. */
  cgroupHeadroom?: number;
}

export interface MemoryThresholds {
  lowAvailable: number;
  criticalAvailable: number;
  lowHeadroom: number;
  criticalHeadroom: number;
  lowStall: number;
  criticalStall: number;
}

const MB = 1024 * 1024;

/** Chromium for one render costs a few hundred MB; below these, background work waits and no new browser starts. */
export const DEFAULT_THRESHOLDS: MemoryThresholds = {
  lowAvailable: 1024 * MB,
  criticalAvailable: 512 * MB,
  lowHeadroom: 384 * MB,
  criticalHeadroom: 192 * MB,
  lowStall: 5,
  criticalStall: 15,
};

export interface MemorySources {
  meminfo?: string;
  pressure?: string;
  /** /proc/self/cgroup, to find this process's cgroup v2 path. */
  selfCgroup?: string;
  cgroupRoot?: string;
}

const SYSTEM: Required<MemorySources> = { meminfo: '/proc/meminfo', pressure: '/proc/pressure/memory', selfCgroup: '/proc/self/cgroup', cgroupRoot: '/sys/fs/cgroup' };

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Reads the three numbers from files; tests point it at their own. */
export function readMemory(sources: MemorySources = {}): MemoryReading {
  const s = { ...SYSTEM, ...sources };
  const out: MemoryReading = {};
  const meminfo = read(s.meminfo);
  const avail = meminfo && /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  if (avail) out.available = Number(avail[1]) * 1024;
  const psi = read(s.pressure);
  const full = psi && /^full\s+avg10=([\d.]+)/m.exec(psi);
  if (full) out.stallFull = Number(full[1]);
  const self = read(s.selfCgroup);
  const path = self && /^0::(\/.*)$/m.exec(self)?.[1];
  if (path) {
    const dir = join(s.cgroupRoot, path);
    const max = read(join(dir, 'memory.max'))?.trim();
    const current = Number(read(join(dir, 'memory.current'))?.trim());
    if (max && max !== 'max' && Number.isFinite(Number(max)) && Number.isFinite(current)) out.cgroupHeadroom = Number(max) - current;
  }
  return out;
}

export function levelOf(r: MemoryReading, t: MemoryThresholds = DEFAULT_THRESHOLDS): MemoryLevel {
  const below = (v: number | undefined, limit: number) => v !== undefined && v < limit;
  const above = (v: number | undefined, limit: number) => v !== undefined && v > limit;
  if (below(r.available, t.criticalAvailable) || below(r.cgroupHeadroom, t.criticalHeadroom) || above(r.stallFull, t.criticalStall)) return 'critical';
  if (below(r.available, t.lowAvailable) || below(r.cgroupHeadroom, t.lowHeadroom) || above(r.stallFull, t.lowStall)) return 'low';
  return 'ok';
}

export function describeMemory(r: MemoryReading): string {
  const parts: string[] = [];
  if (r.available !== undefined) parts.push(`${Math.round(r.available / MB)} MB available`);
  if (r.cgroupHeadroom !== undefined) parts.push(`${Math.round(r.cgroupHeadroom / MB)} MB left to this service`);
  if (r.stallFull !== undefined) parts.push(`memory stalls ${r.stallFull}%`);
  return parts.join(', ') || 'no memory reading';
}

/** A cached reading: the files are cheap, but a busy queue asks often. */
export class MemoryGauge {
  private last: { at: number; reading: MemoryReading } | null = null;

  constructor(private readonly source: () => MemoryReading = () => readMemory(), private readonly thresholds: MemoryThresholds = DEFAULT_THRESHOLDS, private readonly cacheMs = 1000) {}

  reading(): MemoryReading {
    const now = Date.now();
    if (!this.last || now - this.last.at > this.cacheMs) this.last = { at: now, reading: this.source() };
    return this.last.reading;
  }

  level(): MemoryLevel {
    return levelOf(this.reading(), this.thresholds);
  }

  describe(): string {
    return describeMemory(this.reading());
  }
}
