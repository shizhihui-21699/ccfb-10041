import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  DetectionConfig,
  FeedbackRecord,
  ProtectedDocument,
  CalibrationResult,
  CalibrationPoint,
} from '../core/types';
import { CALIBRATION_PARAMS, calibrate, type CalibrationParam } from '../core/scan';
import { formatTime } from '../state/store';
import './primitives';

const PARAM_META: Record<
  CalibrationParam,
  { label: string; hint: string; detector: 'segment' | 'pii_combo' }
> = {
  minSegmentScore: {
    label: '段落告警阈值',
    hint: '低于该得分的段落相似不再告警。阈值越高，误报越少、漏报越多。',
    detector: 'segment',
  },
  minPiiScore: {
    label: '客户数据阈值',
    hint: '客户字段组合的得分下限，低于该值的记录不再出现在告警中。',
    detector: 'pii_combo',
  },
};

@customElement('calibration-panel')
export class CalibrationPanel extends LitElement {
  @property({ type: Object }) config!: DetectionConfig;
  @property({ type: Array }) feedback: FeedbackRecord[] = [];
  @property({ type: Array }) docs: ProtectedDocument[] = [];

  @state() private selectedParam: CalibrationParam = 'minSegmentScore';
  @state() private noteTarget: string | null = null;

  static styles = css`
    :host {
      display: block;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1120px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-width: 0;
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
      padding: 12px 15px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in oklab, var(--bg-raised) 60%, var(--bg));
    }
    .card > header h2 {
      font-size: 13.5px;
    }
    .card > header .sub {
      font-size: 11.5px;
      color: var(--ink-faint);
      margin-left: auto;
    }
    .card .pad {
      padding: 14px 15px;
    }

    .param {
      padding: 11px 15px;
      border-bottom: 1px solid var(--line);
    }
    .param:last-child {
      border-bottom: none;
    }
    .param-top {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }
    .param-top .name {
      font-size: 12.5px;
      font-weight: 600;
    }
    .param-top .val {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      color: var(--accent);
      font-weight: 640;
    }
    .param .hint {
      font-size: 11.5px;
      color: var(--ink-faint);
      line-height: 1.6;
      margin-bottom: 7px;
    }
    input[type='range'] {
      width: 100%;
      accent-color: var(--accent);
    }
    .suggest {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 7px;
      font-size: 11.5px;
      color: var(--ink-soft);
    }
    .suggest .pill {
      background: var(--accent-soft);
      color: var(--accent);
      padding: 2px 8px;
      border-radius: 999px;
      font-weight: 620;
      font-variant-numeric: tabular-nums;
    }

    .btn {
      appearance: none;
      border: 1px solid var(--line-strong);
      background: var(--bg-raised);
      border-radius: var(--radius-sm);
      padding: 6px 12px;
      font-size: 12px;
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
    .btn.ghost {
      border-color: transparent;
      background: none;
      color: var(--ink-soft);
    }
    .btn.sm {
      padding: 3px 8px;
      font-size: 11px;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .fb-row {
      padding: 10px 15px;
      border-bottom: 1px solid var(--line);
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .fb-row:last-child {
      border-bottom: none;
    }
    .fb-row .label {
      flex: none;
      font-size: 10.5px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
    }
    .fb-row .label.fp {
      background: var(--danger-soft);
      color: var(--danger);
    }
    .fb-row .label.tp {
      background: var(--ok-soft);
      color: var(--ok);
    }
    .fb-row .body {
      flex: 1;
      min-width: 0;
    }
    .fb-row .title {
      font-size: 12px;
      line-height: 1.5;
    }
    .fb-row .meta {
      font-size: 10.5px;
      color: var(--ink-faint);
      margin-top: 2px;
      font-variant-numeric: tabular-nums;
    }
    .fb-row .note-input {
      width: 100%;
      margin-top: 6px;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 4px 7px;
      font-size: 11.5px;
      background: var(--bg);
    }

    .chart {
      position: relative;
      margin: 8px 0 20px 32px;
      width: calc(100% - 36px);
      /* Keep a readable, restrained height regardless of column width. */
      max-height: 158px;
    }
    .chart svg {
      /* Height follows the viewBox aspect ratio: 150/340 ≈ 44%. Using a
       * percentage padding trick instead of aspect-ratio keeps this working
       * inside column containers that shrink-wrap their children. */
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .axis {
      position: absolute;
      font-size: 9.5px;
      color: var(--ink-faint);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      pointer-events: none;
      white-space: nowrap;
    }
    .axis-y {
      right: calc(100% + 4px);
      transform: translateY(-50%);
    }
    .axis-x {
      bottom: -3px;
      transform: translate(-50%, 100%);
    }
    .legend {
      display: flex;
      gap: 14px;
      font-size: 11px;
      color: var(--ink-soft);
      padding: 0 2px 4px;
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .legend i {
      width: 10px;
      height: 3px;
      border-radius: 2px;
      display: inline-block;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      padding: 12px 15px;
    }
    .metric {
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
    }
    .metric .k {
      font-size: 10.5px;
      color: var(--ink-faint);
    }
    .metric .v {
      font-size: 15px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      margin-top: 1px;
    }
    .empty {
      padding: 34px 22px;
      text-align: center;
      color: var(--ink-faint);
      font-size: 12.5px;
      line-height: 1.7;
    }
    .warn-note {
      font-size: 11.5px;
      color: #6d4708;
      background: var(--warn-soft);
      border: 1px solid color-mix(in oklab, var(--warn) 22%, transparent);
      border-radius: var(--radius-sm);
      padding: 9px 11px;
      line-height: 1.65;
      margin: 0 15px 13px;
    }
  `;

