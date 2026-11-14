import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Alert, DetectionConfig, ScanResult, SegmentMatch } from '../core/types';
import { PII_FIELD_LABELS, type PiiField } from '../core/types';
import './text-highlight';
import type { HighlightSpan } from './text-highlight';
import './primitives';

const SEV_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

@customElement('alert-detail')
export class AlertDetail extends LitElement {
  @property({ type: Object }) scan: ScanResult | null = null;
  @property({ type: Array }) alerts: Alert[] = [];
  @property({ type: String }) activeAlertId: string | null = null;
  @property({ type: Object }) config!: DetectionConfig;

  @state() private filter: 'all' | 'segment' | 'pii' = 'all';
  @state() private showSource = true;

  static styles = css`
    :host {
      display: block;
    }
    .layout {
      display: grid;
      grid-template-columns: 392px minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    @media (max-width: 1080px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .list {
      display: flex;
      flex-direction: column;
      max-height: 640px;
      overflow: auto;
    }
    .filter-row {
      display: flex;
      gap: 4px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--bg-raised);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .chip {
      appearance: none;
      border: 1px solid var(--line);
      background: transparent;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 11.5px;
      cursor: pointer;
      color: var(--ink-soft);
    }
    .chip[aria-pressed='true'] {
      background: var(--accent);
      border-color: var(--accent);
      color: #f7fbfa;
    }
    .alert-row {
      display: block;
      width: 100%;
      text-align: left;
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      border-bottom: 1px solid var(--line);
      border-left: 3px solid transparent;
      padding: 10px 13px 11px 12px;
      cursor: pointer;
    }
    .alert-row:hover {
      background: var(--bg-sunken);
    }
    .alert-row[aria-current='true'] {
      background: var(--accent-soft);
      border-left-color: var(--accent);
    }
    .alert-row .top-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 3px;
    }
    .alert-row .score {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 640;
      font-variant-numeric: tabular-nums;
    }
    .alert-row .title {
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--ink);
    }
    .alert-row .sub {
      font-size: 11px;
      color: var(--ink-faint);
      margin-top: 3px;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .detail {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .detail-head {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 14px 16px;
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius);
    }
    .detail-head h3 {
      font-size: 14px;
      line-height: 1.5;
    }
    .detail-head .meta {
      font-size: 11.5px;
      color: var(--ink-faint);
    }
    .why {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
    }
    .why.five {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
    .metric {
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
    }
    .metric .k {
      font-size: 10.5px;
      color: var(--ink-faint);
      letter-spacing: 0.02em;
    }
    .metric .v {
      font-size: 14px;
      font-weight: 620;
      font-variant-numeric: tabular-nums;
      margin-top: 1px;
    }

    .compare {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }
    @media (max-width: 1320px) {
      .compare {
        grid-template-columns: 1fr;
      }
    }
    .pane {
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .pane header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 12px;
      font-weight: 600;
      background: color-mix(in oklab, var(--bg-raised) 60%, var(--bg));
    }
    .pane header .loc {
      margin-left: auto;
      font-size: 11px;
      color: var(--ink-faint);
      font-weight: 400;
      max-width: 62%;
      text-align: right;
      line-height: 1.45;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pane .body {
      padding: 12px 14px;
      max-height: 330px;
      overflow: auto;
    }

    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      padding: 10px 14px;
      border-top: 1px solid var(--line);
      background: color-mix(in oklab, var(--bg-raised) 55%, var(--bg));
    }
    .actions .note {
      font-size: 11.5px;
      color: var(--ink-faint);
      flex: 1;
      min-width: 180px;
    }

    .btn {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: var(--bg-raised);
      border-radius: var(--radius-sm);
      padding: 5px 11px;
      font-size: 12px;
      cursor: pointer;
      color: var(--ink);
      font-weight: 540;
    }
    .btn:hover {
      background: var(--bg-sunken);
    }
    .btn.fp {
      color: var(--danger);
      border-color: color-mix(in oklab, var(--danger) 36%, var(--line));
    }
    .btn.tp {
      color: var(--ok);
      border-color: color-mix(in oklab, var(--ok) 36%, var(--line));
    }
    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11.5px;
      color: var(--ink-soft);
      cursor: pointer;
      user-select: none;
    }
    .empty-detail {
      padding: 40px 20px;
      text-align: center;
      color: var(--ink-faint);
      font-size: 13px;
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius);
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
  `;

