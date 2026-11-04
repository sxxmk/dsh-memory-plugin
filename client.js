window.__ModuleLoader__.load({
  id: '@local/dsh-memory-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** How often the overlay asks the Host for a pending memory batch. */
    const POLL_INTERVAL_MS = 1500;


    /** Host routes. Relative paths keep reverse-proxy/desktop prefixes working. */
    const PENDING_ROUTE = 'dsh-memory-plugin/pending';
    const DECIDE_ROUTE = 'dsh-memory-plugin/decide';

    /** File the Host writes the remembered points into. */
    const MEMORY_FILE = 'MEMORY.md';

    /** Every visible string, in both supported languages. */
    const STRINGS = {
      zh: {
        title: '要记住这些要点吗？',
        target: '目标文件：{file}',
        file: MEMORY_FILE,
        confirm: '记住选中项 ({n})',
        skipAll: '全部跳过',
        close: '关闭',
        closeGlyph: '✕',
        listLabel: '待记住的要点',
      },
      en: {
        title: 'Remember these?',
        target: 'Target file: {file}',
        file: MEMORY_FILE,
        confirm: 'Remember selected ({n})',
        skipAll: 'Skip all',
        close: 'Close',
        closeGlyph: '✕',
        listLabel: 'Items to remember',
      },
    };

    /**
     * Resolve a Host route relative to the page's base URL, so a
     * reverse-proxied or desktop prefix keeps working.
     */
    function routeUrl(path) {
      return new URL(path.replace(/^\/+/, ''), document.baseURI).href;
    }

    /** Read the active language id from the Client locale service. */
    function readLanguage(locale) {
      if (!locale || typeof locale.getLocale !== 'function') return '';
      let snapshot;
      try {
        snapshot = locale.getLocale();
      } catch (error) {
        return '';
      }
      if (snapshot === null || snapshot === undefined) return '';
      if (typeof snapshot === 'string') return snapshot;
      if (typeof snapshot !== 'object') return '';
      return String(snapshot.id || snapshot.active || '');
    }

    /** Pick the copy the active locale asks for; English is the fallback. */
    function stringsFor(locale) {
      const language = readLanguage(locale).toLowerCase();
      return language.indexOf('zh') === 0 ? STRINGS.zh : STRINGS.en;
    }

    /** Whether one item id belongs to the current selection. */
    function isSelected(selected, itemId) {
      return selected.indexOf(itemId) !== -1;
    }

    /** Normalize the Host batch into the shape this dialog renders. */
    function normalizeBatch(pending) {
      if (!pending || typeof pending !== 'object') return null;
      if (typeof pending.id !== 'string' || pending.id === '') return null;
      if (!Array.isArray(pending.items) || pending.items.length === 0) return null;
      const items = [];
      for (const item of pending.items) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.id !== 'string' || item.id === '') continue;
        if (typeof item.text !== 'string') continue;
        items.push({ id: item.id, text: item.text });
      }
      if (items.length === 0) return null;
      return {
        id: pending.id,
        sessionId: typeof pending.sessionId === 'string' ? pending.sessionId : '',
        turn: typeof pending.turn === 'number' ? pending.turn : null,
        seq: typeof pending.seq === 'number' ? pending.seq : null,
        cwd: typeof pending.cwd === 'string' ? pending.cwd : '',
        createdAt: pending.createdAt,
        items: items,
      };
    }

    /* ------------------------------------------------- sidebar panel + note */

    /** Copy for the right-sidebar memory manager and the "extracting" note. */
    const PANEL_STRINGS = {
      zh: {
        tab: '记忆',
        guideDesc: '查看、添加、修改或删除本项目保存的记忆',
        loading: '加载中…',
        empty: '这个项目还没有记住任何内容。',
        emptyHint: '对话结束后，值得记住的要点会先问你，确认后才写进来。',
        count: '共 {n} 条',
        file: '文件',
        add: '新增记忆',
        addPlaceholder: '一句话描述要记住的事实…',
        editPlaceholder: '修改这条记忆…',
        save: '保存',
        cancel: '取消',
        edit: '修改',
        remove: '删除',
        confirmRemove: '删除这条记忆？删除后下一轮对话就不再包含它。',
        saved: '已保存',
        removed: '已删除',
        duplicate: '已经有一条相同或很接近的记忆了',
        failed: '操作失败',
        refresh: '刷新',
        declined: '已拒绝 {n} 条（不会再被提议）',
        extracting: '正在提取记忆',
        extractingSlow: '仍在提取记忆，稍候',
        extractingLonger: '提取还在继续，可以先做别的',
        analyseFailed: '上次自动提取失败：{msg}',
        noSession: '还没有会话，打开一个对话后再看。',
        inlineHint: '确认后才写入，未勾选的不再提',
      },
      en: {
        tab: 'Memory',
        guideDesc: 'View, add, edit or delete what this project remembers',
        loading: 'Loading…',
        empty: 'This project has not remembered anything yet.',
        emptyHint: 'After a turn, candidate facts are offered first and written only once you confirm them.',
        count: '{n} remembered',
        file: 'File',
        add: 'Add a memory',
        addPlaceholder: 'One sentence describing the fact to remember…',
        editPlaceholder: 'Edit this memory…',
        save: 'Save',
        cancel: 'Cancel',
        edit: 'Edit',
        remove: 'Delete',
        confirmRemove: 'Delete this memory? It will stop reaching the assistant from the next turn.',
        saved: 'Saved',
        removed: 'Deleted',
        duplicate: 'A same or very similar memory already exists',
        failed: 'Operation failed',
        refresh: 'Refresh',
        declined: '{n} declined (never offered again)',
        extracting: 'Extracting memory',
        extractingSlow: 'Still extracting, one moment',
        extractingLonger: 'Extraction continues — you can keep working',
        analyseFailed: 'Last extraction failed: {msg}',
        noSession: 'Open a conversation first.',
        inlineHint: 'Written only once you confirm; unticked items are never offered again',
      },
    };

    const PANEL_CSS = `
.dsh-memory-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  background: transparent;
}
.dsh-memory-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-memory-panel__count {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-memory-panel__spacer { flex: 1 1 auto; }
.dsh-memory-panel__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.dsh-memory-panel__icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-memory-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px 14px 10px;
}
.dsh-memory-panel__empty {
  padding: 18px 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.dsh-memory-panel__empty-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.dsh-memory-panel__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 8px 8px 6px;
  border-radius: var(--dsw-radius-sm, 8px);
}
.dsh-memory-panel__item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-memory-panel__bullet {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  margin: 8px 4px 0 2px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}
.dsh-memory-panel__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dsh-memory-panel__row-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  opacity: 0;
}
.dsh-memory-panel__item:hover .dsh-memory-panel__row-actions,
.dsh-memory-panel__item:focus-within .dsh-memory-panel__row-actions,
.dsh-memory-panel__item--confirming .dsh-memory-panel__row-actions { opacity: 1; }
.dsh-memory-panel__mini {
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}
.dsh-memory-panel__mini:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-panel__mini--danger:hover { color: var(--dsw-alias-state-error-primary); }
.dsh-memory-panel__confirm { display: inline-flex; align-items: center; gap: 4px; }
.dsh-memory-panel__confirm-text { font-size: 11.5px; color: var(--dsw-alias-state-error-primary); white-space: nowrap; }
.dsh-memory-panel__editor { padding: 6px 4px 8px 4px; }
.dsh-memory-panel__input {
  width: 100%;
  min-height: 62px;
  box-sizing: border-box;
  padding: 8px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  resize: vertical;
}
.dsh-memory-panel__input:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dsh-memory-panel__editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.dsh-memory-panel__button {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.dsh-memory-panel__button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-memory-panel__button--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dsh-memory-panel__button--primary:hover {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)));
}
.dsh-memory-panel__button:disabled { opacity: 0.55; cursor: default; }
.dsh-memory-panel__foot {
  padding: 8px 12px 12px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsh-memory-panel__add {
  width: 100%;
  height: 30px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.dsh-memory-panel__add:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-memory-panel__notice {
  padding: 6px 12px 0 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-memory-panel__notice--error { color: var(--dsw-alias-state-error-primary); }
.dsh-memory-panel__meta {
  padding: 0 12px 8px 12px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  overflow-wrap: anywhere;
}
.dsh-memory-note {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  align-self: flex-start;
  max-width: 100%;
  margin: 6px 0 2px 2px;
  padding: 5px 13px 5px 11px;
  border-radius: 999px;
  font-family: var(--dsw-font-family, inherit);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.01em;
  /* The accent is the product blue, not --dsw-alias-brand-primary: that token
   * is deliberately neutral (near-black on light, near-white on dark), so using
   * it here renders a grey pill. Pulling the label colour 15% toward the accent
   * keeps AA contrast on white while staying unmistakably blue. */
  color: var(--dsw-alias-state-business-primary, #4176e6);
  color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 85%, var(--dsw-alias-label-primary));
  background: transparent;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 10%, transparent);
  border: 1px solid transparent;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 32%, transparent);
  user-select: none;
  animation: dsh-memory-note-enter 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dsh-memory-note__dot {
  position: relative;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.dsh-memory-note__dot::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0.45;
  animation: dsh-memory-note-ripple 1.9s ease-out infinite;
}
.dsh-memory-note__text { white-space: nowrap; }
.dsh-memory-note__dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: -2px;
}
.dsh-memory-note__dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.22;
  animation: dsh-memory-note-dot 1.35s ease-in-out infinite;
}
.dsh-memory-note__dots i:nth-child(2) { animation-delay: 0.18s; }
.dsh-memory-note__dots i:nth-child(3) { animation-delay: 0.36s; }
@keyframes dsh-memory-note-enter {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
@keyframes dsh-memory-note-ripple {
  0% { transform: scale(1.1); opacity: 0.45; }
  70%, 100% { transform: scale(2.6); opacity: 0; }
}
@keyframes dsh-memory-note-dot {
  0%, 70%, 100% { opacity: 0.22; }
  35% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-memory-note,
  .dsh-memory-note__dot::after,
  .dsh-memory-note__dots i { animation: none; }
  .dsh-memory-note__dot::after { opacity: 0; }
  .dsh-memory-note__dots i { opacity: 0.55; }
}

/* The confirmation card, rendered inline under the assistant reply that
 * produced the candidates. It is a conversation element, not a modal: no
 * backdrop, no focus trap, no Escape handling. */
.dsh-memory-card {
  margin: 10px 0 2px 0;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  overflow: hidden;
  animation: dsh-memory-card-in 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes dsh-memory-card-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.dsh-memory-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px 4px 14px;
}
.dsh-memory-card__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}
.dsh-memory-card__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.dsh-memory-card__file {
  padding: 0 14px 8px 29px;
  font-family: var(--ds-font-family-code, var(--dsw-font-family-code, monospace));
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  overflow-wrap: anywhere;
}
.dsh-memory-card__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0 8px 2px 8px;
  list-style: none;
}
.dsh-memory-card__row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  cursor: pointer;
}
.dsh-memory-card__row:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
}
.dsh-memory-card__checkbox {
  flex: none;
  width: 15px;
  height: 15px;
  margin: 3px 0 0 0;
  accent-color: var(--dsw-alias-state-business-primary, #4176e6);
  cursor: pointer;
}
.dsh-memory-card__text {
  min-width: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: pre-wrap;
}
.dsh-memory-card__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 14px 12px 14px;
}
.dsh-memory-card__hint {
  margin-right: auto;
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}
.dsh-memory-card__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 13px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-memory-card__btn--ghost {
  border-color: var(--dsw-alias-border-l2);
}
.dsh-memory-card__btn--ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
}
.dsh-memory-card__btn--primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dsh-memory-card__btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill));
}
.dsh-memory-card__btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.dsh-memory-card__btn:focus-visible,
.dsh-memory-card__checkbox:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-memory-card { animation: none; }
}
`;

    /** POST JSON and read JSON back; throws on a non-ok HTTP status. */
    function postJson(url, payload) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function parse(response) {
        return response.json().then(function toValue(value) {
          if (!response.ok) throw new Error((value && value.error) || ('HTTP ' + String(response.status)));
          return value;
        }, function unparsable() {
          throw new Error('HTTP ' + String(response.status));
        });
      });
    }

    /** Read one session's memories (and whether an extraction is running). */
    function readMemories(sessionId, signal) {
      const url = routeUrl('dsh-memory-plugin/memories') + '?session=' + encodeURIComponent(sessionId || '');
      return fetch(url, { signal: signal }).then(function toJson(response) {
        if (!response.ok) throw new Error('HTTP ' + String(response.status));
        return response.json();
      });
    }

    /**
     * The `sidebar.right.pane.tab` body: this project's MEMORY.md as a list.
     *
     * The file is the source of truth — the assistant reads it before every step —
     * so editing here is the same edit as opening MEMORY.md in an editor.
     */
    function MemoryPanel(props) {
      const locale = props && props.locale ? props.locale : undefined;
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';
      const strings = stringsFor(locale) && PANEL_STRINGS[stringsFor(locale) === STRINGS.zh ? 'zh' : 'en'];

      const [state, setState] = React.useState({ loading: true, entries: [], path: '', declined: 0, lastRun: null, error: '' });
      const [notice, setNotice] = React.useState({ kind: '', text: '' });
      const [draft, setDraft] = React.useState(null);
      const [confirmingId, setConfirmingId] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const mountedRef = React.useRef(true);

      const load = React.useCallback(function load() {
        if (!sessionId) {
          setState({ loading: false, entries: [], path: '', declined: 0, error: strings.noSession });
          return;
        }
        readMemories(sessionId).then(function apply(value) {
          if (!mountedRef.current) return;
          setState({
            loading: false,
            entries: Array.isArray(value.entries) ? value.entries : [],
            path: typeof value.path === 'string' ? value.path : '',
            declined: typeof value.declined === 'number' ? value.declined : 0,
            lastRun: value.lastRun || null,
            error: value.ok === false ? (value.error || strings.failed) : '',
          });
        }, function failed(error) {
          if (!mountedRef.current) return;
          setState(function keep(current) {
            return {
              loading: false,
              entries: current.entries,
              path: current.path,
              declined: current.declined,
              lastRun: current.lastRun,
              error: (error && error.message) || strings.failed,
            };
          });
        });
      }, [sessionId, strings]);

      React.useEffect(function mount() {
        mountedRef.current = true;
        load();
        const timer = setInterval(load, 4000);
        return function unmount() {
          mountedRef.current = false;
          clearInterval(timer);
        };
      }, [load]);

      const submit = React.useCallback(function submit(action, payload) {
        if (busy) return;
        setBusy(true);
        setNotice({ kind: '', text: '' });
        postJson(routeUrl('dsh-memory-plugin/memories'), Object.assign({ session: sessionId, action: action }, payload))
          .then(function saved(value) {
            if (!mountedRef.current) return;
            setBusy(false);
            setDraft(null);
            if (value && value.changed === false) {
              setNotice({ kind: 'warn', text: value.reason === 'already remembered' ? strings.duplicate : strings.saved });
            } else {
              setNotice({ kind: 'ok', text: action === 'delete' ? strings.removed : strings.saved });
            }
            if (value && Array.isArray(value.entries)) {
              setState(function merge(current) {
                return Object.assign({}, current, { entries: value.entries, error: '' });
              });
            } else {
              load();
            }
          }, function failed(error) {
            if (!mountedRef.current) return;
            setBusy(false);
            setNotice({ kind: 'error', text: (error && error.message) || strings.failed });
          });
      }, [busy, load, sessionId, strings]);

      function startEdit(entry) {
        setNotice({ kind: '', text: '' });
        setDraft({ mode: 'edit', id: entry.id, text: entry.text });
      }

      function startAdd() {
        setNotice({ kind: '', text: '' });
        setDraft({ mode: 'add', id: '', text: '' });
      }

      function cancelDraft() {
        setDraft(null);
        setNotice({ kind: '', text: '' });
      }

      function saveDraft() {
        const text = String(draft && draft.text ? draft.text : '').trim();
        if (!text) return;
        if (draft.mode === 'edit') submit('update', { id: draft.id, text: text });
        else submit('add', { text: text });
      }

      function removeEntry(entry) {
        setConfirmingId('');
        submit('delete', { id: entry.id });
      }

      const editor = draft
        ? h('div', { className: 'dsh-memory-panel__editor' },
            h('textarea', {
              className: 'dsh-memory-panel__input',
              value: draft.text,
              placeholder: draft.mode === 'add' ? strings.addPlaceholder : strings.editPlaceholder,
              autoFocus: true,
              onChange: function onChange(event) {
                const next = event && event.target ? event.target.value : '';
                setDraft(function update(current) {
                  return current ? Object.assign({}, current, { text: next }) : current;
                });
              },
              onKeyDown: function onKeyDown(event) {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelDraft();
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  saveDraft();
                }
              },
            }),
            h('div', { className: 'dsh-memory-panel__editor-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-memory-panel__button',
                disabled: busy,
                onClick: cancelDraft,
              }, strings.cancel),
              h('button', {
                type: 'button',
                className: 'dsh-memory-panel__button dsh-memory-panel__button--primary',
                disabled: busy || String(draft.text).trim() === '',
                onClick: saveDraft,
              }, strings.save)
            )
          )
        : null;

      const rows = state.entries.map(function renderEntry(entry) {
        if (draft && draft.mode === 'edit' && draft.id === entry.id) {
          return h('div', { className: 'dsh-memory-panel__item', key: entry.id }, editor);
        }
        const confirming = confirmingId === entry.id;
        return h('div', {
          className: 'dsh-memory-panel__item' + (confirming ? ' dsh-memory-panel__item--confirming' : ''),
          key: entry.id,
        },
          h('span', { className: 'dsh-memory-panel__bullet', 'aria-hidden': true }),
          h('span', { className: 'dsh-memory-panel__text' }, entry.text),
          h('span', { className: 'dsh-memory-panel__row-actions' },
            confirming
              ? h('span', { className: 'dsh-memory-panel__confirm' },
                  h('span', { className: 'dsh-memory-panel__confirm-text' }, strings.confirmRemove),
                  h('button', {
                    type: 'button',
                    className: 'dsh-memory-panel__mini dsh-memory-panel__mini--danger',
                    disabled: busy,
                    onClick: function onClick() { removeEntry(entry); },
                  }, strings.remove),
                  h('button', {
                    type: 'button',
                    className: 'dsh-memory-panel__mini',
                    onClick: function onClick() { setConfirmingId(''); },
                  }, strings.cancel)
                )
              : h('span', { className: 'dsh-memory-panel__confirm' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-memory-panel__mini',
                    title: strings.edit,
                    onClick: function onClick() { startEdit(entry); },
                  }, strings.edit),
                  h('button', {
                    type: 'button',
                    className: 'dsh-memory-panel__mini dsh-memory-panel__mini--danger',
                    title: strings.remove,
                    onClick: function onClick() { setConfirmingId(entry.id); },
                  }, strings.remove)
                )
          )
        );
      });

      return h('div', { className: 'dsh-memory-panel' },
        h('style', null, PANEL_CSS),
        h('div', { className: 'dsh-memory-panel__head' },
          h('strong', { style: { fontSize: '13px', fontWeight: 600 } }, strings.tab),
          h('span', { className: 'dsh-memory-panel__count' }, strings.count.replace('{n}', String(state.entries.length))),
          h('span', { className: 'dsh-memory-panel__spacer' }),
          h('button', {
            type: 'button',
            className: 'dsh-memory-panel__icon-button',
            title: strings.refresh,
            onClick: load,
          }, '⟳')
        ),
        state.path
          ? h('div', { className: 'dsh-memory-panel__meta' }, strings.file + ': ' + state.path
              + (state.declined > 0 ? '  ·  ' + strings.declined.replace('{n}', String(state.declined)) : ''))
          : null,
        notice.text
          ? h('div', {
              className: 'dsh-memory-panel__notice' + (notice.kind === 'error' ? ' dsh-memory-panel__notice--error' : ''),
            }, notice.text)
          : null,
        state.lastRun && state.lastRun.phase === 'error'
          ? h('div', { className: 'dsh-memory-panel__notice dsh-memory-panel__notice--error' },
              strings.analyseFailed.replace('{msg}', String(state.lastRun.error || '').slice(0, 220)))
          : null,
        h('div', { className: 'dsh-memory-panel__body' },
          state.loading && state.entries.length === 0
            ? h('div', { className: 'dsh-memory-panel__empty' }, strings.loading)
            : state.entries.length === 0
              ? h('div', { className: 'dsh-memory-panel__empty' },
                  h('div', null, state.error || strings.empty),
                  h('div', { className: 'dsh-memory-panel__empty-hint' }, strings.emptyHint))
              : rows,
          draft && draft.mode === 'add' ? h('div', { className: 'dsh-memory-panel__item' }, editor) : null
        ),
        h('div', { className: 'dsh-memory-panel__foot' },
          draft
            ? null
            : h('button', {
                type: 'button',
                className: 'dsh-memory-panel__add',
                disabled: busy || !sessionId,
                onClick: startAdd,
              }, '+ ' + strings.add)
        )
      );
    }

    /**
     * `conversation.composer.dock` entry: a brand-tinted pill while this session's
     * turn is being mined for memories.
     *
     * Three things make it readable without making it loud: a filled pill instead
     * of loose grey text, a slow breathing halo (a blink would be either invisible
     * or irritating), and copy that changes as the wait grows, because information
     * earns attention where decoration does not.
     */
    function MemoryAnalysingNote(props) {
      const locale = props && props.locale ? props.locale : undefined;
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';
      const strings = stringsFor(locale) === STRINGS.zh ? PANEL_STRINGS.zh : PANEL_STRINGS.en;
      const [running, setRunning] = React.useState(false);
      const [visible, setVisible] = React.useState(false);
      const [stage, setStage] = React.useState(0);
      const mountedRef = React.useRef(true);

      React.useEffect(function watch() {
        mountedRef.current = true;
        if (!sessionId) return function stop() { mountedRef.current = false; };
        let timer = null;
        const tick = function tick() {
          readMemories(sessionId).then(function apply(value) {
            if (!mountedRef.current) return;
            setRunning(value && value.ok !== false && value.analysing === true);
          }, function ignore() { /* the Host may be restarting */ });
        };
        tick();
        timer = setInterval(tick, 1500);
        return function stop() {
          mountedRef.current = false;
          if (timer !== null) clearInterval(timer);
        };
      }, [sessionId]);

      /* Appear the moment a run starts, linger a beat after it ends: the 1.5 s
       * poll would otherwise blink the pill whenever a sample lands between the
       * turn ending and the analysis beginning. */
      React.useEffect(function holdVisible() {
        if (running) {
          setVisible(true);
          return undefined;
        }
        if (!visible) return undefined;
        const timer = setTimeout(function hide() { setVisible(false); }, 1200);
        return function cancel() { clearTimeout(timer); };
      }, [running, visible]);

      React.useEffect(function stageCopy() {
        if (!running) {
          setStage(0);
          return undefined;
        }
        const slow = setTimeout(function markSlow() { setStage(1); }, 9000);
        const longer = setTimeout(function markLonger() { setStage(2); }, 30000);
        return function cancel() {
          clearTimeout(slow);
          clearTimeout(longer);
        };
      }, [running]);

      if (!visible) return null;
      const label = stage === 2 ? strings.extractingLonger : stage === 1 ? strings.extractingSlow : strings.extracting;
      return h('div', { className: 'dsh-memory-note', role: 'status', 'aria-live': 'polite' },
        h('style', null, PANEL_CSS),
        h('span', { className: 'dsh-memory-note__dot', 'aria-hidden': true }),
        h('span', { className: 'dsh-memory-note__text' }, label),
        h('span', { className: 'dsh-memory-note__dots', 'aria-hidden': true },
          h('i', null), h('i', null), h('i', null))
      );
    }

    /**
     * One poll per session, shared by every mounted turn tail.
     *
     * A turn tail renders once per completed turn, so a long conversation keeps
     * hundreds of them mounted. Letting each poll the Host would mean hundreds
     * of requests every 1.5 s; instead they all subscribe to this feed, which
     * runs a single timer while at least one listener is attached and stops as
     * soon as the last one unsubscribes.
     */
    const pendingFeed = (function createPendingFeed() {
      const feeds = new Map();

      function ensure(sessionId) {
        let feed = feeds.get(sessionId);
        if (feed === undefined) {
          feed = { listeners: new Set(), timer: null, inFlight: false, last: null };
          feeds.set(sessionId, feed);
        }
        return feed;
      }

      function broadcast(feed, value) {
        feed.last = value;
        for (const listener of Array.from(feed.listeners)) {
          try {
            listener(value);
          } catch (error) { /* one broken subscriber must not stop the others */ }
        }
      }

      function publish(sessionId) {
        const feed = feeds.get(sessionId);
        if (feed === undefined) return;
        if (feed.inFlight) return;
        feed.inFlight = true;
        const url = routeUrl(PENDING_ROUTE) + '?session=' + encodeURIComponent(sessionId);
        Promise.resolve()
          .then(function ask() {
            return fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
          })
          .then(function readBody(response) {
            if (!response || !response.ok) return undefined;
            return response.json();
          })
          .then(function apply(data) {
            if (data === undefined) return;
            broadcast(feed, data && typeof data === 'object' ? normalizeBatch(data.pending) : null);
          })
          .catch(function ignore() {})
          .then(function done() { feed.inFlight = false; });
      }

      return {
        subscribe(sessionId, listener) {
          const feed = ensure(sessionId);
          feed.listeners.add(listener);
          if (feed.timer === null) {
            publish(sessionId);
            feed.timer = setInterval(function tick() { publish(sessionId); }, POLL_INTERVAL_MS);
          } else {
            listener(feed.last);
          }
          return function unsubscribe() {
            feed.listeners.delete(listener);
            if (feed.listeners.size === 0 && feed.timer !== null) {
              clearInterval(feed.timer);
              feed.timer = null;
            }
          };
        },
      };
    })();

    /**
     * `conversation.chat.turnTail` entry: the confirmation card, rendered
     * inline under the assistant reply of the turn that produced the
     * candidates.
     *
     * It is deliberately not a modal. A frame-wide overlay shows up in every
     * window, including a session that did not generate the batch, which makes
     * it impossible to tell which conversation is being written to. Anchoring
     * it to its own turn means the card appears in exactly one place — under
     * the reply it came from — and disappears from that spot once answered.
     */
    function MemoryInlineConfirm(props) {
      const locale = props && props.locale ? props.locale : undefined;
      const strings = stringsFor(locale) === STRINGS.zh ? PANEL_STRINGS.zh : PANEL_STRINGS.en;
      const sessionId = props && props.sessionId ? String(props.sessionId) : '';
      const turnNumber = props && props.turn && typeof props.turn.turn === 'number' ? props.turn.turn : null;
      // The closing sequence of this turn: the owner hands it over, and the
      // Host records the same number from the turn/end event. Matching on it
      // avoids assuming the two halves number turns identically.
      const closingSeq = props && typeof props.seq === 'number' ? props.seq : null;

      const [batch, setBatch] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [submitting, setSubmitting] = React.useState(false);
      const mountedRef = React.useRef(true);
      const batchRef = React.useRef(null);
      const submittingRef = React.useRef(false);
      const answeredRef = React.useRef(new Set());

      const clear = React.useCallback(function clear() {
        batchRef.current = null;
        submittingRef.current = false;
        if (!mountedRef.current) return;
        setBatch(null);
        setSelected([]);
        setSubmitting(false);
      }, []);

      const decide = React.useCallback(function decide(accepted) {
        const pending = batchRef.current;
        if (pending === null || submittingRef.current) return;
        submittingRef.current = true;
        answeredRef.current.add(pending.id);
        setSubmitting(true);
        let request;
        try {
          request = fetch(routeUrl(DECIDE_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id: pending.id, accepted: accepted }),
          });
        } catch (error) {
          request = Promise.resolve();
        }
        Promise.resolve(request)
          .catch(function ignoreFailure() {})
          .then(function settle() {
            if (mountedRef.current) clear();
          });
      }, [clear]);

      const skipAll = React.useCallback(function skipAll() { decide([]); }, [decide]);

      const confirmSelected = React.useCallback(function confirmSelected() {
        const pending = batchRef.current;
        if (pending === null) return;
        const accepted = pending.items
          .filter(function acceptedOnly(item) { return isSelected(selected, item.id); })
          .map(function toId(item) { return item.id; });
        decide(accepted);
      }, [decide, selected]);

      const toggleItem = React.useCallback(function toggleItem(itemId) {
        setSelected(function update(current) {
          if (isSelected(current, itemId)) {
            return current.filter(function others(id) { return id !== itemId; });
          }
          return current.concat([itemId]);
        });
      }, []);

      /* Every mounted turn tail subscribes to the session's single feed and
       * keeps only the batch that names its own turn — the anchor is the turn
       * number, never "whatever happens to be pending". */
      React.useEffect(function watchPending() {
        mountedRef.current = true;
        if (!sessionId || (turnNumber === null && closingSeq === null)) {
          return function stop() { mountedRef.current = false; };
        }
        return pendingFeed.subscribe(sessionId, function onPending(pending) {
          if (!mountedRef.current) return;
          if (pending === null) {
            // The Host retired it: answered here, expired, or answered
            // elsewhere. The card must not linger.
            if (batchRef.current !== null) clear();
            return;
          }
          if (pending.sessionId !== sessionId) return;
          // Either identifier is enough. Both are unique within a session, so a
          // match cannot land on two turn tails, and accepting either means a
          // Host that numbers turns differently from the renderer still works.
          const mine = (pending.seq !== null && pending.seq === closingSeq)
            || (pending.turn !== null && pending.turn === turnNumber);
          if (!mine) return;
          if (answeredRef.current.has(pending.id)) return;
          if (batchRef.current !== null && batchRef.current.id === pending.id) return;
          batchRef.current = pending;
          submittingRef.current = false;
          setBatch(pending);
          setSelected(pending.items.map(function toId(item) { return item.id; }));
          setSubmitting(false);
        });
      }, [sessionId, turnNumber, closingSeq, clear]);

      if (batch === null) return null;
      const selectedCount = batch.items.filter(function counted(item) {
        return isSelected(selected, item.id);
      }).length;
      const titleId = 'dsh-memory-card-title-' + String(turnNumber);

      return h('div', { className: 'dsh-memory-card', 'aria-labelledby': titleId },
        h('style', null, PANEL_CSS),
        h('div', { className: 'dsh-memory-card__head' },
          h('span', { className: 'dsh-memory-card__dot', 'aria-hidden': true }),
          h('span', { className: 'dsh-memory-card__title', id: titleId }, strings.title)
        ),
        h('div', { className: 'dsh-memory-card__file' }, batch.file || ''),
        h('ul', { className: 'dsh-memory-card__list', 'aria-label': strings.listLabel },
          batch.items.map(function renderItem(item, index) {
            return h('li', { key: item.id + ':' + String(index) },
              h('label', { className: 'dsh-memory-card__row' },
                h('input', {
                  type: 'checkbox',
                  className: 'dsh-memory-card__checkbox',
                  checked: isSelected(selected, item.id),
                  onChange: function onChange() { toggleItem(item.id); },
                }),
                h('span', { className: 'dsh-memory-card__text' }, item.text)
              )
            );
          })
        ),
        h('div', { className: 'dsh-memory-card__foot' },
          h('span', { className: 'dsh-memory-card__hint' }, strings.inlineHint),
          h('button', {
            type: 'button',
            className: 'dsh-memory-card__btn dsh-memory-card__btn--ghost',
            disabled: submitting,
            onClick: skipAll,
          }, strings.skipAll),
          h('button', {
            type: 'button',
            className: 'dsh-memory-card__btn dsh-memory-card__btn--primary',
            disabled: submitting,
            onClick: confirmSelected,
          }, strings.confirm.replace('{n}', String(selectedCount)))
        )
      );
    }

    return {
      // `sidebarRightTabs` is a hard dependency: the module must not activate
      // before the tab registry exists, or the sidebar tab would silently never
      // register. The Web GUI always ships it — the right column depends on it.
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        const tabStrings = function tabStrings() {
          return stringsFor(locale) === STRINGS.zh ? PANEL_STRINGS.zh : PANEL_STRINGS.en;
        };

        /* Confirmation is anchored inside the conversation it belongs to; there
         * is no frame-wide overlay entry on purpose. */
        function MemoryCardEntry(props) {
          return h(MemoryInlineConfirm, Object.assign({}, props, { locale: locale }));
        }
        ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'dsh-memory-confirm', order: 5 },
            MemoryCardEntry,
          );
        });

        /* Right sidebar: one tab type, its body, and a guide capsule on the
         * panel's start page so the tab is reachable without a shortcut. */
        const SIDEBAR_ID = '@local/dsh-memory-plugin/memory';
        const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined;
        if (tabs && typeof tabs.register === 'function') {
          ctx.effect(function () {
            return tabs.register({
              id: SIDEBAR_ID,
              kind: 'dsh-memory',
              title: function () { return tabStrings().tab; },
              guide: [{
                id: 'open',
                order: 40,
                title: function () { return tabStrings().tab; },
                description: function () { return tabStrings().guideDesc; },
              }],
            });
          });
          function MemoryPanelEntry(props) {
            return h(MemoryPanel, Object.assign({}, props, { locale: locale }));
          }
          ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_ID }, MemoryPanelEntry);
          });
        }

        /* Conversation: the "extracting memory" note above the composer. */
        function MemoryNoteEntry(props) {
          return h(MemoryAnalysingNote, Object.assign({}, props, { locale: locale }));
        }
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-memory-analysing', order: 10 },
            MemoryNoteEntry,
          );
        });
      },
    };
  },
});
