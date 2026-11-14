import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type {
  Alert,
  DetectionConfig,
  FeedbackRecord,
  ProtectedDocument,
  ScanResult,
} from '../core/types';
import { DEFAULT_CONFIG, PII_FIELD_LABELS, type PiiField } from '../core/types';
import { buildLibrary } from '../core/fingerprint';
import { parseFile, checkArchiveSize } from '../parsers';
import { runScan } from '../core/scan';
import { buildSuppression } from '../core/scan';
import { createVault, detectField, type RawCustomerRecord } from '../core/pii';
import { store, formatBytes, formatTime } from '../state/store';
import {
  buildDemoData,
  loadManifest,
  parseOutgoingSample,
  type DemoData,
} from '../demo/load-samples';
import { evaluateSample, aggregate, type EvalReport } from '../demo/evaluate';
import { prepareVault as prepareVaultKeyed } from '../core/pii';
import { uuid } from '../core/hash';
import './primitives';
import './text-highlight';
import './alert-detail';
import './calibration-panel';
import './demo-panel';
import './settings-panel';

type Tab = 'scan' | 'library' | 'vault' | 'calibration' | 'demo' | 'settings';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'scan', label: '外发检测', hint: '上传待检文件，查看命中段落与客户数据' },
  { id: 'library', label: '受保护文档', hint: '已建档文档与分段指纹' },
  { id: 'vault', label: '客户名单库', hint: '仅存加盐哈希的精确匹配库' },
  { id: 'calibration', label: '阈值与反馈', hint: '误报标记与阈值建议' },
  { id: 'demo', label: '示例与评测', hint: '内置样本集与自动化指标' },
];


@customElement('leak-console')
export class LeakConsole extends LitElement {
  @state() private tab: Tab = 'scan';
  @state() private docs: ProtectedDocument[] = [];
  @state() private scans: ScanResult[] = [];
  @state() private activeScanId: string | null = null;
  @state() private activeAlertId: string | null = null;
  @state() private config: DetectionConfig = { ...DEFAULT_CONFIG };
  @state() private busy = '';
  @state() private notice: { tone: 'ok' | 'warn' | 'danger' | 'info'; text: string } | null = null;
  @state() private vaultSummary: { id: string; name: string; records: number; values: number; fields: Record<string, number>; createdAt: number }[] = [];
  @state() private activeVaultId: string | null = null;
  @state() private feedback: FeedbackRecord[] = [];
  @state() private demo: DemoData | null = null;
  @state() private demoBusy = false;
  @state() private demoError = '';
  @state() private evalReport: EvalReport | null = null;
  @state() private evalRunning = false;
  @state() private dragOver = false;
  @state() private expandedDocId: string | null = null;
  @state() private vaultPassphrase = '';

  private unsub: (() => void) | null = null;
  /** Vault keys are held in memory only, never persisted. */
  private vaultKeys = new Map<string, Uint8Array>();

  connectedCallback(): void {
    super.connectedCallback();
    this.sync();
    this.unsub = store.subscribe(() => this.sync());
  }

  disconnectedCallback(): void {
    this.unsub?.();
    super.disconnectedCallback();
  }

  private sync() {
    const s = store.get();
    this.docs = s.docs;
    this.scans = s.scans;
    this.config = s.config;
    this.feedback = s.feedback;
    this.activeVaultId = s.activeVaultId;
    this.vaultSummary = s.vaults.map((v) => ({
      id: v.id,
      name: v.name,
      records: v.stats.records,
      values: v.stats.values,
      fields: v.stats.fields as Record<string, number>,
      createdAt: v.createdAt,
    }));
    if (this.activeScanId && !s.scans.some((x) => x.id === this.activeScanId)) {
      this.activeScanId = s.scans[0]?.id ?? null;
    }
    if (!this.activeScanId && s.scans.length > 0) this.activeScanId = s.scans[0].id;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      max-width: var(--content-max);
      margin: 0 auto;
      padding: 0 22px 28px;
    }

