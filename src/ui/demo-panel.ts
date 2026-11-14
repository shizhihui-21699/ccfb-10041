import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ScanResult } from '../core/types';
import type { EvalReport } from '../demo/evaluate';
import type { SampleManifest } from '../demo/evaluate';
import './primitives';

@customElement('demo-panel')
export class DemoPanel extends LitElement {
  @property({ type: Object }) manifest: SampleManifest | null = null;
  @property({ type: Object }) report: EvalReport | null = null;
  @property({ type: Boolean }) busy = false;
  @property({ type: Boolean }) evalRunning = false;
  @property({ type: String }) error = '';
  @property({ type: Array }) scans: ScanResult[] = [];

  static styles = css`
    :host {
      display: block;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }
    .card > header {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in oklab, var(--bg-raised) 60%, var(--bg));
    }
    .card > header h2 {
      font-size: 13.5px;
    }
    .card > header .sub {
      margin-left: auto;
      font-size: 11.5px;
      color: var(--ink-faint);
    }
    .pad {
      padding: 16px;
    }
    .intro {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      padding: 16px;
      flex-wrap: wrap;
    }
    .intro .copy {
      flex: 1;
      min-width: 280px;
      font-size: 12.5px;
      line-height: 1.8;
      color: var(--ink-soft);
    }
    .intro .copy b {
      color: var(--ink);
    }
    .btn {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: var(--bg-raised);
      border-radius: var(--radius-sm);
      padding: 7px 13px;
      font-size: 12.5px;
      cursor: pointer;
      font-weight: 540;
    }
    .btn:hover {
      background: var(--bg-sunken);
    }
    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #f7fbfa;
    }
    .btn.primary:hover {
      background: #184c49;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
      padding: 0 16px 16px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--bg);
      padding: 10px 12px;
    }
    .metric .k {
      font-size: 10.5px;
      color: var(--ink-faint);
      letter-spacing: 0.02em;
    }
    .metric .v {
      font-size: 20px;
      font-weight: 660;
      font-variant-numeric: tabular-nums;
      margin-top: 2px;
      letter-spacing: -0.02em;
    }
    .metric .h {
      font-size: 10.5px;
      color: var(--ink-faint);
      margin-top: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th,
    td {
      text-align: left;
      padding: 7px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      font-size: 10.5px;
      color: var(--ink-faint);
      font-weight: 560;
      letter-spacing: 0.02em;
      background: color-mix(in oklab, var(--bg-raised) 55%, var(--bg));
      position: sticky;
      top: 0;
    }
    tbody tr:hover {
      background: var(--bg-sunken);
    }
    .scroll {
      max-height: 480px;
      overflow: auto;
    }
    .mono {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
    }
    .ok {
      color: var(--ok);
    }
    .bad {
      color: var(--danger);
    }
    .muted {
      color: var(--ink-faint);
    }
    .tag {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--bg-sunken);
      border: 1px solid var(--line);
      color: var(--ink-soft);
      white-space: nowrap;
    }
    .tag.decoy {
      background: var(--accent-soft);
      border-color: color-mix(in oklab, var(--accent) 22%, transparent);
      color: var(--accent);
    }
    .bar-cell {
      min-width: 130px;
    }
    .bar-track {
      height: 6px;
      background: var(--bg-sunken);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 3px;
    }
    .bar-fill {
      height: 100%;
      background: var(--ok);
      border-radius: 3px;
    }
    .bar-fill.partial {
      background: var(--warn);
    }
    .bar-fill.miss {
      background: var(--danger);
    }
    .linkish {
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .err {
      color: var(--danger);
      font-size: 12.5px;
      padding: 0 16px 14px;
    }
    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid color-mix(in oklab, var(--accent) 30%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 700ms linear infinite;
      vertical-align: -1px;
      margin-right: 6px;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  private emit(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    const m = this.manifest;
    const r = this.report;
    return html`
      <div class="col">
        <div class="card">
          <header>
            <h2>内置样本集</h2>
            <span class="sub">
              ${m ? `${m.protected.length} 份受保护文档 · ${m.outgoing.length} 份外发样本` : '尚未载入'}
            </span>
          </header>
          <div class="intro">
            <div class="copy">
              样本集覆盖 <b>docx / xlsx / pdf / txt</b> 四种格式，包含整段照抄、改标点、调语序、改写、
              截取、表格重排、中英混排等泄露方式，以及 <b>同主题但不该报</b> 的对照样本（公告、行业研究、入职须知、询价单）。
              客户名单只以加盐哈希入库，外发样本中既有整表导出，也有把手机号写成 <span class="mono">139-0013-9002</span> 的规避写法。
              <br />
              点击「载入并扫描」会真实解析这些文件，结果与命令行 <span class="mono">npm run eval</span> 一致。
            </div>
            <div class="actions">
              <button class="btn primary" ?disabled=${this.busy} @click=${() => this.emit('load-demo', { scan: true })}>
                ${this.busy ? html`<span class="spinner"></span>` : nothing}载入并扫描
              </button>
              <button class="btn" ?disabled=${this.busy} @click=${() => this.emit('load-demo', { scan: false })}>
                只载入文档与名单
              </button>
              <button
                class="btn"
                ?disabled=${!m || this.evalRunning}
                @click=${() => this.emit('run-eval')}
              >
                ${this.evalRunning ? html`<span class="spinner"></span>` : nothing}运行自动评测
              </button>
            </div>
          </div>
          ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
        </div>

