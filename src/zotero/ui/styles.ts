export const ZV_STYLE_ID = 'zotero-vectorize-ui-styles';

export const ZV_UI_CSS = `
:root {
  --zv-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
  --zv-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --zv-bg: #FAF9F6;
  --zv-bg-elevated: #FFFFFF;
  --zv-bg-hover: #F5F2EB;
  --zv-bg-active: #EFEAE0;
  --zv-bg-pill: #EFECE5;
  --zv-border: rgba(25, 24, 22, 0.10);
  --zv-border-strong: rgba(25, 24, 22, 0.18);
  --zv-ink: #191816;
  --zv-ink-secondary: #5D5952;
  --zv-ink-muted: #888278;
  --zv-accent: #D97757;
  --zv-accent-hover: #C46242;
  --zv-accent-soft: rgba(217, 119, 87, 0.13);
  --zv-accent-border: rgba(217, 119, 87, 0.34);
  --zv-mark-bg: rgba(217, 119, 87, 0.22);
  --zv-mark-ink: #8E371B;
  --zv-teal-soft: rgba(34, 139, 120, 0.12);
  --zv-teal-ink: #17695A;
  --zv-warn-bg: #FFF7ED;
  --zv-warn-border: rgba(217, 119, 87, 0.28);
  --zv-warn-ink: #9A4122;
  --zv-shadow-lg: 0 20px 48px -12px rgba(20, 18, 15, 0.22), 0 4px 14px rgba(20, 18, 15, 0.08);
  --zv-shadow-xl: 0 28px 64px -12px rgba(15, 14, 12, 0.34), 0 8px 24px rgba(15, 14, 12, 0.14);
}

@media (prefers-color-scheme: dark) {
  :root {
    --zv-bg: #1E1D1B;
    --zv-bg-elevated: #252421;
    --zv-bg-hover: #2E2C28;
    --zv-bg-active: #36332E;
    --zv-bg-pill: #2C2A26;
    --zv-border: rgba(255, 255, 255, 0.10);
    --zv-border-strong: rgba(255, 255, 255, 0.18);
    --zv-ink: #F2EFE9;
    --zv-ink-secondary: #B9B3A9;
    --zv-ink-muted: #8C867C;
    --zv-accent: #E2896B;
    --zv-accent-hover: #EB9A7F;
    --zv-accent-soft: rgba(226, 137, 107, 0.16);
    --zv-accent-border: rgba(226, 137, 107, 0.38);
    --zv-mark-bg: rgba(226, 137, 107, 0.26);
    --zv-mark-ink: #FFD5C4;
    --zv-teal-soft: rgba(74, 200, 174, 0.14);
    --zv-teal-ink: #6CD7C1;
    --zv-warn-bg: rgba(226, 137, 107, 0.10);
    --zv-warn-border: rgba(226, 137, 107, 0.28);
    --zv-warn-ink: #F7B79F;
    --zv-shadow-lg: 0 20px 52px -10px rgba(0, 0, 0, 0.56), 0 4px 16px rgba(0, 0, 0, 0.35);
    --zv-shadow-xl: 0 28px 72px -10px rgba(0, 0, 0, 0.72), 0 8px 28px rgba(0, 0, 0, 0.48);
  }
}

/* Strip native XUL panel chrome */
panel#zv-search-panel {
  --panel-background: transparent;
  --panel-border-color: transparent;
  --panel-border-radius: 16px;
  --panel-padding: 0px;
  --panel-shadow: none;
  appearance: none;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  box-shadow: none;
}

.zv-popover {
  font-family: var(--zv-font);
  color: var(--zv-ink);
  background: var(--zv-bg);
  border: 1px solid var(--zv-border-strong);
  border-radius: 16px;
  box-shadow: var(--zv-shadow-lg);
  width: 600px;
  max-width: min(92vw, 660px);
  max-height: min(540px, 76vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  margin: 6px;
}

.zv-popover *, .zv-palette-dialog *, .zv-item-pane-box * {
  box-sizing: border-box;
  font-family: var(--zv-font);
}

.zv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  background: var(--zv-bg-elevated);
  border-bottom: 1px solid var(--zv-border);
  flex-wrap: wrap;
}

.zv-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.zv-brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--zv-accent);
  flex-shrink: 0;
  box-shadow: 0 0 0 3px var(--zv-accent-soft);
}

.zv-brand-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--zv-ink);
}

.zv-status-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--zv-bg-pill);
  color: var(--zv-ink-secondary);
  border: 1px solid var(--zv-border);
  white-space: nowrap;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.zv-status-pill.is-neural {
  background: var(--zv-teal-soft);
  color: var(--zv-teal-ink);
  border-color: transparent;
}

.zv-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.zv-segmented {
  display: inline-flex;
  align-items: center;
  background: var(--zv-bg-pill);
  border-radius: 9px;
  padding: 2px;
  border: 1px solid var(--zv-border);
}

.zv-seg-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--zv-ink-secondary);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 9px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
  white-space: nowrap;
}

.zv-seg-btn:hover {
  color: var(--zv-ink);
}

.zv-seg-btn.is-active {
  background: var(--zv-bg-elevated);
  color: var(--zv-ink);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.zv-icon-btn, .zv-scope-btn {
  appearance: none;
  border: 1px solid var(--zv-border);
  background: var(--zv-bg-elevated);
  color: var(--zv-ink-secondary);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.14s ease;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.zv-icon-btn:hover, .zv-scope-btn:hover {
  border-color: var(--zv-border-strong);
  color: var(--zv-ink);
  background: var(--zv-bg-hover);
}

.zv-scope-btn.is-active {
  background: var(--zv-accent-soft);
  color: var(--zv-accent);
  border-color: var(--zv-accent-border);
}

.zv-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  background: var(--zv-warn-bg);
  border-bottom: 1px solid var(--zv-warn-border);
  color: var(--zv-warn-ink);
  font-size: 12px;
  line-height: 1.4;
}

.zv-banner-btn {
  appearance: none;
  border: 1px solid var(--zv-accent-border);
  background: var(--zv-bg-elevated);
  color: var(--zv-accent);
  font-size: 11.5px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
  flex-shrink: 0;
}

.zv-banner-btn:hover {
  background: var(--zv-accent);
  color: #FFFFFF;
}

.zv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.zv-list::-webkit-scrollbar {
  width: 6px;
}

.zv-list::-webkit-scrollbar-thumb {
  background: var(--zv-border-strong);
  border-radius: 999px;
}

.zv-card {
  background: var(--zv-bg-elevated);
  border: 1px solid var(--zv-border);
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.1s ease;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.zv-card:hover {
  background: var(--zv-bg-hover);
  border-color: var(--zv-border-strong);
}

.zv-card.is-selected {
  background: var(--zv-bg-hover);
  border-color: var(--zv-accent);
  box-shadow: 0 0 0 2px var(--zv-accent-soft);
}

.zv-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.zv-card-title {
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.38;
  color: var(--zv-ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.zv-card-badges {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.zv-badge {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
}

.zv-badge-score {
  background: var(--zv-bg-pill);
  color: var(--zv-ink-secondary);
  font-family: var(--zv-mono);
}

.zv-badge-cross {
  background: var(--zv-accent-soft);
  color: var(--zv-accent);
}

.zv-card-meta {
  font-size: 11.5px;
  color: var(--zv-ink-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.zv-snippet-box {
  background: var(--zv-bg);
  border: 1px solid var(--zv-border);
  border-left: 2.5px solid var(--zv-accent);
  border-radius: 8px;
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.zv-snippet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--zv-ink-muted);
}

.zv-page-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--zv-accent-soft);
  color: var(--zv-accent);
  font-weight: 600;
  font-size: 11px;
  padding: 1.5px 7px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
}

.zv-page-pill:hover {
  border-color: var(--zv-accent-border);
}

.zv-snippet-text {
  font-size: 12px;
  line-height: 1.52;
  color: var(--zv-ink-secondary);
  word-break: break-word;
}

.zv-mark {
  background: var(--zv-mark-bg);
  color: var(--zv-mark-ink);
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 500;
}

.zv-extra-pages {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}

.zv-extra-page-btn {
  appearance: none;
  border: 1px solid var(--zv-border);
  background: var(--zv-bg-elevated);
  color: var(--zv-ink-secondary);
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 6px;
  cursor: pointer;
}

.zv-extra-page-btn:hover {
  border-color: var(--zv-accent);
  color: var(--zv-accent);
}

.zv-card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.zv-mini-action {
  appearance: none;
  border: 1px solid var(--zv-border);
  background: transparent;
  color: var(--zv-ink-secondary);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.zv-mini-action:hover {
  background: var(--zv-bg-pill);
  color: var(--zv-ink);
}

.zv-mini-action.is-primary {
  background: var(--zv-accent);
  border-color: var(--zv-accent);
  color: #FFFFFF;
}

.zv-mini-action.is-primary:hover {
  background: var(--zv-accent-hover);
}

.zv-empty {
  padding: 28px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.zv-empty-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--zv-ink);
}

.zv-empty-desc {
  font-size: 12px;
  color: var(--zv-ink-muted);
  max-width: 380px;
  line-height: 1.5;
}

.zv-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 14px;
  background: var(--zv-bg-elevated);
  border-top: 1px solid var(--zv-border);
  font-size: 11px;
  color: var(--zv-ink-muted);
}

.zv-diag {
  font-family: var(--zv-mono);
  font-size: 10.5px;
  white-space: nowrap;
}

/* Command Palette Modal */
#zv-palette-backdrop {
  position: fixed;
  inset: 0;
  z-index: 99990;
  background: rgba(18, 17, 15, 0.36);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 9vh;
  animation: zvFadeIn 0.12s ease-out;
}

@keyframes zvFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.zv-palette-dialog {
  font-family: var(--zv-font);
  color: var(--zv-ink);
  background: var(--zv-bg);
  border: 1px solid var(--zv-border-strong);
  border-radius: 18px;
  box-shadow: var(--zv-shadow-xl);
  width: min(740px, 92vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.zv-palette-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  background: var(--zv-bg-elevated);
  border-bottom: 1px solid var(--zv-border);
}

.zv-palette-search-icon {
  color: var(--zv-accent);
  font-size: 15px;
  font-weight: 700;
  flex-shrink: 0;
}

.zv-palette-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--zv-ink);
  font-size: 15px;
  line-height: 1.4;
  min-width: 0;
}

.zv-palette-input::placeholder {
  color: var(--zv-ink-muted);
}

.zv-kbd {
  font-family: var(--zv-mono);
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--zv-bg-pill);
  border: 1px solid var(--zv-border);
  color: var(--zv-ink-secondary);
}

/* Item Pane Similar Papers Section */
.zv-item-pane-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
}

.zv-similar-card {
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--zv-border);
  background: var(--zv-bg-elevated);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.zv-similar-card:hover {
  background: var(--zv-bg-hover);
  border-color: var(--zv-accent-border);
}

.zv-similar-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zv-ink);
  line-height: 1.35;
}

.zv-similar-meta {
  font-size: 11px;
  color: var(--zv-ink-muted);
  display: flex;
  justify-content: space-between;
  gap: 6px;
}
`;

export function injectWindowStyles(win: Window): void {
  const doc = win.document;
  if (!doc || doc.getElementById(ZV_STYLE_ID)) return;
  const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
  style.id = ZV_STYLE_ID;
  style.textContent = ZV_UI_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

export function removeWindowStyles(win: Window): void {
  const doc = win.document;
  doc?.getElementById(ZV_STYLE_ID)?.remove();
}
