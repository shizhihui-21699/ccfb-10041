import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'none';

const TONE: Record<Severity, string> = {
  critical: 'var(--danger)',
  high: 'var(--warn)',
  medium: '#8a7328',
  low: 'var(--ink-faint)',
  none: 'var(--ink-faint)',
};

@customElement('sev-badge')
export class SevBadge extends LitElement {
  @property({ type: String }) severity: Severity = 'low';
  @property({ type: String }) label = '';

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11.5px;
      font-weight: 640;
      letter-spacing: 0.02em;
      padding: 2px 8px 2px 6px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex: none;
    }
  `;

  render(): TemplateResult {
    const labels: Record<Severity, string> = {
      critical: '严重',
      high: '高',
      medium: '中',
      low: '低',
      none: '—',
    };
    const color = TONE[this.severity] ?? TONE.low;
    return html`<span
      class="dot"
      style="background:${color}"
    ></span><span style="color:${color}">${this.label || labels[this.severity]}</span>`;
  }
}

@customElement('stat-pill')
export class StatPill extends LitElement {
  @property({ type: String }) label = '';
  @property({ type: String }) value = '';
  @property({ type: String }) hint = '';
  @property({ type: String }) tone = 'ink';

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 14px;
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      min-width: 118px;
    }
    .label {
      font-size: 11px;
      color: var(--ink-faint);
      letter-spacing: 0.03em;
    }
    .value {
      font-size: 19px;
      font-weight: 660;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .hint {
      font-size: 11px;
      color: var(--ink-faint);
    }
  `;

  render(): TemplateResult {
    const color =
      this.tone === 'danger'
        ? 'var(--danger)'
        : this.tone === 'warn'
          ? 'var(--warn)'
          : this.tone === 'ok'
            ? 'var(--ok)'
            : this.tone === 'accent'
              ? 'var(--accent)'
              : 'var(--ink)';
    return html`
      <span class="label">${this.label}</span>
      <span class="value" style="color:${color}">${this.value}</span>
      ${this.hint ? html`<span class="hint">${this.hint}</span>` : ''}
    `;
  }
}

@customElement('meter-bar')
export class MeterBar extends LitElement {
  @property({ type: Number }) value = 0;
  @property({ type: String }) tone = 'accent';
  @property({ type: Boolean }) thin = false;

  static styles = css`
    :host {
      display: block;
      height: 6px;
      background: var(--bg-sunken);
      border-radius: 4px;
      overflow: hidden;
    }
    :host([thin]) {
      height: 3px;
    }
    .fill {
      height: 100%;
      border-radius: 4px;
      transition: width 220ms ease;
    }
  `;

  render(): TemplateResult {
    const color =
      this.tone === 'danger'
        ? 'var(--danger)'
        : this.tone === 'warn'
          ? 'var(--warn)'
          : this.tone === 'ok'
            ? 'var(--ok)'
            : 'var(--accent)';
    return html`<div
      class="fill"
      style="width:${Math.max(0, Math.min(100, this.value))}%;background:${color}"
    ></div>`;
  }
}

@customElement('empty-state')
export class EmptyState extends LitElement {
  @property({ type: String }) title = '';
  @property({ type: String }) body = '';

  static styles = css`
    :host {
      display: block;
      text-align: center;
      padding: 40px 24px;
      color: var(--ink-soft);
    }
    h3 {
      font-size: 15px;
      margin-bottom: 6px;
      color: var(--ink);
    }
    p {
      margin: 0 auto;
      max-width: 460px;
      font-size: 13px;
      line-height: 1.7;
      color: var(--ink-faint);
    }
    slot {
      display: block;
      margin-top: 14px;
    }
  `;

  render(): TemplateResult {
    return html`<h3>${this.title}</h3><p>${this.body}</p><slot></slot>`;
  }
}

@customElement('panel-card')
export class PanelCard extends LitElement {
  @property({ type: String }) heading = '';
  @property({ type: String }) sub = '';

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--bg-raised);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      overflow: hidden;
      min-height: 0;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 16px 11px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in oklab, var(--bg-raised) 60%, var(--bg));
    }
    h2 {
      font-size: 13.5px;
      letter-spacing: 0.01em;
    }
    .sub {
      font-size: 11.5px;
      color: var(--ink-faint);
    }
    .body {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
  `;

  render(): TemplateResult {
    return html`
      <header>
        <h2>${this.heading}</h2>
        ${this.sub ? html`<span class="sub">${this.sub}</span>` : ''}
      </header>
      <div class="body"><slot></slot></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sev-badge': SevBadge;
    'stat-pill': StatPill;
    'meter-bar': MeterBar;
    'empty-state': EmptyState;
    'panel-card': PanelCard;
  }
}
