window.__ModuleLoader__.load({
  id: '@local/dsh-memory-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** How often the overlay asks the Host for a pending memory batch. */
    const POLL_INTERVAL_MS = 1500;

    /** Entry key inside the frame-wide overlay layer. */
    const OVERLAY_ID = 'dsh-memory-confirm';

    /** Ids shared by the dialog, its accessible name, and its description. */
    const TITLE_ID = 'dsh-memory-confirm-title';
    const SUBTITLE_ID = 'dsh-memory-confirm-subtitle';

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
     * Component-scoped stylesheet: host theme tokens only, rendered as a
     * <style> child so unmounting the entry removes it with the component.
     */
    const CSS = `
.dsh-memory-confirm {
  --dm-surface: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-overlay)));
  --dm-text: var(--dsw-alias-text-primary, var(--dsw-alias-label-primary, currentColor));
  --dm-text-secondary: var(--dsw-alias-text-secondary, var(--dsw-alias-label-secondary, var(--dm-text)));
  --dm-border: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, currentColor));
  --dm-hover: var(--dsw-alias-interactive-bg-hover, transparent);
  --dm-accent: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary, currentColor));
  --dm-on-accent: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-label-primary-foreground, var(--dm-text)));
  --dm-mask: var(--dsw-alias-bg-mask-1, var(--dsw-alias-bg-mask-2, transparent));
  --dm-focus: var(--dsw-alias-state-business-primary, var(--dm-accent));
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
  pointer-events: none;
  color: var(--dm-text);
  font-family: var(--dsw-font-family, inherit);
}

.dsh-memory-confirm__backdrop {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
  background: var(--dm-mask);
  pointer-events: auto;
}

.dsh-memory-confirm__card {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  max-height: 70vh;
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--dm-border);
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dm-surface);
  color: var(--dm-text);
  box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3, none));
  pointer-events: auto;
  outline: none;
}

.dsh-memory-confirm__header {
  padding: 18px 20px 10px 20px;
}

.dsh-memory-confirm__title {
  margin: 0;
  padding-right: 26px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.01em;
  color: var(--dm-text);
}

.dsh-memory-confirm__subtitle {
  margin: 4px 0 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dm-text-secondary);
}

.dsh-memory-confirm__file {
  font-family: var(--ds-font-family-code, var(--dsw-font-family-code, monospace));
  font-size: 12.5px;
}

.dsh-memory-confirm__close {
  position: absolute;
  top: 12px;
  right: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dm-text-secondary);
  font-family: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.dsh-memory-confirm__close:hover {
  background: var(--dm-hover);
  color: var(--dm-text);
}

.dsh-memory-confirm__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 2px 14px 14px 14px;
}

.dsh-memory-confirm__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dsh-memory-confirm__item {
  display: block;
  margin: 0;
  padding: 0;
}

.dsh-memory-confirm__row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  cursor: pointer;
}

.dsh-memory-confirm__row:hover {
  background: var(--dm-hover);
}

.dsh-memory-confirm__checkbox {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  margin: 3px 0 0 0;
  accent-color: var(--dm-accent);
  cursor: pointer;
}

.dsh-memory-confirm__text {
  min-width: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--dm-text);
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: pre-wrap;
}

.dsh-memory-confirm__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px 20px;
  border-top: 1px solid var(--dm-border);
  background: var(--dm-surface);
}

.dsh-memory-confirm__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dm-text);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.dsh-memory-confirm__button:disabled {
  opacity: 0.55;
  cursor: default;
}

.dsh-memory-confirm__button--secondary {
  border-color: var(--dm-border);
}

.dsh-memory-confirm__button--secondary:hover:not(:disabled) {
  background: var(--dm-hover);
}

.dsh-memory-confirm__button--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dm-accent));
  color: var(--dm-on-accent);
}

.dsh-memory-confirm__button--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dm-accent)));
}

.dsh-memory-confirm__button:focus-visible,
.dsh-memory-confirm__close:focus-visible,
.dsh-memory-confirm__checkbox:focus-visible,
.dsh-memory-confirm__card:focus-visible {
  outline: 2px solid var(--dm-focus);
  outline-offset: 2px;
}

@media (max-width: 560px) {
  .dsh-memory-confirm {
    padding: 12px;
  }
  .dsh-memory-confirm__backdrop {
    align-items: flex-end;
    padding: 12px;
  }
  .dsh-memory-confirm__card {
    max-height: 82vh;
  }
}
`;

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
        cwd: typeof pending.cwd === 'string' ? pending.cwd : '',
        createdAt: pending.createdAt,
        items: items,
      };
    }

    /**
     * The `shell.overlay` entry: one frame-wide confirmation dialog. It polls
     * the Host for a pending batch, asks which points to remember, and POSTs
     * the decision. The wrapper is always click-through; only the card opts
     * back into pointer events.
     */
    function MemoryConfirmEntry(props) {
      const locale = props && props.locale ? props.locale : undefined;
      const strings = stringsFor(locale);

      const [batch, setBatch] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [submitting, setSubmitting] = React.useState(false);

      const handledRef = React.useRef(new Set());
      const batchRef = React.useRef(null);
      const submittingRef = React.useRef(false);
      const mountedRef = React.useRef(false);
      const pollControllerRef = React.useRef(null);
      const decideControllerRef = React.useRef(null);
      const cardRef = React.useRef(null);

      const closeDialog = React.useCallback(function closeDialog() {
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
        setSubmitting(true);
        let controller = null;
        if (typeof AbortController === 'function') {
          controller = new AbortController();
          decideControllerRef.current = controller;
        }
        let request;
        try {
          request = fetch(routeUrl(DECIDE_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ id: pending.id, accepted: accepted }),
            signal: controller === null ? undefined : controller.signal,
          });
        } catch (error) {
          request = Promise.resolve();
        }
        Promise.resolve(request)
          .catch(function ignoreFailure() {})
          .then(function settle() {
            decideControllerRef.current = null;
            if (mountedRef.current) closeDialog();
          });
      }, [closeDialog]);

      const skipAll = React.useCallback(function skipAll() {
        decide([]);
      }, [decide]);

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

      const openBatch = React.useCallback(function openBatch(pending) {
        if (pending === null) return;
        if (batchRef.current !== null) return;
        if (handledRef.current.has(pending.id)) return;
        handledRef.current.add(pending.id);
        batchRef.current = pending;
        submittingRef.current = false;
        setBatch(pending);
        setSelected(pending.items.map(function toId(item) { return item.id; }));
        setSubmitting(false);
      }, []);

      React.useEffect(function startPolling() {
        mountedRef.current = true;
        let disposed = false;
        let inFlight = false;
        let controller = null;
        if (typeof AbortController === 'function') {
          controller = new AbortController();
          pollControllerRef.current = controller;
        }

        function poll() {
          if (disposed || inFlight) return;
          inFlight = true;
          let request;
          try {
            request = fetch(routeUrl(PENDING_ROUTE), {
              method: 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
              signal: controller === null ? undefined : controller.signal,
            });
          } catch (error) {
            inFlight = false;
            return;
          }
          Promise.resolve(request)
            .then(function readBody(response) {
              if (!response || !response.ok) return null;
              return response.json();
            })
            .then(function consume(data) {
              if (disposed || !data || typeof data !== 'object') return;
              const pending = normalizeBatch(data.pending);
              if (pending === null) return;
              openBatch(pending);
            })
            .catch(function ignoreFailure() {})
            .then(function finish() {
              inFlight = false;
            });
        }

        poll();
        const timer = setInterval(poll, POLL_INTERVAL_MS);

        return function stopPolling() {
          disposed = true;
          mountedRef.current = false;
          clearInterval(timer);
          if (pollControllerRef.current !== null) {
            try {
              pollControllerRef.current.abort();
            } catch (error) {}
            pollControllerRef.current = null;
          }
          if (decideControllerRef.current !== null) {
            try {
              decideControllerRef.current.abort();
            } catch (error) {}
            decideControllerRef.current = null;
          }
        };
      }, [openBatch]);

      React.useEffect(function bindDialog() {
        if (batch === null) return undefined;
        const card = cardRef.current;
        if (card && typeof card.focus === 'function') {
          try {
            card.focus();
          } catch (error) {}
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            skipAll();
          }
        }
        window.addEventListener('keydown', onKeyDown);
        return function unbindDialog() {
          window.removeEventListener('keydown', onKeyDown);
        };
      }, [batch, skipAll]);

      const open = batch !== null;
      const selectedCount = open
        ? batch.items.filter(function counted(item) { return isSelected(selected, item.id); }).length
        : 0;
      const targetParts = strings.target.split('{file}');

      return h('div', {
        className: 'dsh-memory-confirm',
        style: { pointerEvents: 'none' },
      },
        h('style', { key: 'dsh-memory-confirm-styles' }, CSS),
        open
          ? h('div', {
            key: 'dsh-memory-confirm-backdrop',
            className: 'dsh-memory-confirm__backdrop',
            role: 'presentation',
            onClick: function onBackdropClick(event) {
              if (event.target === event.currentTarget) skipAll();
            },
          }, h('div', {
            className: 'dsh-memory-confirm__card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': TITLE_ID,
            'aria-describedby': SUBTITLE_ID,
            tabIndex: -1,
            ref: cardRef,
            onClick: function stopCardClick(event) {
              event.stopPropagation();
            },
          },
            h('div', { className: 'dsh-memory-confirm__header' },
              h('h2', {
                className: 'dsh-memory-confirm__title',
                id: TITLE_ID,
              }, strings.title),
              h('p', {
                className: 'dsh-memory-confirm__subtitle',
                id: SUBTITLE_ID,
              },
                targetParts[0],
                h('span', {
                  key: 'dsh-memory-confirm-file',
                  className: 'dsh-memory-confirm__file',
                }, strings.file),
                targetParts.length > 1 ? targetParts[1] : null
              )
            ),
            h('button', {
              type: 'button',
              className: 'dsh-memory-confirm__close',
              'aria-label': strings.close,
              title: strings.close,
              onClick: skipAll,
            }, strings.closeGlyph),
            h('div', { className: 'dsh-memory-confirm__body' },
              h('ul', {
                className: 'dsh-memory-confirm__list',
                'aria-label': strings.listLabel,
              }, batch.items.map(function renderItem(item, index) {
                const checked = isSelected(selected, item.id);
                return h('li', {
                  className: 'dsh-memory-confirm__item',
                  key: item.id + ':' + String(index),
                }, h('label', { className: 'dsh-memory-confirm__row' },
                  h('input', {
                    type: 'checkbox',
                    className: 'dsh-memory-confirm__checkbox',
                    checked: checked,
                    onChange: function onChange() {
                      toggleItem(item.id);
                    },
                  }),
                  h('span', { className: 'dsh-memory-confirm__text' }, item.text)
                ));
              }))
            ),
            h('div', { className: 'dsh-memory-confirm__footer' },
              h('button', {
                type: 'button',
                className: 'dsh-memory-confirm__button dsh-memory-confirm__button--secondary',
                disabled: submitting,
                onClick: skipAll,
              }, strings.skipAll),
              h('button', {
                type: 'button',
                className: 'dsh-memory-confirm__button dsh-memory-confirm__button--primary',
                disabled: submitting,
                onClick: confirmSelected,
              }, strings.confirm.replace('{n}', String(selectedCount)))
            )
          ))
          : null
      );
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
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: 0.01em;
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-1);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, var(--dsw-alias-border-l1));
  user-select: none;
  animation: dsh-memory-note-enter 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dsh-memory-note__dot {
  position: relative;
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.dsh-memory-note__dot::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0.5;
  animation: dsh-memory-note-ripple 1.9s ease-out infinite;
}
.dsh-memory-note__text { white-space: nowrap; }
.dsh-memory-note__dots {
  display: inline-flex;
  align-items: center;
  gap: 2.5px;
  margin-left: -4px;
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
  0% { transform: scale(1); opacity: 0.5; }
  70%, 100% { transform: scale(2.8); opacity: 0; }
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

        function MemoryOverlayEntry() {
          return h(MemoryConfirmEntry, { locale: locale });
        }
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: OVERLAY_ID, order: 100, label: function () { return 'Memory'; } },
            MemoryOverlayEntry,
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
