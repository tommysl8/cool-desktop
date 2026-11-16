/* PixelClock Desktop, new tab terminal: the page part. Classic script, UMD: PCD.term.mount (module.exports in Node:
 * PCD.term). It draws the shell's lines (term-shell.js) into the console's terminal slot (PCD.console's term():
 * section.pcd-term, the scroll container under the '── terminal ───' rule that the console draws) in the console's
 * look: the scrollback (one block per command, so a late answer still lands under its own command), then the prompt:
 * an accent '›', the input, a faint ghost (what Tab would add, or the link a digit opens) and an accent caret that
 * blinks every 530 ms only while the prompt has the focus (steady under reduced motion; no timer while blurred or
 * hidden). The caret is a '▌' block, or, over a ghost, the ghost's first character drawn inverse (accent behind it), so
 * the completion stays readable. Output is text, muted and faint; once lines scroll away the top line fades
 * (pcd-term-scrolled: a static mask). The classes are the console's (src/shared/css/pcd-console.css); css/ntp-term.css
 * adds the few extras and a stand-alone fallback. DOM through createElement and textContent only.
 *
 *   PCD.term.mount(slot, app, opts) -> term
 *     slot  PCD.console's term() ({ el, cols, rows, cell: { w, h, ls }, ... }) or just an element. The terminal renders
 *           inside el (the console places and sizes it; it never touches el's children) and never resizes it. Without
 *           cols/rows it reads el's data-cols/data-rows, else fits el's box; without cell it reads --cell-w/--cell-h/
 *           --cell-ls (inherited from the console) or measures its font. An el outside .pcd-console gets the class
 *           pcd-term-solo (ntp-term.css then gives it the console's terminal look on its own).
 *     app   the page's seam (term-shell.js header): links, openUrl, search, theme, surprise, shake, view, setClock24,
 *           openSettings, storage
 *     opts  { focus: true (focus the prompt now), ready: a Promise (focus again once it settles: PCD.console's ready,
 *           since a hidden column cannot take the focus), typeAnywhere: true (a key typed anywhere on the page moves
 *           the focus here), clickFocus: true (so does a click outside links, fields and dialogs, unless it selected
 *           text), historyKey: 'termHistory', reducedMotion: () => bool (default: html.pcd-reduced, then the media
 *           query) }
 *   term.layout(slot)   after every console layout: pass con.term() (null while the console drops the slot keeps the
 *                       terminal as it is); slot as for mount
 *   term.focus()        term.run(line, { newTab }) -> Promise<outcome> (as if typed, then Enter)
 *   term.motion()       after a reduced-motion change: starts or stops the caret's blink (the text, the caret's place
 *                       and the selection stay as they are)
 *   term.print(runs, kind)   one line of [text, roles] runs ('out' indents two cells)        term.clear()
 *   term.state() -> { focused, value, ghost, lines, text, history, caret: { shown, blinking }, scrolled, cols, rows }
 *   term.destroy()      removes the terminal's DOM, every listener and the timer (the slot stays)
 *   term.el { slot, out, prompt, input, ghost, caret }   term.shell (PCD.term.createShell)
 * Keys (PCD.term.keyAction): Enter runs, Ctrl+Enter or a trailing ' &' opens in a new tab, Up/Down walk the history,
 * Tab completes (Right at the end accepts the ghost too), Esc clears the line or, on an empty line, the screen.
 * Ctrl/Alt/Meta combinations are never prevented; IME composition is left alone; paste works anywhere on the page.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  const T = PCD.term || (PCD.term = {});
  const CARET_MS = 530;
  const MAX_LINES = 400;
  const ROLES = ['text', 'muted', 'faint', 'accent', 'frame', 'ring', 'wood', 'bold'];
  /** Line kinds -> the console's line classes (pcd-console.css). */
  const KIND_CLASS = {
    cmd: 'pcd-term-ln',
    out: 'pcd-term-ln pcd-term-o',
    error: 'pcd-term-ln pcd-term-o',
    hang: 'pcd-term-ln pcd-term-hang',
    art: 'pcd-term-ln pcd-term-o pcd-term-art',
  };
  const NONE = Object.freeze({ text: '', accept: '' });

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const cpLen = (s) => Array.from(s).length;

  /** 'text bold' -> 't-text t-bold' (pcd-base.css); unknown roles are dropped. */
  function roleClass(roles) {
    return String(roles || '').split(/\s+/).filter((r) => ROLES.includes(r)).map((r) => 't-' + r).join(' ');
  }

  /** [text, roles, href] or PCD.ascii's { text, tone, bold, href } -> { text, cls, href }. */
  function normRun(run) {
    if (Array.isArray(run)) return { text: String(run[0] == null ? '' : run[0]), cls: roleClass(run[1]), href: run[2] || null };
    if (run && typeof run === 'object') {
      return { text: String(run.text == null ? '' : run.text), cls: roleClass((run.tone || '') + (run.bold ? ' bold' : '')), href: run.href || null };
    }
    return { text: String(run == null ? '' : run), cls: '', href: null };
  }

  function num(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  function mount(slotIn, app, opts) {
    const o = opts || {};
    const first = slotIn && slotIn.nodeType === 1 ? { el: slotIn } : slotIn || {};
    const slot = first.el;
    if (!slot || slot.nodeType !== 1) throw new Error('PCD.term.mount: the slot (an element, or { el }) is required');
    if (typeof T.createShell !== 'function') throw new Error('PCD.term.mount: term-shell.js is not loaded');
    const doc = slot.ownerDocument;
    const win = doc.defaultView || root;
    const html = doc.documentElement;
    const solo = !slot.closest('.pcd-console');
    const listeners = [];
    let destroyed = false;

    function on(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      listeners.push([target, type, fn, options]);
    }

    function el(tag, cls, text) {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    // ------------------------------------------------------------------------------------------ the DOM

    const out = el('div', 'pcd-term-out');
    out.setAttribute('role', 'log');
    out.setAttribute('aria-live', 'polite');
    out.setAttribute('aria-label', 'terminal output');
    const prompt = el('div', 'pcd-term-prompt');
    const pp = el('span', 'pcd-term-pp', '›');
    pp.setAttribute('aria-hidden', 'true');
    const input = el('input', 'pcd-term-input');
    input.type = 'text';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('enterkeyhint', 'go');
    input.setAttribute('aria-label', 'command: a link number, a link name, a command, an address or a search');
    const ghostEl = el('span', 'pcd-term-ghost');
    ghostEl.setAttribute('aria-hidden', 'true');
    const caret = el('span', 'pcd-term-caret', '▌');
    caret.setAttribute('aria-hidden', 'true');
    prompt.append(pp, input, ghostEl, caret);
    slot.append(out, prompt);
    if (solo) slot.classList.add('pcd-term-solo');

    // ------------------------------------------------------------------------------------------ geometry

    let cols = 44;
    let rows = 6;
    let cw = 9;
    let ch = 18;

    function measure() {
      const probe = el('span', null, 'M'.repeat(100));
      probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre;line-height:normal;letter-spacing:0';
      slot.appendChild(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      const dpr = win.devicePixelRatio || 1;
      const adv = r.width / 100;
      const w = Math.max(1, Math.floor(adv * dpr + 1e-6)) / dpr;
      return { w, h: Math.max(1, Math.floor(r.height * dpr + 1e-6)) / dpr, ls: w - adv };
    }

    function layout(next) {
      if (destroyed || next === null) return;
      const s = next && next.nodeType === 1 ? { el: next } : next || {};
      if (s.el && s.el !== slot) throw new Error('PCD.term: layout() takes the slot the terminal was mounted in');
      let cell = s.cell && num(s.cell.w) > 0 && num(s.cell.h) > 0 ? { w: num(s.cell.w), h: num(s.cell.h), ls: num(s.cell.ls) || 0 } : null;
      if (cell && solo) {
        slot.style.setProperty('--cell-w', cell.w + 'px');
        slot.style.setProperty('--cell-h', cell.h + 'px');
        slot.style.setProperty('--cell-ls', cell.ls + 'px');
      }
      if (!cell) {
        const cs = win.getComputedStyle(slot);
        const w = num(cs.getPropertyValue('--cell-w'));
        const h = num(cs.getPropertyValue('--cell-h'));
        cell = w > 0 && h > 0 ? { w, h, ls: num(cs.getPropertyValue('--cell-ls')) || 0 } : measure();
        if (solo && !(w > 0 && h > 0)) {
          slot.style.setProperty('--cell-w', cell.w + 'px');
          slot.style.setProperty('--cell-h', cell.h + 'px');
          slot.style.setProperty('--cell-ls', cell.ls + 'px');
        }
      }
      cw = cell.w;
      ch = cell.h;
      const c = s.cols > 0 ? s.cols : num(slot.getAttribute('data-cols')) || slot.clientWidth / cw;
      const r = s.rows > 0 ? s.rows : num(slot.getAttribute('data-rows')) || slot.clientHeight / ch;
      cols = Math.max(4, Math.floor(c) || 4);
      rows = Math.max(1, Math.floor(r) || 1);
      input.style.left = 2 * cw + 'px';
      input.style.width = Math.max(cw, (cols - 2) * cw) + 'px';
      caretUpdate();
      scrollEnd();
    }

    // ------------------------------------------------------------------------------------------ output

    function lineEl(line) {
      const kind = line && KIND_CLASS[line.kind] ? line.kind : 'out';
      const div = el('div', KIND_CLASS[kind]);
      for (const run of (line && Array.isArray(line.runs) ? line.runs : [])) {
        const r = normRun(run);
        if (!r.text) continue;
        if (!r.cls && !r.href) {
          div.appendChild(doc.createTextNode(r.text));
          continue;
        }
        const span = el(r.href ? 'a' : 'span', r.cls || null, r.text);
        if (r.href) {
          span.href = r.href;
          span.rel = 'noopener noreferrer';
        }
        div.appendChild(span);
      }
      return div;
    }

    const lines = out.getElementsByClassName('pcd-term-ln');

    /** One run's own place (its echo, then its output, even when an answer arrives after the next run started). */
    function block() {
      const b = el('div', 'pcd-term-run');
      out.appendChild(b);
      return b;
    }

    function print(line, place) {
      if (destroyed) return;
      (place && place.nodeType === 1 ? place : out).appendChild(lineEl(line));
      while (lines.length > MAX_LINES && out.firstChild && out.firstChild !== place) out.removeChild(out.firstChild);
      scrollEnd();
    }

    function clear() {
      out.textContent = '';
      scrollEnd();
    }

    function scrollEnd() {
      slot.scrollTop = slot.scrollHeight;
      scrolledUpdate();
    }

    function scrolledUpdate() {
      slot.classList.toggle('pcd-term-scrolled', slot.scrollTop > 1);
    }

    const shell = T.createShell(app, { print, block, clear, cols: () => cols, rows: () => rows, historyKey: o.historyKey });

    // ------------------------------------------------------------------------------------------ the caret and the ghost

    let ghost = NONE;
    let composing = false;
    let blinkT = 0;
    let lastListing = '';

    function focused() {
      return doc.activeElement === input && (typeof doc.hasFocus !== 'function' || doc.hasFocus());
    }

    function reduced() {
      if (typeof o.reducedMotion === 'function') {
        try {
          return !!o.reducedMotion();
        } catch (e) {
          return false;
        }
      }
      if (html.classList.contains('pcd-reduced')) return true;
      try {
        return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) {
        return false;
      }
    }

    function caretUpdate() {
      if (destroyed) return;
      const f = focused();
      prompt.classList.toggle('pcd-focus', f);
      const v = input.value;
      const n = cpLen(v);
      const s0 = input.selectionStart;
      const collapsed = s0 === input.selectionEnd;
      const at = f && s0 != null ? cpLen(v.slice(0, Math.min(s0, v.length))) : n;
      const x = 2 * cw + at * cw - (input.scrollLeft || 0);
      caret.style.left = clamp(x, 2 * cw, Math.max(2 * cw, (cols - 1) * cw)) + 'px';
      caret.hidden = !collapsed;
      ghost = f && collapsed && !composing && at === n && !(input.scrollLeft > 0) ? shell.ghost(v) : NONE;
      const room = cols - 2 - n;
      ghostEl.textContent = room > 0 ? Array.from(ghost.text).slice(0, room).join('') : '';
      ghostEl.style.left = (2 + n) * cw + 'px';
      // over a ghost the caret is the ghost's first character drawn inverse, so the completion stays readable
      const under = Array.from(ghostEl.textContent)[0] || '';
      const glyph = under || '▌';
      if (caret.textContent !== glyph) caret.textContent = glyph;
      caret.classList.toggle('pcd-term-caret-on', under !== '');
      if (!f || !collapsed) stopBlink();
    }

    function stopBlink() {
      if (blinkT) win.clearTimeout(blinkT);
      blinkT = 0;
      prompt.classList.remove('pcd-blink-off');
    }

    /** Solid now; then blinking every 530 ms while focused, visible, with no selection and no reduced motion. */
    function blink() {
      stopBlink();
      if (destroyed || !focused() || doc.hidden || caret.hidden || reduced()) return;
      blinkT = win.setTimeout(function tick() {
        prompt.classList.toggle('pcd-blink-off');
        blinkT = win.setTimeout(tick, CARET_MS);
      }, CARET_MS);
    }

    function refresh() {
      caretUpdate();
      blink();
    }

    function caretEnd() {
      const n = input.value.length;
      try {
        input.setSelectionRange(n, n);
      } catch (e) {
        // not rendered yet
      }
      refresh();
    }

    function focusPrompt() {
      if (destroyed || doc.activeElement === input) return;
      try {
        input.focus({ preventScroll: true });
      } catch (e) {
        input.focus();
      }
    }

    // ------------------------------------------------------------------------------------------ keys

    function submit(newTab) {
      const line = input.value;
      input.value = '';
      lastListing = '';
      shell.resetCursor();
      refresh();
      return shell.run(line, { newTab });
    }

    function doComplete() {
      const c = shell.complete(input.value);
      if (c.line !== input.value) {
        input.value = c.line;
        caretEnd();
      }
      const listing = c.matches.length > 1 ? c.line + '\n' + c.matches.join(' ') : '';
      if (listing && listing !== lastListing) print({ kind: 'out', runs: [[c.matches.join('  '), 'faint']] });
      lastListing = listing;
      refresh();
    }

    on(input, 'keydown', (e) => {
      const atEnd = input.selectionStart === input.selectionEnd && input.selectionEnd === input.value.length;
      const a = T.keyAction(e, { value: input.value, atEnd, accept: ghost.accept });
      if (!a) {
        refresh();
        return;
      }
      if (a.prevent) e.preventDefault();
      switch (a.act) {
        case 'submit':
        case 'submit-new':
          submit(a.act === 'submit-new');
          break;
        case 'up':
          input.value = shell.up(input.value);
          caretEnd();
          break;
        case 'down':
          input.value = shell.down(input.value);
          caretEnd();
          break;
        case 'complete':
          doComplete();
          break;
        case 'accept':
          input.value += ghost.accept;
          caretEnd();
          break;
        case 'clear-line':
          input.value = '';
          lastListing = '';
          shell.resetCursor();
          refresh();
          break;
        case 'clear-screen':
          clear();
          refresh();
          break;
        default:
      }
    });
    on(input, 'input', () => {
      lastListing = '';
      refresh();
    });
    for (const type of ['keyup', 'click', 'select', 'focus', 'scroll']) on(input, type, refresh);
    on(input, 'blur', () => {
      stopBlink();
      caretUpdate();
    });
    on(input, 'compositionstart', () => {
      composing = true;
      caretUpdate();
    });
    on(input, 'compositionend', () => {
      composing = false;
      refresh();
    });
    on(doc, 'selectionchange', () => {
      if (doc.activeElement === input) refresh();
    });
    on(slot, 'scroll', scrolledUpdate, { passive: true });

    // ------------------------------------------------------------------------------------------ the page: keys, paste, clicks

    function ctxOf(target) {
      const t = target && target.nodeType === 1 ? target : target && target.parentElement;
      if (!t || typeof t.closest !== 'function') return { inPrompt: false, editable: false, dialog: false, activatable: false };
      return {
        inPrompt: t === input,
        editable: !!t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(t.tagName),
        dialog: !!t.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
        activatable: !!t.closest('a[href], button, summary, label, [role="button"], [role="link"]'),
      };
    }

    function hasSelection() {
      try {
        const sel = win.getSelection ? win.getSelection() : null;
        return !!sel && !sel.isCollapsed && String(sel).length > 0;
      } catch (e) {
        return false;
      }
    }

    if (o.typeAnywhere !== false) {
      on(doc, 'keydown', (e) => {
        if (doc.activeElement === input) return;
        if (T.redirectKey(e, ctxOf(e.target))) focusPrompt();
      }, true);
      on(doc, 'paste', (e) => {
        if (doc.activeElement === input || e.defaultPrevented) return;
        const c = ctxOf(e.target);
        if (c.editable || c.dialog) return;
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (!text) return;
        focusPrompt();
        if (doc.activeElement !== input) return;
        e.preventDefault();
        const s0 = input.selectionStart == null ? input.value.length : input.selectionStart;
        const s1 = input.selectionEnd == null ? s0 : input.selectionEnd;
        input.setRangeText(text.replace(/[\r\n]+/g, ' '), s0, s1, 'end');
        lastListing = '';
        refresh();
      });
    }

    if (o.clickFocus !== false) {
      let pending = false;
      on(doc, 'pointerdown', (e) => {
        const c = ctxOf(e.target);
        pending = e.button === 0 && !c.inPrompt && !c.editable && !c.dialog && !c.activatable;
      }, true);
      on(doc, 'pointerup', () => {
        if (!pending) return;
        pending = false;
        win.setTimeout(() => {
          if (!hasSelection()) focusPrompt();
        }, 0);
      }, true);
      on(win, 'focus', () => {
        const a = doc.activeElement;
        if ((!a || a === doc.body || a === html) && !hasSelection()) focusPrompt();
      });
    }

    on(doc, 'visibilitychange', () => {
      if (doc.hidden) stopBlink();
      else refresh();
    });

    // ------------------------------------------------------------------------------------------ start

    function focusNow() {
      focusPrompt();
      caretEnd();
    }

    layout(first);
    shell.load();
    if (o.focus !== false) {
      focusNow();
      if (o.ready && typeof o.ready.then === 'function') {
        o.ready.then(() => { if (!destroyed && doc.activeElement !== input) focusNow(); }, () => {});
      }
    }

    return {
      el: { slot, out, prompt, input, ghost: ghostEl, caret },
      shell,
      layout,
      focus: focusNow,
      motion: refresh,
      run: (line, ropts) => shell.run(line, ropts || {}),
      print: (runs, kind) => print({ kind: kind || 'out', runs }),
      clear,
      state() {
        return {
          focused: focused(),
          value: input.value,
          ghost: ghostEl.textContent,
          lines: lines.length,
          text: out.innerText,
          history: shell.history(),
          caret: { shown: prompt.classList.contains('pcd-focus') && !caret.hidden && !prompt.classList.contains('pcd-blink-off'), blinking: !!blinkT },
          scrolled: slot.classList.contains('pcd-term-scrolled'),
          cols,
          rows,
          cell: { w: cw, h: ch },
          solo,
        };
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        stopBlink();
        for (const [target, type, fn, options] of listeners) target.removeEventListener(type, fn, options);
        listeners.length = 0;
        out.remove();
        prompt.remove();
        slot.classList.remove('pcd-term-solo', 'pcd-term-scrolled');
      },
    };
  }

  T.mount = mount;
  T.roleClass = roleClass;
  T.CARET_MS = CARET_MS;
  return T;
});