    header.top {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 18px 0 14px;
      flex-wrap: wrap;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      background: linear-gradient(145deg, var(--accent), #143d3a);
      display: grid;
      place-items: center;
      color: #f4faf8;
      font-family: var(--font-serif);
      font-size: 17px;
      font-weight: 700;
      box-shadow: var(--shadow-md);
      flex: none;
    }
    .titles h1 {
      font-size: 17px;
      letter-spacing: -0.015em;
    }
    .titles p {
      margin: 1px 0 0;
      font-size: 12px;
      color: var(--ink-faint);
      letter-spacing: 0.01em;
    }
    .spacer {
      flex: 1;
    }
    .local-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: var(--ok);
      background: var(--ok-soft);
      border: 1px solid color-mix(in oklab, var(--ok) 24%, transparent);
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 560;
    }
    .local-badge .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ok);
    }

    nav.tabs {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid var(--line);
      margin-bottom: 16px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    nav.tabs::-webkit-scrollbar {
      display: none;
    }
    .tab {
      appearance: none;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 9px 14px 10px;
      font-size: 13.5px;
      color: var(--ink-soft);
      cursor: pointer;
      white-space: nowrap;
      transition: color 120ms;
    }
    .tab:hover {
      color: var(--ink);
    }
    .tab[aria-selected='true'] {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 620;
    }
    .tab .count {
      font-size: 11px;
      color: var(--ink-faint);
      margin-left: 5px;
      font-variant-numeric: tabular-nums;
    }

    .notice {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      font-size: 12.5px;
      margin-bottom: 14px;
      line-height: 1.6;
    }
    .notice.ok {
      background: var(--ok-soft);
      color: #244a29;
      border: 1px solid color-mix(in oklab, var(--ok) 22%, transparent);
    }
    .notice.warn {
      background: var(--warn-soft);
      color: #6d4708;
      border: 1px solid color-mix(in oklab, var(--warn) 24%, transparent);
    }
    .notice.danger {
      background: var(--danger-soft);
      color: #7a2513;
      border: 1px solid color-mix(in oklab, var(--danger) 24%, transparent);
    }
    .notice.info {
      background: var(--accent-soft);
      color: #14413e;
      border: 1px solid color-mix(in oklab, var(--accent) 20%, transparent);
    }
    .notice button {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      color: inherit;
      opacity: 0.6;
      font-size: 15px;
      line-height: 1;
      padding: 2px 4px;
    }

    /* ---------- scan layout ---------- */
    .scan-grid {
      display: grid;
      grid-template-columns: 348px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .side {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .dropzone {
      border: 1.5px dashed var(--line-strong);
      border-radius: var(--radius);
      background: color-mix(in oklab, var(--bg-raised) 70%, var(--bg));
      padding: 22px 18px;
      text-align: center;
      cursor: pointer;
      transition: border-color 140ms, background 140ms;
    }
    .dropzone:hover,
    .dropzone.over {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .dropzone strong {
      display: block;
      font-size: 13.5px;
      margin-bottom: 4px;
    }
    .dropzone span {
      font-size: 11.5px;
      color: var(--ink-faint);
      line-height: 1.6;
    }
    .dropzone .formats {
      display: inline-flex;
      gap: 5px;
      margin-top: 9px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .fmt {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.04em;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--bg-sunken);
      color: var(--ink-soft);
      border: 1px solid var(--line);
    }

    .btn {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: var(--bg-raised);
      border-radius: var(--radius-sm);
      padding: 7px 13px;
      font-size: 12.5px;
      cursor: pointer;
      color: var(--ink);
      font-weight: 540;
      transition: background 120ms, border-color 120ms, transform 60ms;
      white-space: nowrap;
    }
    .btn:hover {
      background: var(--bg-sunken);
    }
    .btn:active {
      transform: translateY(1px);
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #f6fbfa;
    }
    .btn.primary:hover {
      background: #184c49;
    }
    .btn.danger {
      color: var(--danger);
      border-color: color-mix(in oklab, var(--danger) 40%, var(--line));
    }
    .btn.ghost {
      border-color: transparent;
      background: none;
      color: var(--ink-soft);
    }
    .btn.ghost:hover {
      background: var(--bg-sunken);
    }
    .btn.sm {
      padding: 4px 9px;
      font-size: 11.5px;
    }

    .scan-list {
      display: flex;
      flex-direction: column;
      max-height: 340px;
      overflow: auto;
    }
    .scan-item {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 9px 14px;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
      background: none;
      border-left: 3px solid transparent;
      border-right: none;
      border-top: none;
      text-align: left;
      width: 100%;
      font: inherit;
      color: inherit;
    }
    .scan-item:hover {
      background: var(--bg-sunken);
    }
    .scan-item[aria-current='true'] {
      background: var(--accent-soft);
      border-left-color: var(--accent);
    }
    .scan-item .name {
      font-size: 12.5px;
      font-weight: 560;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .scan-item .meta {
      font-size: 11px;
      color: var(--ink-faint);
      font-variant-numeric: tabular-nums;
      margin-top: 2px;
    }
    .scan-item .badge {
      margin-left: auto;
      flex: none;
      font-size: 11px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      padding: 2px 7px;
      border-radius: 999px;
    }
    .badge.danger {
      background: var(--danger-soft);
      color: var(--danger);
    }
    .badge.warn {
      background: var(--warn-soft);
      color: var(--warn);
    }
    .badge.ok {
      background: var(--ok-soft);
      color: var(--ok);
    }

    .main-col {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-width: 0;
    }
    .stats-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 12px 16px 8px;
    }
    .section-title h2 {
      font-size: 13.5px;
    }
    .section-title .hint {
      font-size: 11.5px;
      color: var(--ink-faint);
    }

    .file-meta {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      padding: 0 16px 12px;
      font-size: 11.5px;
      color: var(--ink-faint);
      font-variant-numeric: tabular-nums;
    }
    .file-meta b {
      color: var(--ink-soft);
      font-weight: 560;
    }

    .progress {
      height: 3px;
      background: var(--bg-sunken);
      overflow: hidden;
      border-radius: 2px;
      margin: 0 16px 10px;
    }
    .progress .bar {
      height: 100%;
      background: var(--accent);
      transition: width 160ms;
    }

    .fatal {
      padding: 14px 16px;
      color: var(--danger);
      font-size: 12.5px;
      line-height: 1.7;
    }

    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    @media (max-width: 1180px) {
      .scan-grid {
        grid-template-columns: 1fr;
      }
      .split {
        grid-template-columns: 1fr;
      }
    }

    .policy-note {
      font-size: 11.5px;
      color: var(--ink-faint);
      line-height: 1.65;
      padding: 0 16px 14px;
    }
    .kbd {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--bg-sunken);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 0 4px;
    }
    .spin {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid color-mix(in oklab, var(--accent) 30%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 700ms linear infinite;
      vertical-align: -1px;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    .tag {
      display: inline-block;
      font-size: 10.5px;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--bg-sunken);
      color: var(--ink-soft);
      border: 1px solid var(--line);
    }
    .tag.pii {
      background: var(--danger-soft);
      border-color: color-mix(in oklab, var(--danger) 20%, transparent);
      color: var(--danger);
    }
  `;

  // ---------------------------------------------------------------- actions
  private flash(tone: 'ok' | 'warn' | 'danger' | 'info', text: string) {
    this.notice = { tone, text };
    window.setTimeout(() => {
      if (this.notice?.text === text) this.notice = null;
    }, 6500);
  }

  private activeScan(): ScanResult | null {
    return this.scans.find((s) => s.id === this.activeScanId) ?? null;
  }

  private async onFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const errors: string[] = [];
    let scanned = 0;
    for (const file of list) {
      this.busy = `正在解析 ${file.name}`;
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        checkArchiveSize(data, file.name);
        const parsed = await parseFile({ fileName: file.name, data });
        const suppression = buildSuppression(this.feedback);
        const activeVault = this.activeVaultId ? store.get().vaults.find((v) => v.id === this.activeVaultId) : null;
        const key = this.activeVaultId ? this.vaultKeys.get(this.activeVaultId) : undefined;
        const vault = activeVault && key ? prepareVaultKeyed(activeVault, key) : null;
        const fileHashes = new Map(
          this.docs.filter((d) => !d.piiOnly).map((d) => [d.sha256, { docId: d.id, docTitle: d.title }]),
        );
        this.busy = `正在比对 ${file.name}`;
        // Yield so the busy label paints before the synchronous matcher runs.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const result = runScan({
          parsed,
          library: this.docs.some((d) => !d.piiOnly) ? buildLibrary(this.docs, this.config) : null,
          vault,
          config: this.config,
          suppression,
          protectedHashes: fileHashes,
        });
        store.addScan(result);
        this.activeScanId = result.id;
        this.activeAlertId = result.alerts[0]?.id ?? null;
        scanned++;
        if (result.warnings.length > 1) {
          this.flash('warn', `${file.name}：${result.warnings[0]}`);
        }
      } catch (err) {
        errors.push(`${file.name}：${(err as Error).message}`);
      }
    }
    this.busy = '';
    if (errors.length > 0) {
      this.flash('danger', errors.join('；'));
    } else if (scanned > 0) {
      const scan = this.activeScan();
      const n = scan?.alerts.length ?? 0;
      this.flash(
        n > 0 ? 'warn' : 'ok',
        n > 0 ? `完成 ${scanned} 个文件检测，发现 ${n} 条告警` : `完成 ${scanned} 个文件检测，未发现风险`,
      );
    }
  }

  private async onImportProtected(files: FileList | File[]) {
    const list = Array.from(files);
    const added: ProtectedDocument[] = [];
    const errors: string[] = [];
    for (const file of list) {
      this.busy = `正在建档 ${file.name}`;
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        checkArchiveSize(data, file.name);
        const parsed = await parseFile({ fileName: file.name, data });
        const { buildDocumentText } = await import('../core/normalize');
        const text = buildDocumentText(parsed.blocks);
        if (text.tokens.length === 0) throw new Error('未提取到可供指纹比对的文本');
        added.push({
          id: uuid(),
          title: file.name.replace(/\.[^.]+$/, ''),
          kind: parsed.kind,
          fileName: file.name,
          sha256: parsed.sha256,
          addedAt: Date.now(),
          text,
          segmentCount: text.segments.length,
          tokenCount: text.tokens.length,
          classification: '内部',
        });
      } catch (err) {
        errors.push(`${file.name}：${(err as Error).message}`);
      }
    }
    this.busy = '';
    if (added.length > 0) {
      store.addDocs(added);
      this.flash('ok', `已建档 ${added.length} 份文档（${added.reduce((n, d) => n + d.segmentCount, 0)} 个段落）`);
    }
    if (errors.length > 0) this.flash('danger', errors.join('；'));
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragOver = false;
    if (e.dataTransfer?.files) void this.onFiles(e.dataTransfer.files);
  }

  private openPicker(mode: 'scan' | 'library') {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.docx,.xlsx,.pdf,.txt,.md,.csv';
    input.onchange = () => {
      if (!input.files) return;
      if (mode === 'scan') void this.onFiles(input.files);
      else void this.onImportProtected(input.files);
    };
    input.click();
  }

  private async loadDemo(scanSamples = false) {
    this.demoBusy = true;
    this.demoError = '';
    try {
      const manifest = await loadManifest();
      this.busy = '正在加载示例文档并建立指纹库';
      const data = await buildDemoData(manifest, this.config);
      this.demo = data;
      store.addDocs(data.docs.filter((d) => !d.piiOnly));
      this.vaultKeys.set(data.vault.vault.id, data.vault.key);
      store.addVault(data.vault.vault);
      if (scanSamples) {
        this.busy = '正在扫描全部外发样本';
        for (const sample of manifest.outgoing) {
          const { parsed } = await parseOutgoingSample(manifest, sample.id);
          const suppression = buildSuppression(this.feedback);
          const result = runScan({
            parsed,
            library: data.library,
            vault: data.vault,
            config: this.config,
            suppression,
            protectedHashes: data.fileHashes,
          });
          store.addScan(result);
        }
        this.activeScanId = store.get().scans[0]?.id ?? null;
        this.flash('ok', `已载入 ${manifest.protected.length} 份受保护文档、${manifest.outgoing.length} 份外发样本`);
      } else {
        this.flash('ok', `已载入 ${manifest.protected.length} 份受保护文档，客户名单已转为加盐哈希`);
      }
    } catch (err) {
      this.demoError = (err as Error).message;
      this.flash('danger', this.demoError);
    } finally {
      this.busy = '';
      this.demoBusy = false;
    }
  }

  private async runDemoEval(): Promise<EvalReport | null> {
    if (!this.demo) return null;
    this.evalRunning = true;
    try {
      const manifest = this.demo.manifest;
      const env = {
        library: this.demo.library,
        vault: this.demo.vault,
        docs: this.demo.docs,
        vaultId: this.demo.vault.vault.id,
        fileHashes: this.demo.fileHashes,
      };
      const t0 = performance.now();
      const samples = [];
      for (const sample of manifest.outgoing) {
        const { parsed } = await parseOutgoingSample(manifest, sample.id);
        samples.push(evaluateSample(sample, parsed, env, this.config, this.feedback));
      }
      const report = aggregate(samples, performance.now() - t0);
      this.evalReport = report;
      return report;
    } finally {
      this.evalRunning = false;
    }
  }

  private markFeedback(alert: Alert, label: 'fp' | 'tp', suppressEvidence: boolean, suppressSegment: boolean, note?: string) {
    const record: FeedbackRecord = {
      id: uuid(),
      createdAt: Date.now(),
      detector: alert.detector,
      label,
      score: alert.score,
      alertTitle: alert.title,
      evidenceHash: alert.evidenceHash,
      docId: alert.docId,
      segmentIndex: alert.segmentIndex,
      note,
      suppressEvidence,
      suppressSegment,
    };
    store.addFeedback(record);
    this.flash(
      label === 'fp' ? 'info' : 'ok',
      label === 'fp'
        ? suppressEvidence
          ? '已标记为误报，并对相同证据启用抑制'
          : '已记录误报，可到「阈值与反馈」查看阈值建议'
        : '已确认为真实泄露，作为正样本参与阈值校准',
    );
  }

  private applyConfig(patch: Partial<DetectionConfig>) {
    store.setConfig(patch);
    this.flash('info', '阈值已更新，重新扫描后生效');
  }

  // ---------------------------------------------------------------- render
  render(): TemplateResult {
    return html`
      <header class="top">
        <div class="brand">
          <div class="mark">澄</div>
          <div class="titles">
            <h1>文档泄露检测台</h1>
            <p>分段指纹 · 精确数据匹配 · 本地浏览器内完成</p>
          </div>
        </div>
        <div class="spacer"></div>
        <span class="local-badge"><span class="dot"></span>本地运行，文件不出浏览器</span>
        <button
          class="btn ghost sm"
          title="查看数据存放位置与清空本地数据"
          @click=${() => (this.tab = 'settings')}
        >
          设置
        </button>
      </header>

      <nav class="tabs" role="tablist">
        ${TABS.map(
          (t) => html`
            <button
              class="tab"
              role="tab"
              aria-selected=${this.tab === t.id ? 'true' : 'false'}
              title=${t.hint}
              @click=${() => (this.tab = t.id)}
            >
              ${t.label}
              ${t.id === 'library' && this.docs.filter((d) => !d.piiOnly).length > 0
                ? html`<span class="count">${this.docs.filter((d) => !d.piiOnly).length}</span>`
                : nothing}
              ${t.id === 'scan' && this.scans.length > 0
                ? html`<span class="count">${this.scans.length}</span>`
                : nothing}
              ${t.id === 'vault' && this.vaultSummary.length > 0
                ? html`<span class="count">${this.vaultSummary.length}</span>`
                : nothing}
            </button>
          `,
        )}
      </nav>

      ${this.busy
        ? html`<div class="notice info"><span class="spin"></span>${this.busy}</div>`
        : nothing}
      ${this.notice
        ? html`<div class="notice ${this.notice.tone}">
            ${this.notice.text}
            <button @click=${() => (this.notice = null)} aria-label="关闭">×</button>
          </div>`
        : nothing}

      ${this.tab === 'scan' ? this.renderScan() : nothing}
      ${this.tab === 'library' ? this.renderLibrary() : nothing}
      ${this.tab === 'vault' ? this.renderVault() : nothing}
      ${this.tab === 'calibration'
        ? html`<calibration-panel
            .config=${this.config}
            .feedback=${this.feedback}
            .docs=${this.docs}
            @apply-config=${(e: CustomEvent) => this.applyConfig(e.detail)}
            @drop-feedback=${(e: CustomEvent) => {
              store.removeFeedback(e.detail as string);
            }}
            @reset-feedback=${() => {
              store.update((s) => {
                s.feedback = [];
              });
            }}
            @rescan=${() => void this.rescanAll()}
          ></calibration-panel>`
        : nothing}
      ${this.tab === 'demo'
        ? html`<demo-panel
            .manifest=${this.demo?.manifest ?? null}
            .report=${this.evalReport}
            .busy=${this.demoBusy}
            .evalRunning=${this.evalRunning}
            .error=${this.demoError}
            .scans=${this.scans}
            @load-demo=${(e: CustomEvent) => void this.loadDemo(Boolean(e.detail?.scan))}
            @run-eval=${() => void this.runDemoEval()}
            @open-sample=${(e: CustomEvent) =>
              void this.openDemoSample(e.detail as string)}
          ></demo-panel>`
        : nothing}
      ${this.tab === 'settings'
        ? html`<settings-panel
            .config=${this.config}
            .docCount=${this.docs.filter((d) => !d.piiOnly).length}
            .vaultCount=${this.vaultSummary.length}
            .scanCount=${this.scans.length}
            .feedbackCount=${this.feedback.length}
            @reset-all=${() => {
              store.reset();
              this.vaultKeys.clear();
              this.activeScanId = null;
              this.activeAlertId = null;
              this.evalReport = null;
              this.demo = null;
              this.tab = 'scan';
              this.flash('info', '已清空本地数据');
            }}
          ></settings-panel>`
        : nothing}
    `;
  }

  private async openDemoSample(id: string) {
    if (!this.demo) return;
    this.busy = `正在扫描样本 ${id}`;
    try {
      const { parsed } = await parseOutgoingSample(this.demo.manifest, id);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const result = runScan({
        parsed,
        library: this.demo.library,
        vault: this.demo.vault,
        config: this.config,
        suppression: buildSuppression(this.feedback),
        protectedHashes: this.demo.fileHashes,
      });
      store.addScan(result);
      this.activeScanId = result.id;
      this.activeAlertId = result.alerts[0]?.id ?? null;
      this.tab = 'scan';
    } catch (err) {
      this.flash('danger', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private async rescanAll() {
    const scans = this.scans;
    if (scans.length === 0) return;
    // Re-scanning from stored text is enough for segment matching; PII needs
    // the canonical stream which we rebuild from the same tokens.
    this.busy = '正在按新阈值重算';
    try {
      const library = this.docs.some((d) => !d.piiOnly) ? buildLibrary(this.docs, this.config) : null;
      const activeVault = this.activeVaultId ? store.get().vaults.find((v) => v.id === this.activeVaultId) : null;
      const key = this.activeVaultId ? this.vaultKeys.get(this.activeVaultId) : undefined;
      const vault = activeVault && key ? prepareVaultKeyed(activeVault, key) : null;
      const suppression = buildSuppression(this.feedback);
      const fileHashes = new Map(
        this.docs.filter((d) => !d.piiOnly).map((d) => [d.sha256, { docId: d.id, docTitle: d.title }]),
      );
      const updated: ScanResult[] = [];
      for (const scan of scans) {
        if (scan.text.tokens.length === 0) {
          updated.push(scan);
          continue;
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const result = runScan({
          parsed: {
            fileName: scan.fileName,
            kind: scan.fileKind,
            blocks: [],
            byteLength: scan.byteLength,
            sha256: scan.fileSha256,
            warnings: scan.warnings,
            notes: [],
          },
          library,
          vault,
          config: this.config,
          suppression,
          protectedHashes: fileHashes,
          existingText: scan.text,
        });
        updated.push({ ...result, id: scan.id, createdAt: scan.createdAt });
      }
      store.update((s) => {
        s.scans = updated;
      });
      if (updated[0]) this.activeScanId = updated[0].id;
      this.flash('ok', '已按当前阈值重算全部检测结果');
    } finally {
      this.busy = '';
    }
  }

  private renderScan(): TemplateResult {
    const scan = this.activeScan();
    const alerts = scan?.alerts ?? [];
    return html`
      <div class="scan-grid">
        <div class="side">
          <div
            class="dropzone ${this.dragOver ? 'over' : ''}"
            @click=${() => this.openPicker('scan')}
            @dragover=${(e: DragEvent) => {
              e.preventDefault();
              this.dragOver = true;
            }}
            @dragleave=${() => (this.dragOver = false)}
            @drop=${(e: DragEvent) => this.onDrop(e)}
          >
            <strong>拖入待检文件或点击上传</strong>
            <span>文件只在本机解析，不会上传到任何服务器</span>
            <div class="formats">
              <span class="fmt">DOCX</span><span class="fmt">XLSX</span>
              <span class="fmt">PDF</span><span class="fmt">TXT</span>
            </div>
          </div>

          <panel-card heading="检测记录" sub=${this.scans.length > 0 ? `${this.scans.length} 个文件` : ''}>
            ${this.scans.length === 0
              ? html`<empty-state
                  title="还没有检测记录"
                  body="上传一份文件开始检测。也可以到「示例与评测」载入内置样本集，快速了解判定效果。"
                ></empty-state>`
              : html`<div class="scan-list">
                  ${this.scans.map(
                    (s) => html`
                      <button
                        class="scan-item"
                        aria-current=${s.id === this.activeScanId ? 'true' : 'false'}
                        @click=${() => {
                          this.activeScanId = s.id;
                          this.activeAlertId = s.alerts[0]?.id ?? null;
                        }}
                      >
                        <div style="min-width:0;flex:1">
                          <div class="name">${s.fileName}</div>
                          <div class="meta">
                            ${formatTime(s.createdAt)} · ${formatBytes(s.byteLength)} · ${s.text.segments.length} 段
                          </div>
                        </div>
                        <span
                          class="badge ${s.alerts.some((a) => a.severity === 'critical')
                            ? 'danger'
                            : s.alerts.length > 0
                              ? 'warn'
                              : 'ok'}"
                        >
                          ${s.alerts.length > 0 ? `${s.alerts.length} 告警` : '无风险'}
                        </span>
                      </button>
                    `,
                  )}
                </div>`}
          </panel-card>
        </div>

        <div class="main-col">
          ${scan
            ? html`
                <div class="stats-row">
                  <stat-pill
                    label="告警总数"
                    value=${String(alerts.length)}
                    tone=${alerts.some((a) => a.severity === 'critical')
                      ? 'danger'
                      : alerts.length > 0
                        ? 'warn'
                        : 'ok'}
                    hint=${alerts.length > 0 ? '按严重程度排序' : '未发现相似内容'}
                  ></stat-pill>
                  <stat-pill
                    label="段落指纹命中"
                    value=${String(scan.segmentMatches.length)}
                    hint=${`${scan.text.segments.length} 个段落参与比对`}
                  ></stat-pill>
                  <stat-pill
                    label="客户数据命中"
                    value=${String(scan.piiMatches.length)}
                    tone=${scan.piiMatches.length > 0 ? 'danger' : 'ink'}
                    hint="加盐哈希精确匹配"
                  ></stat-pill>
                  <stat-pill
                    label="检测耗时"
                    value=${`${scan.stats.totalMs} ms`}
                    hint=${`解析 ${scan.stats.parseMs} · 匹配 ${scan.stats.matchMs} · 数据 ${scan.stats.piiMs}`}
                  ></stat-pill>
                </div>
                <div class="file-meta" style="padding:0 2px">
                  <span><b>${scan.fileName}</b></span>
                  <span>${formatBytes(scan.byteLength)}</span>
                  <span>${scan.text.segments.length} 段 · ${scan.text.tokens.length} 令牌</span>
                  ${scan.notes.length > 0
                    ? html`<span>${scan.notes.join(' · ')}</span>`
                    : nothing}
                  ${scan.exactFileMatch
                    ? html`<span style="color:var(--danger)">与受保护文档完全一致</span>`
                    : nothing}
                </div>
                ${scan.warnings.length > 0
                  ? html`<div class="notice warn">
                      ${scan.warnings.join('；')}
                      <span style="opacity:.7">（该文件可能无法完整比对，建议人工复核）</span>
                    </div>`
                  : nothing}
                <alert-detail
                  .scan=${scan}
                  .alerts=${alerts}
                  .activeAlertId=${this.activeAlertId}
                  .config=${this.config}
                  @select-alert=${(e: CustomEvent) => (this.activeAlertId = e.detail as string)}
                  @mark-fp=${(e: CustomEvent) => {
                    const a = alerts.find((x) => x.id === e.detail.alertId);
                    if (a) this.markFeedback(a, 'fp', e.detail.suppressEvidence, e.detail.suppressSegment, e.detail.note);
                  }}
                  @mark-tp=${(e: CustomEvent) => {
                    const a = alerts.find((x) => x.id === e.detail.alertId);
                    if (a) this.markFeedback(a, 'tp', false, false, e.detail.note);
                  }}
                ></alert-detail>
              `
            : html`
                <panel-card heading="等待检测">
                  <empty-state
                    title="选择一份外发文件"
                    body="检测台会把文件切分为段落，与受保护文档的分段指纹比对；同时用加盐哈希在客户名单中查找姓名、手机号、邮箱、账号等字段组合。"
                  >
                    <button class="btn primary" @click=${() => this.openPicker('scan')}>选择文件</button>
                    <button class="btn ghost" @click=${() => (this.tab = 'demo')}>载入示例样本</button>
                  </empty-state>
                </panel-card>
              `}
        </div>
      </div>
    `;
  }

  private renderLibrary(): TemplateResult {
    const docs = this.docs.filter((d) => !d.piiOnly);
    const totalSegments = docs.reduce((n, d) => n + d.segmentCount, 0);
    const totalTokens = docs.reduce((n, d) => n + d.tokenCount, 0);
    const lib = docs.length > 0 ? buildLibrary(docs, this.config) : null;
    return html`
      <div class="main-col" style="gap:16px">
        <div class="stats-row">
          <stat-pill label="受保护文档" value=${String(docs.length)} hint="已建档并建立指纹"></stat-pill>
          <stat-pill label="指纹段落" value=${String(totalSegments)} hint="每段一组顺序与无序指纹"></stat-pill>
          <stat-pill
            label="已生成指纹"
            value=${lib ? lib.fingerprintCount.toLocaleString() : '0'}
            hint=${lib ? `另有 ${lib.bagFingerprintCount.toLocaleString()} 组无序指纹` : ''}
          ></stat-pill>
          <stat-pill label="可检索令牌" value=${totalTokens.toLocaleString()} hint="中文按字、西文按词切分"></stat-pill>
        </div>

        <panel-card heading="文档清单" sub=${lib ? `${lib.segmentCount} 个段落已进入索引` : ''}>
          <div style="display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap">
            <button class="btn primary" @click=${() => this.openPicker('library')}>添加受保护文档</button>
            ${docs.length > 0
              ? html`<button
                  class="btn"
                  @click=${() => {
                    if (!this.demo) {
                      this.flash('info', '请先到「示例与评测」载入内置示例文档');
                      return;
                    }
                    this.flash('info', '示例文档已在库中（如重复载入会自动去重）');
                  }}
                >
                  从示例集补充
                </button>`
              : nothing}
            <div style="flex:1"></div>
            <span class="tag">切分：段落 / 表格行 / 文本行</span>
            <span class="tag">指纹窗口：${this.config.seqK} 令牌</span>
          </div>
          ${docs.length === 0
            ? html`<empty-state
                title="尚未建立受保护文档库"
                body="添加需要保护的 Word、Excel、PDF 或纯文本文件。系统会按段落建立分段指纹，外发内容即使被截取、改标点或调整语序也能定位来源。"
              >
                <button class="btn primary" @click=${() => this.openPicker('library')}>添加文档</button>
                <button class="btn ghost" @click=${() => (this.tab = 'demo')}>载入示例</button>
              </empty-state>`
            : html`<div>
                ${docs.map(
                  (d) => html`
                    <div
                      style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--line)"
                    >
                      <span class="tag">${d.kind.toUpperCase()}</span>
                      <div style="min-width:0;flex:1">
                        <div style="font-size:13px;font-weight:580;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                          ${d.title}
                        </div>
                        <div style="font-size:11.5px;color:var(--ink-faint);margin-top:2px">
                          ${d.fileName} · ${d.segmentCount} 段 · ${d.tokenCount} 令牌 ·
                          SHA ${d.sha256.slice(0, 10)}
                          ${d.classification ? html` · <span class="tag">${d.classification}</span>` : nothing}
                        </div>
                      </div>
                      <button
                        class="btn sm"
                        title="查看该文档的分段列表"
                        @click=${() => (this.expandedDocId = this.expandedDocId === d.id ? null : d.id)}
                      >
                        ${this.expandedDocId === d.id ? '收起段落' : '查看段落'}
                      </button>
                      <button
                        class="btn sm ghost danger"
                        title="从索引中移除（不会删除原文件）"
                        @click=${() => {
                          store.removeDoc(d.id);
                          this.flash('info', `已移除《${d.title}》`);
                        }}
                      >
                        移除
                      </button>
                    </div>
                    ${this.expandedDocId === d.id ? this.renderSegments(d) : nothing}
                  `,
                )}
              </div>`}
        </panel-card>
        ${docs.length > 0
          ? html`<panel-card heading="指纹构成" sub="用于解释命中原因">
              <div class="policy-note" style="padding:14px 16px">
                每个段落生成三类可检索特征，命中后按加权得分排序：<br />
                <b>①顺序指纹</b>：${this.config.seqK} 个连续令牌的 64 位哈希，用于识别整段照抄；<br />
                <b>②无序指纹</b>：窗口内令牌排序后再哈希，用于识别句中语序调整；<br />
                <b>③字符 bigram / 最长公共子串</b>：标点无关，用于识别改写与截取；<br />
                <b>④表格单元袋</b>：表格行的单元格集合，用于识别列顺序调换；<br />
                <b>⑤关键数值</b>：金额、比例、编号等，用作佐证但不单独成案。
              </div>
            </panel-card>`
          : nothing}
      </div>
    `;
  }

  /** Expandable segment list for one protected document. */
  private renderSegments(d: ProtectedDocument): TemplateResult {
    return html`
      <div style="background:var(--bg-sunken);padding:10px 16px 12px;border-bottom:1px solid var(--line)">
        <div style="font-size:11.5px;color:var(--ink-faint);margin-bottom:7px">
          共 ${d.text.segments.length} 个段落，每段独立建立指纹；外发内容命中时会定位到具体段落。
        </div>
        <div style="max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:5px">
          ${d.text.segments.map((seg, i) => {
            const text = d.text.raw.slice(seg.start, seg.end);
            const len = seg.tokenEnd - seg.tokenStart;
            return html`
              <div
                style="display:flex;gap:10px;align-items:baseline;padding:6px 9px;background:var(--bg-raised);border:1px solid var(--line);border-radius:5px"
              >
                <span
                  style="font-family:var(--font-mono);font-size:10.5px;color:var(--ink-faint);flex:none;min-width:52px"
                >
                  #${i + 1}
                </span>
                <span style="flex:1;font-size:12px;line-height:1.65;font-family:var(--font-serif)">
                  ${text.length > 110 ? `${text.slice(0, 110)}…` : text}
                </span>
                <span style="font-size:10.5px;color:var(--ink-faint);flex:none">${len} 令牌</span>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }

  private renderVault(): TemplateResult {
    const active = this.vaultSummary.find((v) => v.id === this.activeVaultId) ?? this.vaultSummary[0];
    const unlocked = active ? this.vaultKeys.has(active.id) : false;
    return html`
      <div class="main-col" style="gap:16px">
        <div class="notice info" style="margin-bottom:0">
          客户名单只保存 <b>HMAC-SHA256 加盐哈希</b>，不保存任何明文姓名、手机号或账号；<b>密钥不写入存储</b>，只留在当前页面内存中。
          匹配时对外发文本的候选片段做同样的哈希再比对。设备丢失时，即便拿到浏览器存储也无法还原客户信息。
        </div>
        ${active && !unlocked
          ? html`<div class="notice warn" style="margin-bottom:0">
              名单「${active.name}」已加密保存，但当前会话没有密钥（页面刷新后密钥会清空）。
              重新导入同一份名单即可继续使用；导入时使用相同的口令可以复用已有的哈希。
            </div>`
          : nothing}
        <div class="stats-row">
          <stat-pill label="客户记录" value=${active ? String(active.records) : '0'} hint="去重后记录数"></stat-pill>
          <stat-pill label="字段哈希" value=${active ? String(active.values) : '0'} hint="每个字段独立加盐哈希"></stat-pill>
          <stat-pill label="密钥状态" value=${unlocked ? '已解锁' : '未解锁'} tone=${unlocked ? 'ok' : 'warn'} hint="仅在内存中"></stat-pill>
          <stat-pill
            label="字段类型"
            value=${active ? String(Object.keys(active.fields).length) : '0'}
            hint=${active
              ? Object.entries(active.fields)
                  .map(([f, n]) => `${PII_FIELD_LABELS[f as PiiField] ?? f} ${n}`)
                  .join(' · ')
              : ''}
          ></stat-pill>
        </div>

        <panel-card heading="客户名单库">
          <div style="display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:center">
            <button class="btn primary" @click=${() => void this.importVault()}>导入客户名单（表格）</button>
            <label style="font-size:11.5px;color:var(--ink-soft);display:inline-flex;align-items:center;gap:5px">
              口令（可选）
              <input
                type="password"
                autocomplete="new-password"
                placeholder="留空=仅内存密钥"
                style="font-size:11.5px;padding:4px 7px;border-radius:5px;border:1px solid var(--line-strong);background:var(--bg-raised);width:150px"
                .value=${this.vaultPassphrase}
                @input=${(e: Event) => (this.vaultPassphrase = (e.target as HTMLInputElement).value)}
              />
            </label>
            ${this.demo
              ? html`<button class="btn" @click=${() => this.useDemoVault()}>使用示例客户名单</button>`
              : nothing}
            <div style="flex:1"></div>
            ${this.vaultSummary.length > 0
              ? html`<label style="font-size:12px;color:var(--ink-soft)">
                  当前使用：
                  <select
                    style="font-size:12px;padding:4px 6px;border-radius:5px;border:1px solid var(--line-strong);background:var(--bg-raised)"
                    @change=${(e: Event) => {
                      const id = (e.target as HTMLSelectElement).value;
                      store.update((s) => {
                        s.activeVaultId = id || null;
                      });
                    }}
                  >
                    ${this.vaultSummary.map(
                      (v) => html`<option value=${v.id} .selected=${v.id === this.activeVaultId}>
                        ${v.name}（${v.records} 条）
                      </option>`,
                    )}
                  </select>
                </label>`
              : nothing}
          </div>
          ${this.vaultSummary.length === 0
            ? html`<empty-state
                title="尚未建立客户名单库"
                body="导入一张含姓名、手机、邮箱、客户名称、银行账号等列的表格。导入时立即转为加盐哈希，明文不会写入浏览器存储。"
              ></empty-state>`
            : html`<div>
                ${this.vaultSummary.map(
                  (v) => html`
                    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)">
                      <span class="tag pii">加盐哈希</span>
                      <div style="flex:1">
                        <div style="font-size:13px;font-weight:580">${v.name}</div>
                        <div style="font-size:11.5px;color:var(--ink-faint);margin-top:2px">
                          ${v.records} 条记录 / ${v.values} 个字段哈希 · 建立于 ${formatTime(v.createdAt)}
                        </div>
                      </div>
                      <button
                        class="btn sm ghost danger"
                        @click=${() => {
                          store.removeVault(v.id);
                          this.vaultKeys.delete(v.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  `,
                )}
              </div>`}
        </panel-card>

        <panel-card heading="匹配规则" sub="代码内固定，可解释">
          <div class="policy-note" style="padding:14px 16px">
            <b>字段权重</b>：身份证 55 · 银行账号 46 · 手机号 42 · 邮箱 38 · 姓名 26 · 公司名称 16。<br />
            <b>组合告警</b>：同一记录的 ≥ ${this.config.piiComboFields} 个字段出现在 ${this.config.piiProximity} 字符内时升级为组合告警（默认「严重」）。<br />
            <b>归一化</b>：手机号、账号、证件号只比较数字，删掉连字符与空格；姓名、公司名称忽略标点与全半角差异；邮箱忽略大小写。<br />
            <b>单字段命中</b>：只命中姓名这类弱字段时按低风险处理，可被阈值过滤或人工标记误报。
          </div>
        </panel-card>
      </div>
    `;
  }

  private useDemoVault() {
    if (!this.demo) return;
    this.vaultKeys.set(this.demo.vault.vault.id, this.demo.vault.key);
    store.addVault(this.demo.vault.vault);
    this.flash('ok', '已载入示例客户名单（仅哈希）');
  }

  private async importVault() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.csv,.txt';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      this.busy = `正在读取 ${file.name}`;
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const parsed = await parseFile({ fileName: file.name, data });
        const header = parsed.blocks[0]?.text.split(' | ') ?? [];
        const fields = header.map((h) => detectField(h));
        if (!fields.some(Boolean)) {
          throw new Error('未识别到可用的字段列（支持：姓名/联系人、手机/电话、邮箱、客户名称、账号、身份证）');
        }
        const records: RawCustomerRecord[] = [];
        for (const block of parsed.blocks.slice(1)) {
          const cells = block.text.split(' | ');
          const rec: RawCustomerRecord = {};
          fields.forEach((f, i) => {
            if (f && cells[i]) rec[f] = cells[i];
          });
          if (Object.keys(rec).length > 0) records.push(rec);
        }
        if (records.length === 0) throw new Error('表格中没有可用的数据行');
        // Session-scoped random key: re-importing the list after a reload is
        // the only way back in, which is the safer default. A passphrase can
        // be supplied for teams that need the vault to survive a reload.
        const passphrase = this.vaultPassphrase.trim();
        const { vault, key } = createVault(
          file.name.replace(/\.[^.]+$/, ''),
          records,
          passphrase ? { passphrase } : {},
        );
        this.vaultKeys.set(vault.id, key);
        store.addVault(vault);
        this.flash(
          'ok',
          `已导入 ${vault.stats.records} 条记录，生成 ${vault.stats.values} 个字段哈希；原始明文未保存` +
            (passphrase ? '，已使用口令加密（刷新后可用同一口令解锁）' : '，密钥仅保留在内存中'),
        );
      } catch (err) {
        this.flash('danger', (err as Error).message);
      } finally {
        this.busy = '';
      }
    };
    input.click();
  }
}
