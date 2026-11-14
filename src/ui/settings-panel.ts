import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * Settings & transparency panel: documents exactly what is stored, what is
 * hashed, and what leaves the browser (nothing).
 */
@customElement('settings-panel')
export class SettingsPanel extends LitElement {
  @property({ type: Object }) config!: Record<string, number>;
  @property({ type: Number }) docCount = 0;
  @property({ type: Number }) vaultCount = 0;
  @property({ type: Number }) scanCount = 0;
  @property({ type: Number }) feedbackCount = 0;

  @state() private confirmReset = false;

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
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in oklab, var(--bg-raised) 60%, var(--bg));
      font-size: 13.5px;
      font-weight: 620;
    }
    .pad {
      padding: 15px 16px;
      font-size: 12.5px;
      line-height: 1.85;
      color: var(--ink-soft);
    }
    .pad b,
    .pad strong {
      color: var(--ink);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    th,
    td {
      text-align: left;
      padding: 8px 16px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      font-size: 11px;
      color: var(--ink-faint);
      font-weight: 560;
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
    .btn.danger {
      color: var(--danger);
      border-color: color-mix(in oklab, var(--danger) 40%, var(--line));
    }
  `;

  render(): TemplateResult {
    return html`
      <div class="col">
        <div class="card">
          <header>数据存放位置</header>
          <table>
            <tbody>
              <tr>
                <td style="width:190px"><b>受保护文档正文</b></td>
                <td>存于本浏览器的 localStorage（含分段后的令牌），用于重新比对。可在「受保护文档」中逐份移除。</td>
              </tr>
              <tr>
                <td><b>客户名单</b></td>
                <td>仅保存 HMAC-SHA256 加盐哈希及字段名，<b>不保存任何明文值</b>。HMAC 密钥只存在于本次会话的内存中，<b>不写入浏览器存储</b>；刷新页面后需重新导入名单（示例名单可随时重建）。因此拿到本地存储也无法还原客户信息。</td>
              </tr>
              <tr>
                <td><b>外发样本正文</b></td>
                <td>为便于复查，最近 40 次检测的正文会保留在本地存储中；可随时删除检测记录。</td>
              </tr>
              <tr>
                <td><b>网络请求</b></td>
                <td>没有任何上传接口。所有解析、指纹、哈希与比对都在浏览器内完成。</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <header>当前数据量</header>
          <div class="pad">
            受保护文档 <b>${this.docCount}</b> 份 · 客户名单库 <b>${this.vaultCount}</b> 个 ·
            检测记录 <b>${this.scanCount}</b> 条 · 人工标注 <b>${this.feedbackCount}</b> 条
          </div>
        </div>

        <div class="card">
          <header>清空本地数据</header>
          <div class="pad">
            会删除受保护文档、名单哈希、检测记录与全部人工标注。此操作不可撤销。
            <div style="margin-top:12px;display:flex;gap:8px">
              ${this.confirmReset
                ? html`<button
                    class="btn danger"
                    @click=${() => {
                      this.dispatchEvent(new CustomEvent('reset-all', { bubbles: true, composed: true }));
                      this.confirmReset = false;
                    }}
                  >
                    确认清空
                  </button>
                  <button class="btn" @click=${() => (this.confirmReset = false)}>取消</button>`
                : html`<button class="btn danger" @click=${() => (this.confirmReset = true)}>清空本地数据</button>`}
            </div>
          </div>
        </div>

        <div class="card">
          <header>判定参数一览</header>
          <table>
            <thead>
              <tr><th>参数</th><th>值</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr><td>连续指纹窗口</td><td>${this.config.seqK} 令牌</td><td>顺序指纹长度，覆盖整段照抄</td></tr>
              <tr><td>无序指纹窗口</td><td>${this.config.bagWindow} 令牌</td><td>容忍句内语序调整</td></tr>
              <tr><td>段落告警阈值</td><td>${this.config.minSegmentScore}</td><td>相似度得分下限</td></tr>
              <tr><td>字符重合下限</td><td>${this.config.minCharOverlap}</td><td>改写识别门槛</td></tr>
              <tr><td>客户数据阈值</td><td>${this.config.minPiiScore}</td><td>字段组合得分下限</td></tr>
              <tr><td>组合字段数</td><td>${this.config.piiComboFields}</td><td>升级为组合告警所需字段数</td></tr>
              <tr><td>字段邻近范围</td><td>${this.config.piiProximity} 字符</td><td>组合字段的最大间距</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-panel': SettingsPanel;
  }
}