  private visibleAlerts(): Alert[] {
    const list = this.filter === 'all'
      ? this.alerts
      : this.alerts.filter((a) =>
          this.filter === 'segment'
            ? a.detector === 'segment' || a.detector === 'file_copy' || a.detector === 'file_similar'
            : a.detector.startsWith('pii'),
        );
    return [...list].sort(
      (a, b) => (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0) || b.score - a.score,
    );
  }

  private activeAlert(): Alert | null {
    return this.alerts.find((a) => a.id === this.activeAlertId) ?? this.visibleAlerts()[0] ?? null;
  }

  private matchFor(alert: Alert): SegmentMatch | null {
    if (!this.scan || alert.detector !== 'segment') return null;
    return (
      this.scan.segmentMatches.find(
        (m) => m.docId === alert.docId && m.segmentIndex === alert.segmentIndex,
      ) ?? null
    );
  }

  private studySpans(alert: Alert): HighlightSpan[] {
    if (!this.scan) return [];
    // Show every alert's span so the reviewer sees all evidence in context,
    // with the selected one emphasised.
    const out: HighlightSpan[] = [];
    for (const a of this.alerts) {
      const active = a.id === alert.id;
      for (const s of a.spans) {
        out.push({
          start: s.start,
          end: s.end,
          tone: active ? 'active' : a.detector.startsWith('pii') ? 'pii' : 'hit',
          title: a.title,
        });
      }
    }
    return out;
  }

