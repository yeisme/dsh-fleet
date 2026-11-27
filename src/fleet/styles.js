/**
 * Scoped stylesheet for the Fleet Control Room UI.
 * Uses DSH CSS tokens with macOS-inspired dark/light fallbacks, 0.5px hairlines,
 * tabular-nums, 6px status dots, and prefers-reduced-motion support.
 *
 * NOTE: Done status uses `--dsw-alias-state-success-*` (never the deprecated blue token).
 */

export const FLEET_STYLE_ID = 'dsh-fleet-control-room-styles'

export const FLEET_CSS = `
.dsh-fleet-root {
  --fleet-bg: var(--dsw-alias-bg, #141416);
  --fleet-bg-elev: var(--dsw-alias-bg-secondary, #1c1c1f);
  --fleet-bg-subtle: var(--dsw-alias-bg-tertiary, rgba(255, 255, 255, 0.04));
  --fleet-border: var(--dsw-alias-border, rgba(128, 128, 128, 0.22));
  --fleet-text: var(--dsw-alias-text-primary, #f2f2f7);
  --fleet-text-2: var(--dsw-alias-text-secondary, #aeaeb2);
  --fleet-text-3: var(--dsw-alias-text-tertiary, #8e8e93);
  --fleet-accent: var(--dsw-alias-accent, #0a84ff);
  --fleet-c-working: var(--dsw-alias-state-info-primary, #0a84ff);
  --fleet-c-blocked: var(--dsw-alias-state-warning-primary, #ff9f0a);
  --fleet-c-success: var(--dsw-alias-state-success-primary, #30d158);
  --fleet-c-error: var(--dsw-alias-state-error-primary, #ff453a);
  --fleet-c-idle: var(--dsw-alias-text-tertiary, #8e8e93);
  --fleet-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  width: 100%;
  background: var(--fleet-bg);
  color: var(--fleet-text);
  font-size: 13px;
  line-height: 1.45;
  box-sizing: border-box;
  overflow: hidden;
}

.dsh-fleet-root *, .dsh-fleet-root *::before, .dsh-fleet-root *::after {
  box-sizing: border-box;
}

.dsh-fleet-num {
  font-variant-numeric: tabular-nums;
}

/* Top bar & banners */
.dsh-fleet-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
  flex-shrink: 0;
}

.dsh-fleet-topbar-left, .dsh-fleet-topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dsh-fleet-brand {
  font-size: 14px;
  font-weight: 560;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.dsh-fleet-stat-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--fleet-text-2);
}

.dsh-fleet-stat-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.dsh-fleet-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 0.5px solid var(--fleet-border);
  flex-shrink: 0;
}

.dsh-fleet-banner--warn {
  background: color-mix(in srgb, var(--fleet-c-blocked) 10%, var(--fleet-bg));
  color: var(--fleet-text);
}

.dsh-fleet-banner--error {
  background: color-mix(in srgb, var(--fleet-c-error) 12%, var(--fleet-bg));
  color: var(--fleet-text);
}

.dsh-fleet-banner--info {
  background: color-mix(in srgb, var(--fleet-accent) 9%, var(--fleet-bg));
  color: var(--fleet-text);
}

/* 3-pane control room body */
.dsh-fleet-body {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr) 276px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.dsh-fleet-body--no-inspector {
  grid-template-columns: 268px minmax(0, 1fr);
}

@media (max-width: 900px) {
  .dsh-fleet-body {
    grid-template-columns: 224px minmax(0, 1fr);
  }
  .dsh-fleet-inspector {
    display: none;
  }
}

/* 6px status dot */
.dsh-fleet-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--fleet-c-idle);
}

.dsh-fleet-dot--working {
  background: var(--fleet-c-working);
  animation: dsh-fleet-breathe 2s ease-in-out infinite;
}

.dsh-fleet-dot--stalled {
  background: var(--fleet-c-blocked);
}

.dsh-fleet-dot--blocked {
  background: var(--fleet-c-blocked);
}

.dsh-fleet-dot--done {
  background: var(--fleet-c-success);
}

.dsh-fleet-dot--idle {
  background: var(--fleet-c-idle);
}

.dsh-fleet-dot--unknown {
  background: var(--fleet-c-error);
}

@keyframes dsh-fleet-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* Buttons & pills */
.dsh-fleet-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  color: var(--fleet-text);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  cursor: pointer;
  white-space: nowrap;
  transition: background 120ms ease-out, border-color 120ms ease-out;
}

.dsh-fleet-btn:hover:not(:disabled) {
  background: var(--fleet-bg-subtle);
  border-color: color-mix(in srgb, var(--fleet-text) 28%, transparent);
}

.dsh-fleet-btn:focus-visible {
  outline: 2px solid var(--fleet-accent);
  outline-offset: 1px;
}

.dsh-fleet-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dsh-fleet-btn--primary {
  background: var(--fleet-accent);
  border-color: var(--fleet-accent);
  color: #ffffff;
}

.dsh-fleet-btn--primary:hover:not(:disabled) {
  filter: brightness(1.08);
  background: var(--fleet-accent);
}

.dsh-fleet-btn--danger {
  color: var(--fleet-c-error);
  border-color: color-mix(in srgb, var(--fleet-c-error) 45%, transparent);
}

.dsh-fleet-btn--active {
  background: color-mix(in srgb, var(--fleet-accent) 16%, var(--fleet-bg));
  border-color: color-mix(in srgb, var(--fleet-accent) 55%, transparent);
  color: var(--fleet-text);
}

.dsh-fleet-btn--sm {
  padding: 2px 7px;
  font-size: 11px;
}

.dsh-fleet-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.4;
  border: 0.5px solid var(--fleet-border);
  color: var(--fleet-text-2);
  background: var(--fleet-bg-subtle);
  white-space: nowrap;
}

.dsh-fleet-pill--passed {
  color: var(--fleet-c-success);
  border-color: color-mix(in srgb, var(--fleet-c-success) 40%, transparent);
}

.dsh-fleet-pill--failed {
  color: var(--fleet-c-error);
  border-color: color-mix(in srgb, var(--fleet-c-error) 45%, transparent);
}

.dsh-fleet-pill--running {
  color: var(--fleet-c-working);
  border-color: color-mix(in srgb, var(--fleet-c-working) 40%, transparent);
}

.dsh-fleet-pill--stale {
  color: var(--fleet-c-blocked);
  border-color: color-mix(in srgb, var(--fleet-c-blocked) 40%, transparent);
}

.dsh-fleet-select {
  padding: 3px 6px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  color: var(--fleet-text);
  font-size: 11px;
}

/* Roster (Left Column) */
.dsh-fleet-roster {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
}

.dsh-fleet-roster-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 0.5px solid var(--fleet-border);
  flex-shrink: 0;
}

.dsh-fleet-search {
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  color: var(--fleet-text);
  font-size: 12px;
  outline: none;
}

.dsh-fleet-search:focus {
  border-color: var(--fleet-accent);
}

.dsh-fleet-filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
}

.dsh-fleet-roster-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 6px 10px;
}

.dsh-fleet-group {
  margin-bottom: 8px;
}

.dsh-fleet-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  font-size: 11px;
  font-weight: 560;
  color: var(--fleet-text-3);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  user-select: none;
}

.dsh-fleet-group-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: none;
  border: none;
  color: var(--fleet-text-3);
  font-size: 11px;
  font-weight: 560;
  padding: 4px 6px;
  cursor: pointer;
  text-align: left;
}

.dsh-fleet-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 7px 8px;
  margin-bottom: 2px;
  border-radius: 6px;
  border: 0.5px solid transparent;
  background: transparent;
  color: var(--fleet-text);
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease-out;
}

.dsh-fleet-row:hover {
  background: var(--fleet-bg-subtle);
}

.dsh-fleet-row--selected {
  background: color-mix(in srgb, var(--fleet-accent) 14%, var(--fleet-bg));
  border-color: color-mix(in srgb, var(--fleet-accent) 36%, transparent);
}

.dsh-fleet-row--blocked:not(.dsh-fleet-row--selected) {
  background: color-mix(in srgb, var(--fleet-c-blocked) 4%, transparent);
}

.dsh-fleet-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dsh-fleet-row-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 540;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-fleet-row-time {
  font-size: 11px;
  color: var(--fleet-text-3);
  flex-shrink: 0;
}

.dsh-fleet-row-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fleet-text-2);
  min-width: 0;
}

.dsh-fleet-row-summary {
  font-size: 12px;
  color: var(--fleet-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-fleet-shells-footer {
  border-top: 0.5px solid var(--fleet-border);
  padding: 6px 8px;
  flex-shrink: 0;
  max-height: 180px;
  overflow-y: auto;
}

/* Center Stage */
.dsh-fleet-stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--fleet-bg);
}

.dsh-fleet-stage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 0.5px solid var(--fleet-border);
  flex-shrink: 0;
}

.dsh-fleet-stage-title-wrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.dsh-fleet-stage-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 15px;
  font-weight: 590;
  min-width: 0;
}

.dsh-fleet-stage-title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-fleet-stage-sub {
  font-size: 11px;
  color: var(--fleet-text-3);
  font-family: var(--fleet-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-fleet-stage-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.dsh-fleet-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 14px;
  border-bottom: 0.5px solid var(--fleet-border);
  flex-shrink: 0;
}

.dsh-fleet-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  background: none;
  border: none;
  color: var(--fleet-text-2);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.dsh-fleet-tab--active {
  color: var(--fleet-text);
}

.dsh-fleet-tab--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 2px;
  background: var(--fleet-accent);
  border-radius: 2px 2px 0 0;
}

/* Blocked Approval Fast-Path */
.dsh-fleet-approval {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--fleet-border);
  background: color-mix(in srgb, var(--fleet-c-blocked) 8%, var(--fleet-bg));
  flex-shrink: 0;
}

.dsh-fleet-approval-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 560;
}

.dsh-fleet-approval-screen {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  font-family: var(--fleet-mono);
  font-size: 11px;
  line-height: 1.4;
  max-height: 140px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.dsh-fleet-approval-keys {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dsh-fleet-approval-form {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dsh-fleet-approval-input {
  flex: 1 1 auto;
  padding: 5px 8px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  color: var(--fleet-text);
  font-size: 12px;
  outline: none;
}

.dsh-fleet-approval-input:focus {
  border-color: var(--fleet-accent);
}

/* Stage scroll content */
.dsh-fleet-stage-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Frames */
.dsh-fleet-frame-session {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border-radius: 6px;
  background: var(--fleet-bg-subtle);
  border: 0.5px solid var(--fleet-border);
  font-size: 11px;
  color: var(--fleet-text-3);
  font-family: var(--fleet-mono);
}

.dsh-fleet-frame-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 11px;
  border-radius: 8px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  word-break: break-word;
  overflow-wrap: anywhere;
}

.dsh-fleet-frame-text--user {
  background: color-mix(in srgb, var(--fleet-accent) 9%, var(--fleet-bg-elev));
  border-color: color-mix(in srgb, var(--fleet-accent) 26%, transparent);
}

.dsh-fleet-frame-role {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 560;
  color: var(--fleet-text-3);
}

.dsh-fleet-md p { margin: 0 0 6px; }
.dsh-fleet-md p:last-child { margin-bottom: 0; }
.dsh-fleet-md h1, .dsh-fleet-md h2, .dsh-fleet-md h3 {
  margin: 8px 0 4px;
  font-size: 14px;
  font-weight: 590;
}
.dsh-fleet-md ul, .dsh-fleet-md ol {
  margin: 4px 0 6px;
  padding-left: 18px;
}
.dsh-fleet-md blockquote {
  margin: 6px 0;
  padding: 2px 10px;
  border-left: 2px solid var(--fleet-border);
  color: var(--fleet-text-2);
}
.dsh-fleet-md code {
  font-family: var(--fleet-mono);
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--fleet-bg-subtle);
  word-break: break-all;
}
.dsh-fleet-md pre {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--fleet-bg);
  border: 0.5px solid var(--fleet-border);
  overflow-x: auto;
  font-family: var(--fleet-mono);
  font-size: 12px;
  line-height: 1.45;
}
.dsh-fleet-md pre code {
  padding: 0;
  background: none;
  word-break: normal;
}
.dsh-fleet-md table {
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 12px;
  width: 100%;
}
.dsh-fleet-md th, .dsh-fleet-md td {
  border: 0.5px solid var(--fleet-border);
  padding: 4px 8px;
  text-align: left;
}
.dsh-fleet-md a {
  color: var(--fleet-accent);
  text-decoration: none;
}
.dsh-fleet-md a:hover {
  text-decoration: underline;
}

.dsh-fleet-frame-reasoning {
  border: 0.5px solid var(--fleet-border);
  border-radius: 6px;
  padding: 5px 9px;
  background: var(--fleet-bg-subtle);
  font-size: 12px;
  color: var(--fleet-text-2);
}

.dsh-fleet-frame-reasoning summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--fleet-text-3);
  user-select: none;
}

.dsh-fleet-frame-work {
  border: 0.5px solid var(--fleet-border);
  border-radius: 8px;
  background: var(--fleet-bg-elev);
  overflow: hidden;
}

.dsh-fleet-work-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--fleet-border);
  font-size: 12px;
  font-weight: 540;
}

.dsh-fleet-work-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 56px 56px;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  font-size: 12px;
  border-bottom: 0.5px solid color-mix(in srgb, var(--fleet-border) 55%, transparent);
}

.dsh-fleet-work-row:last-child {
  border-bottom: none;
}

.dsh-fleet-work-verb {
  font-family: var(--fleet-mono);
  font-size: 11px;
  color: var(--fleet-text-2);
}

.dsh-fleet-work-obj {
  font-family: var(--fleet-mono);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-fleet-frame-final {
  padding: 9px 12px;
  border-radius: 8px;
  border: 0.5px solid color-mix(in srgb, var(--fleet-c-success) 40%, transparent);
  background: color-mix(in srgb, var(--fleet-c-success) 7%, var(--fleet-bg-elev));
}

/* Live Screen */
.dsh-fleet-screen-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1 1 auto;
}

.dsh-fleet-screen-pre {
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  border: 0.5px solid var(--fleet-border);
  background: #0d0d0f;
  color: #e5e5ea;
  font-family: var(--fleet-mono);
  font-size: 12px;
  line-height: 1.42;
  overflow: auto;
  flex: 1 1 auto;
  min-height: 180px;
  white-space: pre;
}

.dsh-fleet-keybar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 6px 0 2px;
}

/* Composer & Read-Only Handoff Footer */
.dsh-fleet-footer {
  border-top: 0.5px solid var(--fleet-border);
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--fleet-bg);
  flex-shrink: 0;
}

.dsh-fleet-prompt-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.dsh-fleet-prompt-textarea {
  flex: 1 1 auto;
  min-height: 36px;
  max-height: 140px;
  padding: 7px 10px;
  border-radius: 10px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  color: var(--fleet-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  resize: vertical;
  outline: none;
}

.dsh-fleet-prompt-textarea:focus {
  border-color: var(--fleet-accent);
}

.dsh-fleet-readonly-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--fleet-bg-subtle);
  border: 0.5px solid var(--fleet-border);
  font-size: 12px;
  color: var(--fleet-text-2);
}

.dsh-fleet-handoff {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.dsh-fleet-handoff-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Confirm inline bar */
.dsh-fleet-confirm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 14px;
  border-bottom: 0.5px solid var(--fleet-border);
  background: color-mix(in srgb, var(--fleet-c-error) 10%, var(--fleet-bg));
  font-size: 12px;
}

/* Inspector (Right Column) */
.dsh-fleet-inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
  overflow-y: auto;
  padding: 12px;
  gap: 14px;
}

.dsh-fleet-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dsh-fleet-section-title {
  font-size: 11px;
  font-weight: 560;
  color: var(--fleet-text-3);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.dsh-fleet-kv {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 4px 8px;
  font-size: 12px;
}

.dsh-fleet-kv-k {
  color: var(--fleet-text-3);
}

.dsh-fleet-kv-v {
  color: var(--fleet-text);
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
}

.dsh-fleet-check-step {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  font-size: 12px;
}

.dsh-fleet-check-excerpt {
  margin: 4px 0 0;
  padding: 8px;
  border-radius: 6px;
  background: var(--fleet-bg-elev);
  border: 0.5px solid color-mix(in srgb, var(--fleet-c-error) 40%, transparent);
  font-family: var(--fleet-mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow: auto;
}

.dsh-fleet-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 36px 20px;
  text-align: center;
  color: var(--fleet-text-2);
  flex: 1 1 auto;
}

/* Source filter pills, policy lock selector & bot badge */
.dsh-fleet-roster-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.dsh-fleet-roster-head .dsh-fleet-search {
  flex: 1 1 120px;
  min-width: 0;
}

.dsh-fleet-roster-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.dsh-fleet-source-pills {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 7px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  gap: 2px;
}

.dsh-fleet-source-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--fleet-text-2);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease-out, color 120ms ease-out;
}

.dsh-fleet-source-pill:hover {
  color: var(--fleet-text);
  background: var(--fleet-bg-subtle);
}

.dsh-fleet-source-pill--active {
  background: color-mix(in srgb, var(--fleet-accent) 18%, var(--fleet-bg));
  color: var(--fleet-text);
}

.dsh-fleet-pill--bot {
  color: var(--fleet-accent);
  border-color: color-mix(in srgb, var(--fleet-accent) 42%, transparent);
}

.dsh-fleet-policy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-top: 2px;
}

.dsh-fleet-policy-label {
  font-size: 11px;
  color: var(--fleet-text-2);
  white-space: nowrap;
}

.dsh-fleet-policy-select {
  flex: 1 1 auto;
  max-width: 148px;
}

.dsh-fleet-policy-select--read-only {
  border-color: color-mix(in srgb, var(--fleet-c-blocked) 50%, transparent);
  color: var(--fleet-c-blocked);
}

.dsh-fleet-policy-select--dsh-only {
  border-color: color-mix(in srgb, var(--fleet-accent) 45%, transparent);
}

.dsh-fleet-policy-select--all {
  border-color: color-mix(in srgb, var(--fleet-c-success) 45%, transparent);
}

/* Inline Handoff Composer */
.dsh-fleet-handoff-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
}

.dsh-fleet-handoff-composer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.dsh-fleet-handoff-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fleet-text-2);
}

.dsh-fleet-handoff-textarea {
  width: 100%;
  min-height: 84px;
  max-height: 180px;
  padding: 7px 9px;
  border-radius: 7px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
  color: var(--fleet-text);
  font-family: var(--fleet-mono);
  font-size: 12px;
  line-height: 1.45;
  resize: vertical;
  outline: none;
}

.dsh-fleet-handoff-textarea:focus {
  border-color: var(--fleet-accent);
}

.dsh-fleet-handoff-composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* Toast bar */
.dsh-fleet-toast {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 12px;
  font-size: 12px;
  border-bottom: 0.5px solid var(--fleet-border);
  flex-shrink: 0;
}

.dsh-fleet-toast--success {
  background: color-mix(in srgb, var(--fleet-c-success) 10%, var(--fleet-bg));
  color: var(--fleet-text);
}

.dsh-fleet-toast--error {
  background: color-mix(in srgb, var(--fleet-c-error) 12%, var(--fleet-bg));
  color: var(--fleet-text);
}

.dsh-fleet-toast--info {
  background: color-mix(in srgb, var(--fleet-accent) 10%, var(--fleet-bg));
  color: var(--fleet-text);
}

.dsh-fleet-toast-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* Inline External Bot Connect Drawer */
.dsh-fleet-bot-drawer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  flex-shrink: 0;
}

.dsh-fleet-bot-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.dsh-fleet-bot-drawer-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

@media (max-width: 900px) {
  .dsh-fleet-bot-drawer-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.dsh-fleet-bot-snippet {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.dsh-fleet-bot-snippet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--fleet-text-2);
}

.dsh-fleet-bot-pre {
  margin: 0;
  padding: 8px 10px;
  border-radius: 7px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
  color: var(--fleet-text-2);
  font-family: var(--fleet-mono);
  font-size: 11px;
  line-height: 1.45;
  overflow-x: auto;
  white-space: pre;
}

.dsh-fleet-bot-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.dsh-fleet-bot-form-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.dsh-fleet-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--fleet-text-2);
}

.dsh-fleet-input {
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
  color: var(--fleet-text);
  font-size: 12px;
  outline: none;
}

.dsh-fleet-input:focus {
  border-color: var(--fleet-accent);
}

.dsh-fleet-bot-error {
  font-size: 11px;
  color: var(--fleet-c-error);
}

.dsh-fleet-bot-form-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* Inline Spawn Agent Drawer */
.dsh-fleet-spawn-drawer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg-elev);
  flex-shrink: 0;
}

.dsh-fleet-spawn-grid {
  display: grid;
  grid-template-columns: 120px minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 8px;
}

@media (max-width: 720px) {
  .dsh-fleet-spawn-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.dsh-fleet-spawn-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fleet-text);
  cursor: pointer;
  user-select: none;
  flex-wrap: wrap;
}

.dsh-fleet-spawn-check input[type="checkbox"] {
  accent-color: var(--fleet-accent);
  margin: 0;
}

.dsh-fleet-spawn-hint {
  font-size: 11px;
  color: var(--fleet-text-3);
  font-family: var(--fleet-mono);
}

.dsh-fleet-spawn-textarea {
  width: 100%;
  min-height: 48px;
  max-height: 140px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
  color: var(--fleet-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.45;
  resize: vertical;
  outline: none;
}

.dsh-fleet-spawn-textarea:focus {
  border-color: var(--fleet-accent);
}

/* Compact 24px bottom keyboard hint strip */
.dsh-fleet-hintbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 24px;
  padding: 0 12px;
  border-top: 0.5px solid var(--fleet-border);
  background: var(--fleet-bg);
  color: var(--fleet-text-3);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  user-select: none;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-fleet-dot--working {
    animation: none;
  }
  .dsh-fleet-btn, .dsh-fleet-row, .dsh-fleet-source-pill {
    transition: none;
  }
}
`

export function ensureFleetStyles(doc = globalThis.document) {
  if (!doc || !doc.head) return
  if (typeof doc.getElementById === 'function' && doc.getElementById(FLEET_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = FLEET_STYLE_ID
  style.setAttribute('data-dsh-fleet-styles', '1')
  style.textContent = FLEET_CSS
  doc.head.appendChild(style)
}