        ${r
          ? html`<div class="card">
              <header>
                <h2>自动评测结果</h2>
                <span class="sub">用时 ${r.elapsedMs.toFixed(0)} ms · 依据样本自带的标注</span>
              </header>
              <div class="metrics">
                <div class="metric">
                  <div class="k">段落识别准确率</div>
                  <div class="v" style="color:var(--ok)">${(r.segment.precision * 100).toFixed(1)}%</div>
                  <div class="h">${r.segment.tp} 命中 / ${r.segment.fp} 误报</div>
                </div>
                <div class="metric">
                  <div class="k">段落识别召回率</div>
                  <div class="v">${(r.segment.recall * 100).toFixed(1)}%</div>
                  <div class="h">漏报 ${r.segment.fn} 段</div>
                </div>
                <div class="metric">
                  <div class="k">段落 F1</div>
                  <div class="v">${(r.segment.f1 * 100).toFixed(1)}%</div>
                  <div class="h">分段指纹 + 改写识别</div>
                </div>
                <div class="metric">
                  <div class="k">客户数据 F1</div>
                  <div class="v" style="color:var(--ok)">${(r.pii.f1 * 100).toFixed(1)}%</div>
                  <div class="h">${r.pii.tp} 命中 / ${r.pii.fp} 误报</div>
                </div>
                <div class="metric">
                  <div class="k">对照样本误报</div>
                  <div class="v" style="color:${r.decoyFalsePositives === 0 ? 'var(--ok)' : 'var(--danger)'}">
                    ${r.decoyFalsePositives} / ${r.decoys}
                  </div>
                  <div class="h">同主题文件不应触发</div>
                </div>
              </div>
              <div style="padding:0 16px 16px">
                <div class="muted" style="font-size:11.5px;margin-bottom:6px">按改写方式统计命中率</div>
                <table>
                  <thead>
                    <tr><th>改写方式</th><th>命中</th><th class="bar-cell">比例</th></tr>
                  </thead>
                  <tbody>
                    ${Object.entries(r.perMutation).map(([k, v]) => {
                      const pct = v.total === 0 ? 0 : v.detected / v.total;
                      return html`<tr>
                        <td>${MUTATION_LABEL[k] ?? k}</td>
                        <td class="mono">${v.detected}/${v.total}</td>
                        <td class="bar-cell">
                          <div class="bar-track">
                            <div
                              class="bar-fill ${pct === 1 ? '' : pct >= 0.5 ? 'partial' : 'miss'}"
                              style="width:${pct * 100}%"
                            ></div>
                          </div>
                        </td>
                      </tr>`;
                    })}
                  </tbody>
                </table>
              </div>
            </div>`
          : nothing}

        ${m
          ? html`<div class="card">
              <header>
                <h2>样本明细</h2>
                <span class="sub">点击文件名可单独检测并在「外发检测」中查看</span>
              </header>
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>样本</th>
                      <th>场景</th>
                      <th>标注</th>
                      <th>本次结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${m.outgoing.map((s) => {
                      // Scans made from the demo keep the sample's file name
                      // (e.g. "OUT-01.docx"); match on the sample id prefix.
                      const scan = this.scans.find((x) =>
                        x.fileName.toUpperCase().startsWith(s.id.toUpperCase()),
                      );
                      const expected =
                        s.expectNone
                          ? '无泄露'
                          : `${s.leaks.length} 段${s.pii.length > 0 ? ` + ${s.pii.length} 条客户记录` : ''}`;
                      return html`<tr>
                        <td>
                          <button class="linkish" @click=${() => this.emit('open-sample', s.id)}>${s.id}</button>
                          <div class="muted mono" style="font-size:10px">${s.format}</div>
                        </td>
                        <td style="font-size:11.5px">${s.scenario}</td>
                        <td>
                          ${s.expectNone
                            ? html`<span class="tag decoy">对照</span>`
                            : html`<span class="tag">${expected}</span>`}
                        </td>
                        <td class="mono" style="font-size:11px">
                          ${scan
                            ? scan.alerts.length === 0
                              ? html`<span class="ok">无告警</span>`
                              : html`<span class="bad">${scan.alerts.length} 告警</span>`
                            : html`<span class="muted">未检测</span>`}
                        </td>
                      </tr>`;
                    })}
                  </tbody>
                </table>
              </div>
            </div>`
          : html`<div class="card">
              <header><h2>样本明细</h2></header>
              <div style="padding:34px 20px;text-align:center;color:var(--ink-faint);font-size:12.5px">
                载入样本后这里会列出全部 ${'外发样本'}、场景说明与标注。
              </div>
            </div>`}
      </div>
    `;
  }
}

const MUTATION_LABEL: Record<string, string> = {
  verbatim: '整段照抄',
  punctuation: '改标点 / 全半角',
  reorder: '调整语序',
  paraphrase: '改写措辞',
  truncate: '截取片段',
  merge: '跨段拼接',
  'translate-mix': '中英混排',
  reformat: '表格 ↔ 段落转换',
};

declare global {
  interface HTMLElementTagNameMap {
    'demo-panel': DemoPanel;
  }
}
