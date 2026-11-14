import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Highlighted text renderer: takes raw text plus spans and renders the spans
 * with <mark> so reviewers can see exactly which characters triggered an
 * alert. Everything is escaped by Lit, so document content cannot inject HTML.
 */
export interface HighlightSpan {
  start: number;
  end: number;
  tone?: 'hit' | 'pii' | 'active';
  title?: string;
}

@customElement('text-highlight')
export class TextHighlight extends LitElement {
  @property({ type: String }) text = '';
  @property({ type: Array }) spans: HighlightSpan[] = [];
  @property({ type: Number }) activeIndex = -1;
  @property({ type: Boolean }) clamp = false;

  static styles = css`
    :host {
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--font-serif);
      font-size: 13.5px;
      line-height: 1.85;
      color: var(--ink);
    }
    mark {
      background: color-mix(in oklab, var(--warn) 26%, transparent);
      border-radius: 3px;
      padding: 0 1px;
      box-decoration-break: clone;
      color: inherit;
    }
    mark.pii {
      background: color-mix(in oklab, var(--danger) 20%, transparent);
    }
    mark.active {
      background: color-mix(in oklab, var(--warn) 55%, transparent);
      outline: 1px solid color-mix(in oklab, var(--warn) 70%, black);
    }
    .void {
      color: var(--ink-faint);
    }
  `;

  private build() {
    const text = this.text;
    const spans = [...this.spans]
      .filter((s) => s.end > s.start && s.start < text.length)
      .map((s) => ({
        ...s,
        start: Math.max(0, s.start),
        end: Math.min(text.length, s.end),
      }))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    // Merge overlaps so we never emit nested <mark>.
    const merged: { start: number; end: number; tones: Set<string>; title?: string; active: boolean }[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) {
        last.end = Math.max(last.end, s.end);
        if (s.tone) last.tones.add(s.tone);
        if (s.tone === 'active') last.active = true;
        if (!last.title && s.title) last.title = s.title;
      } else {
        merged.push({
          start: s.start,
          end: s.end,
          tones: new Set(s.tone ? [s.tone] : []),
          title: s.title,
          active: s.tone === 'active',
        });
      }
    }
    const out: unknown[] = [];
    let cursor = 0;
    let i = 0;
    for (const span of merged) {
      if (span.start > cursor) out.push(text.slice(cursor, span.start));
      const cls = [span.tones.has('pii') ? 'pii' : '', span.active ? 'active' : '']
        .filter(Boolean)
        .join(' ');
      out.push(
        html`<mark class=${cls} title=${span.title ?? ''} data-i=${i}>${text.slice(span.start, span.end)}</mark>`,
      );
      cursor = span.end;
      i++;
    }
    if (cursor < text.length) out.push(text.slice(cursor));
    return out;
  }

  render() {
    return html`${this.build()}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'text-highlight': TextHighlight;
  }
}