  private calibration(): CalibrationResult {
    const meta = PARAM_META[this.selectedParam];
    return calibrate(this.feedback, meta.detector, this.selectedParam, this.config[this.selectedParam]);
  }

  private apply(threshold: number) {
    this.dispatchEvent(
      new CustomEvent('apply-config', {
        detail: { [this.selectedParam]: threshold },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private suggestedFor(param: CalibrationParam): number | null {
    const meta = PARAM_META[param];
    const cal = calibrate(this.feedback, meta.detector, param, this.config[param]);
    return cal.suggestedThreshold;
  }

  render(): TemplateResult {
    const cal = this.calibration();
    const meta = PARAM_META[this.selectedParam];
    const points = this.feedback.filter((f) => f.detector === meta.detector);
    return html`
      <div class="grid">
        <div class="col">
          <div class="card">
            <header>
              <h2>阈值</h2>
              <span class="sub">调整后点「重算检测结果」立即生效</span>
            </header>
            ${CALIBRATION_PARAMS.map((param) => {
              const m = PARAM_META[param];
              const value = this.config[param];
              const suggest = this.suggestedFor(param);
              return html`
                <div class="param" style=${param === this.selectedParam ? 'background:var(--accent-soft)' : ''}>
                  <div class="param-top">
                    <span class="name">${m.label}</span>
                    <span class="tag" style="font-size:10px;color:var(--ink-faint)">${m.detector === 'segment' ? '段落' : '客户数据'}</span>
                    <span class="val">${value}</span>
                  </div>
                  <div class="hint">${m.hint}</div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    .value=${String(value)}
                    @input=${(e: Event) => {
                      const v = Number((e.target as HTMLInputElement).value);
                      this.dispatchEvent(
                        new CustomEvent('apply-config', {
                          detail: { [param]: v },
                          bubbles: true,
                          composed: true,
                        }),
                      );
                    }}
                    @change=${() => (this.selectedParam = param)}
                    @focus=${() => (this.selectedParam = param)}
                  />
                  <div class="suggest">
                    ${suggest !== null
                      ? html`<span class="pill">建议 ${suggest}</span>
                          <button class="btn sm" @click=${() => this.apply(suggest)}>采用</button>
                          <button class="btn sm ghost" @click=${() => (this.selectedParam = param)}>
                            查看曲线
                          </button>`
                      : html`<span style="color:var(--ink-faint)">标注样本不足，暂未给出建议（需同时有误报与确认样本）</span>`}
                  </div>
                </div>
              `;
            })}
            <div class="pad" style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn primary" @click=${() => this.dispatchEvent(new CustomEvent('rescan', { bubbles: true, composed: true }))}>
                重算检测结果
              </button>
              <button
                class="btn"
                @click=${() =>
                  this.dispatchEvent(
                    new CustomEvent('apply-config', {
                      detail: {
                        minSegmentScore: 45,
                        minCharOverlap: 0.3,
                        minOverlap: 0.34,
                        minPiiScore: 55,
                        piiComboFields: 2,
                        piiProximity: 160,
                      },
                      bubbles: true,
                      composed: true,
                    }),
                  )}
              >
                恢复默认
              </button>
            </div>
          </div>

          <div class="card">
            <header>
              <h2>误报与确认样本</h2>
              <span class="sub">${this.feedback.length} 条标注</span>
            </header>
            ${points.length === 0
              ? html`<div class="empty">
                  还没有针对「${meta.label}」的记录。<br />
                  在告警详情里点「标记误报」或「确认泄露」，即可积累标注并得到阈值建议。
                </div>`
              : html`<div class="chart-wrap" style="padding:12px 15px 4px">
                  <div class="legend">
                    <span><i style="background:var(--ok)"></i>准确率 precision</span>
                    <span><i style="background:var(--danger)"></i>召回率 recall</span>
                    <span><i style="background:var(--accent);opacity:.5"></i>当前阈值</span>
                    <span style="margin-left:auto;color:var(--ink-faint)">横轴：告警阈值</span>
                  </div>
                  ${this.renderChart(cal)}
                </div>`}
          </div>

          ${this.feedback.length > 0
            ? html`<div class="card">
                <header><h2>标注记录</h2><span class="sub">越新的越靠上</span></header>
                ${this.feedback.slice(0, 60).map(
                  (f) => html`
                    <div class="fb-row">
                      <span class="label ${f.label}">${f.label === 'fp' ? '误报' : '确认'}</span>
                      <div class="body">
                        <div class="title">${f.alertTitle}</div>
                        <div class="meta">
                          得分 ${f.score.toFixed(1)} · ${f.detector} · ${formatTime(f.createdAt)}
                          ${f.suppressEvidence ? ' · 已启用证据抑制' : ''}
                          ${f.suppressSegment ? ' · 已抑制该来源段落' : ''}
                        </div>
                        ${this.noteTarget === f.id
                          ? html`<input
                              class="note-input"
                              placeholder="记录为什么这是误报（可选）"
                              .value=${f.note ?? ''}
                              @change=${(e: Event) => {
                                const note = (e.target as HTMLInputElement).value;
                                f.note = note;
                                this.noteTarget = null;
                                this.requestUpdate();
                              }}
                            />`
                          : html`${f.note ? html`<div class="meta">备注：${f.note}</div>` : nothing}`}
                      </div>
                      <div style="display:flex;flex-direction:column;gap:4px">
                        <button class="btn sm ghost" @click=${() => (this.noteTarget = f.id)}>备注</button>
                        <button
                          class="btn sm ghost"
                          @click=${() =>
                            this.dispatchEvent(
                              new CustomEvent('drop-feedback', { detail: f.id, bubbles: true, composed: true }),
                            )}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  `,
                )}
              </div>`
            : nothing}
        </div>

        <div class="col">
          <div class="card">
            <header>
              <h2>${meta.label} · 校准曲线</h2>
              <span class="sub">${cal.samples} 个样本</span>
            </header>
            <div class="metric-grid">
              <div class="metric">
                <div class="k">当前阈值</div>
                <div class="v">${cal.currentThreshold}</div>
              </div>
              <div class="metric">
                <div class="k">建议阈值</div>
                <div class="v" style="color:var(--accent)">
                  ${cal.suggestedThreshold !== null ? cal.suggestedThreshold : '—'}
                </div>
              </div>
              <div class="metric">
                <div class="k">确认样本</div>
                <div class="v" style="color:var(--ok)">${cal.positives}</div>
              </div>
              <div class="metric">
                <div class="k">误报样本</div>
                <div class="v" style="color:var(--danger)">${cal.negatives}</div>
              </div>
            </div>
            ${cal.expected
              ? html`<div class="metric-grid" style="padding-top:0">
                  <div class="metric">
                    <div class="k">当前准确率</div>
                    <div class="v">${(cal.expected.precision * 100).toFixed(1)}%</div>
                  </div>
                  <div class="metric">
                    <div class="k">当前召回率</div>
                    <div class="v">${(cal.expected.recall * 100).toFixed(1)}%</div>
                  </div>
                  <div class="metric">
                    <div class="k">当前 F1</div>
                    <div class="v">${(cal.expected.f1 * 100).toFixed(1)}%</div>
                  </div>
                  <div class="metric">
                    <div class="k">漏报 / 误报</div>
                    <div class="v">${cal.expected.fn} / ${cal.expected.fp}</div>
                  </div>
                </div>`
              : nothing}
            ${this.feedback.length === 0
              ? html`<div class="empty">
                  校准需要人工标注：<br />
                  误报样本（应被抑制）与确认样本（不应被抑制）。<br />
                  至少各有一条才会给出建议阈值。
                </div>`
              : html`
                  ${this.renderChart(cal)}
                  <div class="warn-note">
                    校准曲线只反映当前标注集合。样本少于 6 条时建议值仅供参考；标注时应保持正负样本数量接近，避免阈值被少数极端样本拉偏。
                  </div>
                `}
            <div class="pad" style="border-top:1px solid var(--line);display:flex;gap:8px;flex-wrap:wrap">
              <button
                class="btn"
                @click=${() => this.dispatchEvent(new CustomEvent('reset-feedback', { bubbles: true, composed: true }))}
              >
                清空全部标注
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderChart(cal: CalibrationResult): TemplateResult {
    const w = 340;
    const h = 150;
    const pad = { l: 30, r: 8, t: 8, b: 20 };
    const maxThr = 100;
    const x = (t: number) => pad.l + ((w - pad.l - pad.r) * t) / maxThr;
    const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v);
    const line = (sel: (p: CalibrationPoint) => number) =>
      cal.curve
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.threshold).toFixed(1)},${y(sel(p)).toFixed(1)}`)
        .join(' ');
    const currentX = x(Math.min(maxThr, Math.max(0, cal.currentThreshold)));
    const suggestedX =
      cal.suggestedThreshold === null
        ? null
        : x(Math.min(maxThr, Math.max(0, cal.suggestedThreshold)));
    const pct = (v: number) => `${((x(v) / w) * 100).toFixed(1)}%`;
    const top = (v: number) => `${((y(v) / h) * 100).toFixed(1)}%`;
    return html`
      <div class="chart">
        <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="阈值校准曲线">
          ${[0, 0.25, 0.5, 0.75, 1].map(
            (v) => html`<line
              x1=${pad.l}
              x2=${w - pad.r}
              y1=${y(v)}
              y2=${y(v)}
              stroke="var(--line)"
              stroke-dasharray="2 3"
            />`,
          )}
          ${[0, 20, 40, 60, 80, 100].map(
            (t) => html`<line
              x1=${x(t)}
              x2=${x(t)}
              y1=${pad.t}
              y2=${h - pad.b}
              stroke="var(--line)"
              stroke-dasharray="2 3"
            />`,
          )}
          <line
            x1=${currentX}
            x2=${currentX}
            y1=${pad.t}
            y2=${h - pad.b}
            stroke="var(--accent)"
            stroke-opacity="0.5"
            stroke-width="1.4"
            stroke-dasharray="4 3"
          />
          ${suggestedX !== null
            ? html`<line
                x1=${suggestedX}
                x2=${suggestedX}
                y1=${pad.t}
                y2=${h - pad.b}
                stroke="var(--ok)"
                stroke-width="1"
                stroke-dasharray="1 3"
              />`
            : nothing}
          <path
            d=${line((p) => p.precision)}
            fill="none"
            stroke="var(--ok)"
            stroke-width="2.2"
            stroke-linejoin="round"
          />
          <path
            d=${line((p) => p.recall)}
            fill="none"
            stroke="var(--danger)"
            stroke-width="2.2"
            stroke-linejoin="round"
          />
        </svg>
        ${[0, 0.25, 0.5, 0.75, 1].map(
          (v) => html`<span class="axis axis-y" style="top:${top(v)}"
            >${(v * 100).toFixed(0)}%</span
          >`,
        )}
        ${[0, 20, 40, 60, 80, 100].map(
          (t) => html`<span class="axis axis-x" style="left:${pct(t)}">${t}</span>`,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'calibration-panel': CalibrationPanel;
  }
}
