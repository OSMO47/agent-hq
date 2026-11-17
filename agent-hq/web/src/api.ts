import { useCallback, useEffect, useRef, useState } from 'react';

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

// ---- one shared WebSocket, fan-out to subscribers ----
type Msg = { type: string; [k: string]: any };
const subs = new Set<(m: Msg) => void>();
let socket: WebSocket | null = null;
let connected = false;
const connSubs = new Set<(c: boolean) => void>();

function connect() {
  if (socket) return;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => { connected = true; connSubs.forEach((f) => f(true)); };
  socket.onmessage = (e) => { try { const m = JSON.parse(e.data); subs.forEach((f) => f(m)); } catch { /* ignore */ } };
  socket.onclose = () => { socket = null; connected = false; connSubs.forEach((f) => f(false)); setTimeout(connect, 1500); };
}

export function useLive(handler: (m: Msg) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => { connect(); const f = (m: Msg) => ref.current(m); subs.add(f); return () => { subs.delete(f); }; }, []);
}

export function useConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => { connect(); connSubs.add(setC); return () => { connSubs.delete(setC); }; }, []);
  return c;
}

/** GET a resource; refetch (debounced) when a live message of the given types arrives. */
export function useResource<T>(path: string | null, refetchOn: string[] = [], pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const load = useCallback(() => {
    if (!path) return;
    api<T>('GET', path).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [path]);
  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => { if (!pollMs) return; const t = setInterval(load, pollMs); return () => clearInterval(t); }, [load, pollMs]);
  useLive((m) => {
    if (!refetchOn.includes(m.type)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(load, 250);
  });
  return { data, error, reload: load };
}

export const MODELS = ['opus', 'sonnet', 'haiku'];
export const STATUSES = ['BACKLOG', 'PLANNED', 'ASSIGNED', 'RUNNING', 'REVIEW', 'DONE', 'BLOCKED', 'FAILED', 'CANCELLED'] as const;
/** Mirrors server/src/domain/tasks.ts (owner-initiated moves; RUNNING only via Run). */
export const NEXT: Record<string, string[]> = {
  BACKLOG: ['PLANNED', 'CANCELLED', 'BLOCKED'], PLANNED: ['BACKLOG', 'CANCELLED', 'BLOCKED'], ASSIGNED: ['PLANNED', 'CANCELLED', 'BLOCKED'],
  RUNNING: [], REVIEW: ['DONE', 'ASSIGNED', 'FAILED'], BLOCKED: ['BACKLOG', 'PLANNED', 'ASSIGNED', 'CANCELLED'],
  FAILED: ['ASSIGNED', 'CANCELLED'], DONE: [], CANCELLED: [],
};

export const ago = (iso?: string | null) => {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime()) / 1000;
  if (s < 60) return `${Math.max(0, Math.floor(s))}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