  private emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    const alert = this.activeAlert();
    const list = this.visibleAlerts();
    return html`
      <div class="layout">
        <div class="pane" style="max-height:640px">
          <div class="filter-row">
            <button class="chip" aria-pressed=${this.filter === 'all'} @click=${() => (this.filter = 'all')}>
              全部 ${this.alerts.length}
            </button>
            <button
              class="chip"
              aria-pressed=${this.filter === 'segment'}
              @click=${() => (this.filter = 'segment')}
            >
              段落指纹 ${this.alerts.filter((a) => !a.detector.startsWith('pii')).length}
            </button>
            <button class="chip" aria-pressed=${this.filter === 'pii'} @click=${() => (this.filter = 'pii')}>
              客户数据 ${this.alerts.filter((a) => a.detector.startsWith('pii')).length}
            </button>
          </div>
          ${list.length === 0
            ? html`<div class="empty-detail" style="border:none;border-radius:0">
                当前筛选下没有告警
              </div>`
            : html`<div class="list">
                ${list.map(
                  (a) => html`
                    <button
                      class="alert-row"
                      aria-current=${alert?.id === a.id ? 'true' : 'false'}
                      @click=${() => this.emit('select-alert', a.id)}
                    >
                      <div class="top-line">
                        <sev-badge severity=${a.severity}></sev-badge>
                        <span class="tag"
                          >${a.detector === 'segment'
                            ? '段落'
                            : a.detector === 'pii_combo'
                              ? '数据组合'
                              : a.detector === 'pii_single'
                                ? '数据单字段'
                                : a.detector === 'file_copy'
                                  ? '原件外发'
                                  : '大面积复制'}</span
                        >
                        <span class="score" style="color:var(--ink-soft)">${a.score.toFixed(0)}</span>
                      </div>
                      <div class="title">${a.title}</div>
                      <div class="sub">${a.detail}</div>
                    </button>
                  `,
                )}
              </div>`}
        </div>

        ${alert ? this.renderDetail(alert) : html`<div class="empty-detail">选择左侧告警查看证据</div>`}
      </div>
    `;
  }

  private renderDetail(alert: Alert): TemplateResult {
    const scan = this.scan!;
    const match = this.matchFor(alert);
    const pii = alert.detector.startsWith('pii');
    const recordIds = alert.recordIds ?? [];
    const fields = (alert.fields ?? []) as PiiField[];
    return html`
      <div class="detail">
        <div class="detail-head">
          <div style="display:flex;align-items:center;gap:9px">
            <sev-badge severity=${alert.severity}></sev-badge>
            <span class="meta">${pii ? '精确数据匹配' : '分段指纹比对'}</span>
            <span class="meta" style="margin-left:auto">置信度 ${alert.score.toFixed(1)}</span>
          </div>
          <h3>${alert.title}</h3>
          <div class="meta">${alert.detail}</div>
        </div>

        ${match
          ? html`<div class="why five">
              <div class="metric">
                <div class="k">指纹覆盖</div>
                <div class="v">${(match.exactCoverage * 100).toFixed(0)}%</div>
              </div>
              <div class="metric">
                <div class="k">字符重合</div>
                <div class="v">${(match.charOverlap * 100).toFixed(0)}%</div>
              </div>
              <div class="metric">
                <div class="k">最长相同片段</div>
                <div class="v">${match.lcsChars} 字</div>
              </div>
              <div class="metric">
                <div class="k">命中令牌</div>
                <div class="v">${match.matchedTokens}/${match.segmentTokens}</div>
              </div>
              <div class="metric">
                <div class="k">特征词权重</div>
                <div class="v">${(match.idfNorm * 100).toFixed(0)}%</div>
              </div>
            </div>`
          : nothing}
        ${pii
          ? html`<div class="why">
              <div class="metric">
                <div class="k">命中字段</div>
                <div class="v" style="font-size:12.5px">
                  ${fields.map((f) => PII_FIELD_LABELS[f] ?? f).join(' · ')}
                </div>
              </div>
              <div class="metric">
                <div class="k">客户记录</div>
                <div class="v" style="font-size:12.5px">${recordIds.join('、') || '—'}</div>
              </div>
              <div class="metric">
                <div class="k">字段距离</div>
                <div class="v">
                  ${(() => {
                    const m = /字段距离 (\d+|—)/.exec(alert.detail);
                    return m ? (m[1] === '—' ? '—' : `${m[1]} 字`) : '—';
                  })()}
                </div>
              </div>
              <div class="metric">
                <div class="k">匹配方式</div>
                <div class="v" style="font-size:12px">加盐 HMAC</div>
              </div>
            </div>`
          : nothing}

        <div class="compare">
          <div class="pane">
            <header>
              外发文件
              <span class="loc">${scan.fileName}</span>
            </header>
            <div class="body">
              <text-highlight .text=${scan.text.raw} .spans=${this.studySpans(alert)}></text-highlight>
            </div>
          </div>

          ${match && this.showSource
            ? html`<div class="pane">
                <header>
                  受保护文档原文
                  <span class="loc">《${match.docTitle}》${match.location}</span>
                </header>
                <div class="body">
                  <text-highlight .text=${match.sourceText} .spans=${[]}></text-highlight>
                </div>
                <div
                  style="padding:9px 14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-faint)"
                >
                  该段共 ${match.segmentTokens} 个令牌，本次命中 ${match.matchedTokens} 个；
                  ${match.trigramCoverage >= 0.5 ? '短语结构基本一致' : '短语结构有较多改动'}。
                </div>
              </div>`
            : nothing}
        </div>

        <div class="pane">
          <div class="actions">
            ${match
              ? html`<label class="toggle">
                  <input
                    type="checkbox"
                    .checked=${this.showSource}
                    @change=${(e: Event) => (this.showSource = (e.target as HTMLInputElement).checked)}
                  />
                  显示受保护原文
                </label>`
              : html`<span class="note">该告警来自加盐哈希匹配，明文值仅在本页展示，不写入存储。</span>`}
            <div style="flex:1"></div>
            <button
              class="btn fp"
              title="标记为误报；可同时对相同证据或整个来源段落启用抑制"
              @click=${() =>
                this.emit('mark-fp', {
                  alertId: alert.id,
                  suppressEvidence: true,
                  suppressSegment: false,
                })}
            >
              标记误报
            </button>
            <button
              class="btn tp"
              title="确认为真实泄露，作为正样本用于阈值校准"
              @click=${() => this.emit('mark-tp', { alertId: alert.id })}
            >
              确认泄露
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'alert-detail': AlertDetail;
  }
}
