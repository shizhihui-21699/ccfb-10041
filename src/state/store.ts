/**
 * Application state and persistence.
 *
 * All state lives in this browser's IndexedDB (via a small localStorage
 * fallback) — nothing is uploaded. Protected document *text* is kept locally
 * so re-scans are fast; customer values are stored only as salted HMACs.
 */
import type {
  DetectionConfig,
  FeedbackRecord,
  ProtectedDocument,
  PiiVault,
  ScanResult,
  SuppressionState,
} from '../core/types';
import { DEFAULT_CONFIG } from '../core/types';
import { buildSuppression } from '../core/scan';

export interface AppState {
  version: 1;
  docs: ProtectedDocument[];
  vaults: PiiVault[];
  activeVaultId: string | null;
  scans: ScanResult[];
  feedback: FeedbackRecord[];
  config: DetectionConfig;
  /** Vault keys are intentionally NOT persisted; only their id + salt. */
}

const STORAGE_KEY = 'leak-console-v1';

export type Listener = (state: AppState) => void;

function emptyState(): AppState {
  return {
    version: 1,
    docs: [],
    vaults: [],
    activeVaultId: null,
    scans: [],
    feedback: [],
    config: { ...DEFAULT_CONFIG },
  };
}

/**
 * Scan results contain large token arrays. We keep them for the session only
 * and persist a compact summary so the history survives a reload.
 */
function compactForStorage(state: AppState): string {
  const scans = state.scans.slice(0, 40).map((s) => ({
    ...s,
    text: {
      raw: s.text.raw.slice(0, 20000),
      tokens: [],
      segments: [],
      tokenSegment: new Int32Array(0),
    },
  }));
  return JSON.stringify({ ...state, scans });
}

class Store {
  private state: AppState = emptyState();
  private listeners = new Set<Listener>();
  private saveTimer: number | null = null;

  constructor() {
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AppState;
      if (parsed.version !== 1) return;
      this.state = {
        ...emptyState(),
        ...parsed,
        config: { ...DEFAULT_CONFIG, ...parsed.config },
        scans: parsed.scans ?? [],
      };
    } catch {
      this.state = emptyState();
    }
  }

  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, compactForStorage(this.state));
      } catch (err) {
        console.warn('无法保存到本地存储（可能是容量限制）', err);
      }
    }, 400);
  }

  get(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l(this.state);
    this.scheduleSave();
  }

  update(fn: (state: AppState) => AppState | void) {
    const next = fn(this.state);
    if (next) this.state = next;
    this.emit();
  }

  setConfig(patch: Partial<DetectionConfig>) {
    this.update((s) => {
      s.config = { ...s.config, ...patch };
    });
  }

  addDocs(docs: ProtectedDocument[]) {
    this.update((s) => {
      const existing = new Set(s.docs.map((d) => d.id));
      s.docs = [...s.docs, ...docs.filter((d) => !existing.has(d.id))];
    });
  }

  removeDoc(id: string) {
    this.update((s) => {
      s.docs = s.docs.filter((d) => d.id !== id);
    });
  }

  addVault(vault: PiiVault) {
    this.update((s) => {
      s.vaults = [...s.vaults.filter((v) => v.id !== vault.id), vault];
      s.activeVaultId = vault.id;
    });
  }

  removeVault(id: string) {
    this.update((s) => {
      s.vaults = s.vaults.filter((v) => v.id !== id);
      if (s.activeVaultId === id) s.activeVaultId = s.vaults[0]?.id ?? null;
    });
  }

  addScan(scan: ScanResult) {
    this.update((s) => {
      s.scans = [scan, ...s.scans].slice(0, 40);
    });
  }

  removeScan(id: string) {
    this.update((s) => {
      s.scans = s.scans.filter((x) => x.id !== id);
    });
  }

  addFeedback(record: FeedbackRecord) {
    this.update((s) => {
      s.feedback = [record, ...s.feedback];
    });
  }

  removeFeedback(id: string) {
    this.update((s) => {
      s.feedback = s.feedback.filter((f) => f.id !== id);
    });
  }

  reset() {
    this.state = emptyState();
    this.emit();
  }

  suppression(): SuppressionState {
    return buildSuppression(this.state.feedback);
  }

  /** Feedback subset that the calibration panel treats as ground truth. */
  labeledFeedback(): FeedbackRecord[] {
    return this.state.feedback;
  }
}

export const store = new Store();

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
