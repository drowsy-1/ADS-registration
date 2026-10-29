/*!
 * ADS Parentage – lookup client, tree-builder widget and Gravity Forms adapter.
 * Requires parentage-core.js. No framework. Modern browsers (fetch, AbortController).
 */
(function (window, document) {
  'use strict';
  var Core = window.ADSParentageCore;
  if (!Core) { if (window.console) { console.error('[ads-parentage] parentage-core.js must load first'); } return; }

  var DEFAULTS = {
    formId: 15,
    fields: { podMode: 57, pollenMode: 58, pod: 38, pollen: 39, widget: null, string: null, tree: null },
    modeValues: {
      pod: { choose: 'Choose Pod Parent', unknown: 'Unknown', sdlg: 'sdlg' },
      pollen: { choose: 'Choose Pollen Parent', unknown: 'Unknown', sdlg: 'sdlg' }
    },
    approvalCheckboxId: 'choice_15_43_1',
    lookup: { strategy: 'auto', fieldId: 38, pageSize: 50, minChars: 3, debounceMs: 350, ajaxUrl: '' },
    maxDepth: 4,
    hideNativeFields: true,
    blockDraftWhenInvalid: false,
    requireIds: null, // null = strict when the registry lookup returns ids
    labels: {}
  };

  var LABELS = {
    title: 'Parentage',
    help: 'Pod parent (seed parent) is listed first, pollen parent second. Start typing a registered cultivar name and pick it from the list. Choose "sdlg" for any unregistered plant and "unknown" when the identity is not known. If a parent is itself an unregistered seedling whose parents you know, choose "Known cross" and enter its parents the same way.',
    pod: 'Pod parent', pollen: 'Pollen parent',
    modeRegistered: 'Registered cultivar', modeSdlg: 'sdlg', modeUnknown: 'unknown', modeCross: 'Known cross',
    depthLimit: 'Maximum number of generations reached',
    choosePrompt: 'Choose one of the options above.',
    sdlgNote: 'Recorded as "sdlg" (an unregistered seedling).',
    unknownNote: 'Recorded as "unknown".',
    crossNote: 'This parent is an unregistered seedling. Its own parents are recorded below and it is reported to the registrar as "sdlg".',
    lookupPlaceholder: 'Type at least {n} letters, then pick from the list',
    typeMore: 'Type {n} more character(s)',
    searching: 'Searching the registry…',
    noMatch: 'No registered cultivar matches "{term}". Check the spelling, or choose sdlg if the plant is unregistered.',
    matches: '{n} match(es). Pick one from the list.',
    partial: 'Showing the first {n} matches. Keep typing to narrow the list.',
    loadMore: 'Load more',
    lookupFailed: 'Lookup failed ({reason}). Please try again.',
    exact: 'exact match',
    change: 'Change',
    previewLabel: 'Will be recorded as',
    nativeLabel: 'Sent to the registrar as immediate parents:',
    complete: 'Parentage is complete.',
    incomplete: '{n} choice(s) still needed before this registration can be submitted.',
    fix: 'Fix',
    confirmDiscard: 'Discard the nested cross entered for this parent?',
    blocked: 'The parentage is incomplete or invalid. Please correct the highlighted entries.',
    crossOf: '{side} is itself a cross:'
  };

  function fmt(s, vars) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && k in vars ? vars[k] : m; }); }
  function merge(a, b) {
    var out = {};
    Object.keys(a || {}).forEach(function (k) { out[k] = a[k]; });
    Object.keys(b || {}).forEach(function (k) {
      var v = b[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') ? merge(out[k], v) : v;
    });
    return out;
  }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) { return; }
        if (k === 'class') { el.className = v; }
        else if (k === 'text') { el.textContent = v; }
        else if (k.indexOf('on') === 0 && typeof v === 'function') { el.addEventListener(k.slice(2), v); }
        else if (v === true) { el.setAttribute(k, ''); }
        else { el.setAttribute(k, v); }
      });
    }
    (children || []).forEach(function (c) { if (c != null) { el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return el;
  }
  var uidCounter = 0;

  /* ------------------------------------------------------------------ */
  /* Lookup client                                                        */
  /* ------------------------------------------------------------------ */
  /**
   * Strategies:
   *  'gppa'  – the same endpoint the native Pod Parent field uses
   *            (gp_advanced_select_get_gppa_results). Returns {id, text}. Preferred.
   *  'theme' – the theme's cultivar_autocomplete (names only, no ids). Fallback.
   * Optimisations over the native box: debounce, abort of stale requests,
   * per-term cache, prefix narrowing without a request when the previous
   * result set was complete, and client-side ranking (exact, starts-with, contains).
   */
  function createLookup(cfg) {
    cfg = merge({ strategy: 'auto', fieldId: 38, pageSize: 50, minChars: 3, formId: 15, ajaxUrl: '' }, cfg || {});
    var cache = new Map();
    var controller = null;

    function ajaxUrl() {
      return cfg.ajaxUrl || (window.GPPA && window.GPPA.AJAXURL) || (window.cultivar_search_ajax && window.cultivar_search_ajax.ajax_url) || window.ajaxurl || '/wp-admin/admin-ajax.php';
    }
    function resolveStrategy() {
      if (cfg.strategy === 'gppa' || cfg.strategy === 'theme') { return cfg.strategy; }
      if (window.GPPA && window.GPPA.NONCE) { return 'gppa'; }
      if (window.cultivar_search_ajax && window.cultivar_search_ajax.nonce) { return 'theme'; }
      return 'gppa';
    }
    var strategy = resolveStrategy();

    function fetchGppa(term, page, signal) {
      var body = {
        fieldId: cfg.fieldId,
        security: window.GPPA ? window.GPPA.NONCE : '',
        term: term,
        'form-id': cfg.formId,
        'field-values': typeof cfg.getFieldValues === 'function' ? cfg.getFieldValues() : {}
      };
      if (page > 1) { body.page = page; }
      var url = ajaxUrl() + (ajaxUrl().indexOf('?') >= 0 ? '&' : '?') + 'action=gp_advanced_select_get_gppa_results';
      return fetch(url, {
        method: 'POST', credentials: 'same-origin', signal: signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(body)
      }).then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
        .then(function (json) {
          var list = (json && json.results) || [];
          var results = list.map(function (it) { return { id: String(it.id), name: String(it.text) }; });
          var nextPage = json && json.pagination && json.pagination.nextPage ? json.pagination.nextPage : null;
          return { results: results, complete: !nextPage && results.length < cfg.pageSize, nextPage: nextPage };
        });
    }
    function fetchTheme(term, signal) {
      var src = window.cultivar_search_ajax || {};
      var params = new URLSearchParams({ action: 'cultivar_autocomplete', nonce: src.nonce || '', term: term, position: 'anywhere' });
      return fetch(ajaxUrl(), {
        method: 'POST', credentials: 'same-origin', signal: signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: params.toString()
      }).then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
        .then(function (json) {
          var names = (json && json.success && Array.isArray(json.data)) ? json.data : [];
          var results = names.map(function (n) { return { id: null, name: String(n) }; });
          return { results: results, complete: results.length < 10, nextPage: null };
        });
    }
    function fromPrefixCache(key) {
      for (var i = key.length - 1; i >= cfg.minChars; i--) {
        var c = cache.get(key.slice(0, i));
        if (c && c.complete) {
          return { results: c.results.filter(function (r) { return r.name.toLowerCase().indexOf(key) >= 0; }), complete: true, nextPage: null };
        }
      }
      return null;
    }
    function search(term, page) {
      page = page || 1;
      var key = term.toLowerCase();
      if (page === 1) {
        var hit = cache.get(key);
        if (hit) { return Promise.resolve(hit); }
        var narrowed = fromPrefixCache(key);
        if (narrowed) { cache.set(key, narrowed); return Promise.resolve(narrowed); }
      }
      if (controller) { controller.abort(); }
      controller = new AbortController();
      var p = strategy === 'theme' ? fetchTheme(term, controller.signal) : fetchGppa(term, page, controller.signal);
      return p.then(function (out) { if (page === 1) { cache.set(key, out); } return out; });
    }
    function abort() { if (controller) { controller.abort(); controller = null; } }
    return { search: search, abort: abort, strategy: strategy, returnsIds: strategy !== 'theme', minChars: cfg.minChars, pageSize: cfg.pageSize };
  }

  /* ------------------------------------------------------------------ */
  /* Widget                                                               */
  /* ------------------------------------------------------------------ */
  function ParentageWidget(mount, opts) {
    opts = opts || {};
    this.mount = mount;
    this.lookup = opts.lookup;
    this.maxDepth = opts.maxDepth || 4;
    this.minChars = opts.minChars || (this.lookup && this.lookup.minChars) || 3;
    this.debounceMs = opts.debounceMs || 350;
    this.requireIds = opts.requireIds === null || opts.requireIds === undefined ? !!(this.lookup && this.lookup.returnsIds) : !!opts.requireIds;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    this.L = merge(LABELS, opts.labels || {});
    this.uid = 'adsp' + (++uidCounter);
    this.uiMode = {};
    this.showAllErrors = false;
    this.lastErrors = [];
    this.setTree(opts.tree, true);
  }
  var P = ParentageWidget.prototype;

  P.getTree = function () { return this.tree; };
  P.setTree = function (tree, silent) {
    this.tree = tree && tree.type === 'cross' ? Core.strip(tree) : Core.cross();
    var self = this;
    Core.walk(this.tree, function (n, path) { if (n && n.type !== 'empty') { self.uiMode[path.join('.')] = n.type; } });
    this.render();
    if (!silent) { this.emit(); }
  };
  P.validate = function () { return Core.validate(this.tree, { maxDepth: this.maxDepth, requireIds: this.requireIds }); };
  P.getString = function () { var v = this.validate(); return v.ok ? v.string : ''; };
  P.emit = function () {
    var v = this.validate();
    this.lastErrors = v.errors;
    this.onChange({ tree: this.tree, valid: v.ok, string: v.ok ? v.string : '', errors: v.errors, preview: Core.render(this.tree), native: Core.rootToNative(this.tree) });
  };
  P.update = function (path, node, focusKey) {
    this.tree = Core.setAt(this.tree, path, node);
    this.emit();
    this.render();
    if (focusKey) { this.focusSlot(focusKey); }
  };
  P.setMode = function (path, mode) {
    var key = path.join('.');
    var current = Core.getAt(this.tree, path) || Core.empty();
    if (current.type === 'cross' && mode !== 'cross' && Core.hasContent(current) && !window.confirm(this.L.confirmDiscard)) { return; }
    this.uiMode[key] = mode;
    var node;
    switch (mode) {
      case 'registered': node = Core.empty(); break;
      case 'sdlg': node = Core.sdlg(); break;
      case 'unknown': node = Core.unknown(); break;
      case 'cross': node = current.type === 'cross' ? current : Core.cross(); break;
      default: node = Core.empty();
    }
    this.update(path, node, mode === 'registered' ? key : (mode === 'cross' ? key + '.pod' : null));
  };
  P.focusSlot = function (key) {
    var slot = this.root && this.root.querySelector('.adsp-slot[data-path="' + key + '"]');
    if (!slot) { return; }
    var target = slot.querySelector('.adsp-lookup__input') || slot.querySelector('.adsp-chip__change') || slot.querySelector('.adsp-mode');
    if (target) { target.focus(); }
  };
  P.showErrors = function (errors, focus) {
    this.showAllErrors = true;
    this.lastErrors = errors || this.validate().errors;
    this.render();
    if (focus) { this.focusFirstInvalid(); }
  };
  P.focusFirstInvalid = function () {
    var e = this.lastErrors && this.lastErrors[0];
    if (!e) { return; }
    var key = e.path.join('.');
    var slot = this.root.querySelector('.adsp-slot[data-path="' + key + '"]') || this.root;
    if (slot.scrollIntoView) { slot.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    this.focusSlot(key);
  };
  P.isInvalid = function (key) {
    if (!this.showAllErrors) { return false; }
    return this.lastErrors.some(function (e) { return e.path.join('.') === key; });
  };

  P.render = function () {
    var L = this.L;
    var root = h('div', { class: 'adsp', 'data-max-depth': this.maxDepth });
    root.appendChild(h('div', { class: 'adsp__intro' }, [
      h('div', { class: 'adsp__title', text: L.title }),
      h('p', { class: 'adsp__help', text: L.help })
    ]));
    root.appendChild(this.renderCross(this.tree, [], 1));
    root.appendChild(h('div', { class: 'adsp__preview' }, [
      h('span', { class: 'adsp__preview-label', text: L.previewLabel }),
      this.renderPreview(this.tree)
    ]));
    root.appendChild(this.renderNativeSummary());
    this.statusEl = h('div', { class: 'adsp__status', role: 'status', 'aria-live': 'polite' });
    root.appendChild(this.statusEl);
    this.mount.innerHTML = '';
    this.mount.appendChild(root);
    this.root = root;
    this.renderStatus();
  };

  P.renderPreview = function (tree) {
    var self = this;
    function build(n) {
      var frag = document.createDocumentFragment();
      if (!n || n.type === 'empty') { frag.appendChild(h('span', { class: 'adsp__missing', text: '…' })); return frag; }
      if (n.type === 'cross') {
        frag.appendChild(h('span', { class: 'adsp__paren', text: '(' }));
        frag.appendChild(build(n.pod));
        frag.appendChild(h('span', { class: 'adsp__times', text: ' ' + Core.TIMES + ' ' }));
        frag.appendChild(build(n.pollen));
        frag.appendChild(h('span', { class: 'adsp__paren', text: ')' }));
        return frag;
      }
      if (n.type === 'registered') { frag.appendChild(h('span', { class: 'adsp__name', text: n.name || '…' })); return frag; }
      frag.appendChild(h('span', { class: 'adsp__literal', text: Core.render(n) }));
      return frag;
    }
    var code = h('code', { class: 'adsp__string', 'data-string': Core.render(tree) });
    code.appendChild(build(tree));
    void self;
    return code;
  };

  P.renderNativeSummary = function () {
    var L = this.L;
    var nat = Core.rootToNative(this.tree);
    function describe(side, s) {
      var label = side === 'pod' ? L.pod : L.pollen;
      if (s.mode === 'choose') { return label + ': ' + (s.name || '…'); }
      if (s.mode === 'unknown') { return label + ': unknown'; }
      if (s.mode === 'sdlg') { return label + ': sdlg' + (s.nested ? ' (known cross recorded in the lineage)' : ''); }
      return label + ': …';
    }
    return h('div', { class: 'adsp__native' }, [
      h('span', { class: 'adsp__native-label', text: L.nativeLabel }),
      h('span', { class: 'adsp__native-item', text: describe('pod', nat.pod) }),
      h('span', { class: 'adsp__native-sep', text: ' · ' }),
      h('span', { class: 'adsp__native-item', text: describe('pollen', nat.pollen) })
    ]);
  };

  P.renderStatus = function () {
    var L = this.L, self = this;
    var v = this.validate();
    this.lastErrors = v.errors;
    this.statusEl.innerHTML = '';
    this.statusEl.className = 'adsp__status ' + (v.ok ? 'is-ok' : (this.showAllErrors ? 'is-error' : 'is-pending'));
    if (v.ok) { this.statusEl.appendChild(h('span', { text: '✓ ' + L.complete })); return; }
    if (!this.showAllErrors) {
      var n = Core.countEmpty(this.tree);
      this.statusEl.appendChild(h('span', { text: n ? fmt(L.incomplete, { n: n }) : v.errors[0].message }));
      return;
    }
    var ul = h('ul', { class: 'adsp__errors' });
    v.errors.forEach(function (e) {
      var li = h('li', {}, [h('span', { text: e.message + ' ' })]);
      if (e.path.length) {
        li.appendChild(h('button', { type: 'button', class: 'adsp__fix', text: L.fix, onclick: function () { self.focusSlot(e.path.join('.')); } }));
      }
      ul.appendChild(li);
    });
    this.statusEl.appendChild(h('div', { class: 'adsp__blocked', text: L.blocked }));
    this.statusEl.appendChild(ul);
  };

  P.renderCross = function (node, path, depth) {
    var L = this.L;
    var el = h('div', { class: 'adsp-cross', 'data-depth': depth });
    if (depth > 1) { el.appendChild(h('div', { class: 'adsp-cross__caption', text: fmt(L.crossOf, { side: Core.pathLabel(path) }) })); }
    // Stack the two sides vertically as soon as either side holds a nested cross, so nested
    // generations get the full width instead of a cramped half column.
    var podKey = path.concat('pod').join('.'), pollenKey = path.concat('pollen').join('.');
    var nested = (node.pod && node.pod.type === 'cross') || (node.pollen && node.pollen.type === 'cross') ||
      this.uiMode[podKey] === 'cross' || this.uiMode[pollenKey] === 'cross';
    el.appendChild(h('div', { class: 'adsp-cross__row' + (nested ? ' adsp-cross__row--stacked' : '') }, [
      this.renderSlot(node.pod, path.concat('pod'), depth),
      h('div', { class: 'adsp-cross__op', 'aria-hidden': 'true', text: Core.TIMES }),
      this.renderSlot(node.pollen, path.concat('pollen'), depth)
    ]));
    return el;
  };

  P.renderSlot = function (node, path, depth) {
    var self = this, L = this.L;
    var key = path.join('.');
    var side = path[path.length - 1];
    node = node || Core.empty();
    var uiMode = node.type !== 'empty' ? node.type : (this.uiMode[key] || null);
    var slot = h('div', { class: 'adsp-slot adsp-slot--' + side + (this.isInvalid(key) ? ' is-invalid' : ''), 'data-path': key, 'data-depth': depth });
    slot.appendChild(h('div', { class: 'adsp-slot__label', text: side === 'pod' ? L.pod : L.pollen }));
    var modes = h('div', { class: 'adsp-modes', role: 'group', 'aria-label': Core.pathLabel(path) });
    [['registered', L.modeRegistered], ['sdlg', L.modeSdlg], ['unknown', L.modeUnknown], ['cross', L.modeCross]].forEach(function (pair) {
      var mode = pair[0], disabled = mode === 'cross' && depth >= self.maxDepth;
      modes.appendChild(h('button', {
        type: 'button', class: 'adsp-mode adsp-mode--' + mode + (uiMode === mode ? ' is-active' : ''),
        'aria-pressed': uiMode === mode ? 'true' : 'false', disabled: disabled, title: disabled ? L.depthLimit : null,
        'data-mode': mode, text: pair[1], onclick: function () { self.setMode(path, mode); }
      }));
    });
    slot.appendChild(modes);
    var body = h('div', { class: 'adsp-slot__body' });
    if (uiMode === 'registered') { body.appendChild(node.type === 'registered' ? this.renderChip(node, path) : this.renderLookup(path)); }
    else if (uiMode === 'sdlg') { body.appendChild(h('p', { class: 'adsp-slot__note', text: L.sdlgNote })); }
    else if (uiMode === 'unknown') { body.appendChild(h('p', { class: 'adsp-slot__note', text: L.unknownNote })); }
    else if (uiMode === 'cross') { body.appendChild(h('p', { class: 'adsp-slot__note', text: L.crossNote })); body.appendChild(this.renderCross(node, path, depth + 1)); }
    else { body.appendChild(h('p', { class: 'adsp-slot__note adsp-slot__note--prompt', text: L.choosePrompt })); }
    slot.appendChild(body);
    return slot;
  };

  P.renderChip = function (node, path) {
    var self = this, L = this.L, key = path.join('.');
    return h('div', { class: 'adsp-chip' }, [
      h('span', { class: 'adsp-chip__check', 'aria-hidden': 'true', text: '✓' }),
      h('span', { class: 'adsp-chip__name', text: node.name }),
      node.id ? h('span', { class: 'adsp-chip__id', text: '#' + node.id }) : null,
      h('button', { type: 'button', class: 'adsp-chip__change', text: L.change, onclick: function () { self.uiMode[key] = 'registered'; self.update(path, Core.empty(), key); } })
    ]);
  };

  P.renderLookup = function (path) {
    var self = this, L = this.L, key = path.join('.');
    var id = this.uid + '-' + key.replace(/\./g, '-');
    var minChars = this.minChars, debounceMs = this.debounceMs;
    var wrap = h('div', { class: 'adsp-lookup' });
    var input = h('input', {
      type: 'text', class: 'adsp-lookup__input', id: id + '-input', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': id + '-list', 'aria-haspopup': 'listbox',
      placeholder: fmt(L.lookupPlaceholder, { n: minChars })
    });
    var list = h('ul', { class: 'adsp-lookup__list', id: id + '-list', role: 'listbox', hidden: true });
    var status = h('div', { class: 'adsp-lookup__status', 'aria-live': 'polite' });
    wrap.appendChild(input); wrap.appendChild(list); wrap.appendChild(status);
    var st = { term: '', results: [], active: -1, timer: null, seq: 0, nextPage: null, complete: true, open: false };

    function setStatus(msg) { status.textContent = msg || ''; }
    function close() { st.open = false; st.active = -1; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    function open() { if (!st.results.length) { close(); return; } st.open = true; list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function rank(results, term) {
      var t = term.toLowerCase();
      function score(r) { var n = r.name.toLowerCase(); return n === t ? 0 : (n.indexOf(t) === 0 ? 1 : 2); }
      return results.slice().sort(function (a, b) { var d = score(a) - score(b); return d !== 0 ? d : a.name.localeCompare(b.name); });
    }
    function highlight(i) {
      var items = list.querySelectorAll('[role="option"]');
      items.forEach(function (li, idx) { li.classList.toggle('is-active', idx === i); li.setAttribute('aria-selected', idx === i ? 'true' : 'false'); });
      st.active = i;
      if (i >= 0 && items[i]) { input.setAttribute('aria-activedescendant', items[i].id); if (items[i].scrollIntoView) { items[i].scrollIntoView({ block: 'nearest' }); } }
      else { input.removeAttribute('aria-activedescendant'); }
    }
    function commit(r) {
      clearTimeout(st.timer); st.seq++; if (self.lookup) { self.lookup.abort(); }
      self.update(path, Core.registered(r.id, r.name));
      var chip = self.root.querySelector('.adsp-slot[data-path="' + key + '"] .adsp-chip__change');
      if (chip) { chip.focus(); }
    }
    function renderList() {
      list.innerHTML = '';
      var t = st.term.toLowerCase();
      st.results.forEach(function (r, i) {
        var li = h('li', { role: 'option', id: id + '-opt-' + i, class: 'adsp-lookup__option', 'aria-selected': 'false', 'data-index': i }, [h('span', { class: 'adsp-lookup__optname', text: r.name })]);
        if (r.name.toLowerCase() === t) { li.appendChild(h('span', { class: 'adsp-lookup__badge', text: L.exact })); }
        li.addEventListener('mousedown', function (e) { e.preventDefault(); commit(r); });
        li.addEventListener('mousemove', function () { if (st.active !== i) { highlight(i); } });
        list.appendChild(li);
      });
      if (!st.complete && st.nextPage) {
        var more = h('li', { class: 'adsp-lookup__more' }, [h('button', { type: 'button', class: 'adsp-lookup__morebtn', text: L.loadMore })]);
        more.firstChild.addEventListener('mousedown', function (e) { e.preventDefault(); search(st.term, st.nextPage); });
        list.appendChild(more);
      }
      open();
      if (st.results.length) { highlight(st.results[0].name.toLowerCase() === t ? 0 : -1); }
    }
    function search(term, page) {
      if (!self.lookup) { setStatus(fmt(L.lookupFailed, { reason: 'no lookup configured' })); return; }
      var seq = ++st.seq;
      setStatus(L.searching);
      self.lookup.search(term, page).then(function (out) {
        if (seq !== st.seq || term !== st.term) { return; }
        var merged = page > 1 ? st.results.concat(out.results) : out.results;
        var seen = {}; merged = merged.filter(function (r) { var k = (r.id || '') + '|' + r.name; if (seen[k]) { return false; } seen[k] = true; return true; });
        st.results = rank(merged, term); st.complete = out.complete; st.nextPage = out.nextPage;
        renderList();
        if (!st.results.length) { setStatus(fmt(L.noMatch, { term: term })); }
        else if (st.complete) { setStatus(fmt(L.matches, { n: st.results.length })); }
        else { setStatus(fmt(L.partial, { n: st.results.length })); }
      }).catch(function (err) {
        if (err && err.name === 'AbortError') { return; }
        if (seq !== st.seq) { return; }
        setStatus(fmt(L.lookupFailed, { reason: (err && err.message) || 'network error' }));
      });
    }
    input.addEventListener('input', function () {
      var term = input.value.replace(/\s+/g, ' ').trim();
      st.term = term; clearTimeout(st.timer);
      if (term.length < minChars) { st.seq++; if (self.lookup) { self.lookup.abort(); } st.results = []; close(); setStatus(term ? fmt(L.typeMore, { n: minChars - term.length }) : ''); return; }
      st.timer = setTimeout(function () { search(term, 1); }, debounceMs);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); // never submit the Gravity Form from here
        if (st.open && st.active >= 0 && st.results[st.active]) { commit(st.results[st.active]); }
        else if (st.results.length === 1) { commit(st.results[0]); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!st.open) { open(); } highlight(Math.min(st.active + 1, st.results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(st.active - 1, 0)); }
      else if (e.key === 'Escape') { close(); }
      else if (e.key === 'Tab') { close(); }
    });
    input.addEventListener('focus', function () { if (st.results.length) { open(); } });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    return wrap;
  };

  /* ------------------------------------------------------------------ */
  /* Gravity Forms adapter                                                */
  /* ------------------------------------------------------------------ */
  function fieldContainer(formId, fieldId) { return document.getElementById('field_' + formId + '_' + fieldId); }
  function inputEl(formId, fieldId) { return fieldId ? document.getElementById('input_' + formId + '_' + fieldId) : null; }

  function resolveElements(form, config) {
    var f = config.fields, fid = config.formId;
    var els = {
      podMode: Array.prototype.slice.call(form.querySelectorAll('input[name="input_' + f.podMode + '"]')),
      pollenMode: Array.prototype.slice.call(form.querySelectorAll('input[name="input_' + f.pollenMode + '"]')),
      pod: inputEl(fid, f.pod), pollen: inputEl(fid, f.pollen),
      string: inputEl(fid, f.string) || form.querySelector('.ads-parentage-string input, input.ads-parentage-string'),
      tree: inputEl(fid, f.tree) || form.querySelector('.ads-parentage-tree input, input.ads-parentage-tree'),
      mount: form.querySelector('.ads-parentage-mount') || form.querySelector('.ads-parentage-widget')
    };
    if (!els.mount) {
      var anchor = fieldContainer(fid, f.pollen) || fieldContainer(fid, f.pollenMode);
      if (anchor && anchor.parentNode) {
        els.mount = h('div', { class: 'gfield gfield--width-full ads-parentage-widget ads-parentage-mount', 'data-field-span': '12' });
        anchor.parentNode.insertBefore(els.mount, anchor.nextSibling);
      }
    }
    return els;
  }

  function readNative(els, config) {
    function side(radios, select, mv) {
      var checked = radios.filter(function (r) { return r.checked; })[0];
      var val = checked ? checked.value : '';
      var mode = val === mv.choose ? 'choose' : (val === mv.unknown ? 'unknown' : (val === mv.sdlg ? 'sdlg' : 'empty'));
      var out = { mode: mode };
      if (mode === 'choose' && select && select.value) {
        var opt = select.options[select.selectedIndex];
        out.id = select.value; out.name = opt ? opt.textContent.trim() : '';
      }
      return out;
    }
    return { pod: side(els.podMode, els.pod, config.modeValues.pod), pollen: side(els.pollenMode, els.pollen, config.modeValues.pollen) };
  }

  function fireChange(el) { el.dispatchEvent(new Event('change', { bubbles: true })); }

  function setSelectValue(select, id, name) {
    if (!select) { return; }
    var opt = null;
    for (var i = 0; i < select.options.length; i++) { if (select.options[i].value === String(id)) { opt = select.options[i]; break; } }
    if (!opt) { opt = new Option(name, String(id)); select.appendChild(opt); }
    var ts = select.tomselect;
    if (ts) {
      if (!ts.options[String(id)]) { ts.addOption({ value: String(id), text: name }); }
      ts.setValue(String(id), true);
    }
    select.value = String(id);
    select.disabled = false;
    fireChange(select);
  }
  function clearSelect(select) {
    if (!select) { return; }
    if (select.tomselect) { select.tomselect.clear(true); }
    select.value = '';
    fireChange(select);
  }

  function syncNative(els, config, tree) {
    var nat = Core.rootToNative(tree);
    var formId = config.formId;
    function side(radios, select, mv, s, dependentFieldId) {
      var want = s.mode === 'choose' ? mv.choose : (s.mode === 'unknown' ? mv.unknown : (s.mode === 'sdlg' ? mv.sdlg : null));
      var changed = false;
      radios.forEach(function (r) {
        var shouldCheck = want !== null && r.value === want;
        if (r.checked !== shouldCheck) { r.checked = shouldCheck; changed = true; if (shouldCheck) { fireChange(r); } }
      });
      if (changed && want === null && radios.length) { fireChange(radios[0]); }
      if (changed && typeof window.gf_apply_rules === 'function') { try { window.gf_apply_rules(formId, [dependentFieldId], false); } catch (e) { /* ignore */ } }
      function apply() {
        if (s.mode === 'choose' && (s.id || s.name)) { setSelectValue(select, s.id || s.name, s.name); }
        else { clearSelect(select); }
      }
      apply();
      // Conditional logic may reset the select when it shows the field; reapply after it settles.
      setTimeout(apply, 0); setTimeout(apply, 120);
    }
    side(els.podMode, els.pod, config.modeValues.pod, nat.pod, config.fields.pod);
    side(els.pollenMode, els.pollen, config.modeValues.pollen, nat.pollen, config.fields.pollen);
  }

  function writeHidden(els, state) {
    if (els.string) { els.string.value = state.valid ? state.string : ''; }
    if (els.tree) { els.tree.value = Core.toJSON(state.tree); }
  }

  function hideNative(config) {
    [config.fields.podMode, config.fields.pollenMode, config.fields.pod, config.fields.pollen].forEach(function (id) {
      var c = fieldContainer(config.formId, id);
      if (c) { c.classList.add('adsp-native-hidden'); c.setAttribute('aria-hidden', 'true'); }
    });
  }

  /** Snapshot of the form's values keyed by field id, like GP Populate Anything sends. */
  function collectFieldValues(form) {
    var out = {};
    Array.prototype.forEach.call(form.querySelectorAll('input[name^="input_"], select[name^="input_"], textarea[name^="input_"]'), function (el) {
      if (el.disabled || el.type === 'file') { return; }
      var m = /^input_([0-9]+(?:\.[0-9]+)?)(\[\])?$/.exec(el.name);
      if (!m) { return; }
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) { return; }
      var key = m[1];
      if (el.multiple) { out[key] = Array.prototype.map.call(el.selectedOptions, function (o) { return o.value; }); if (!out[key].length) { out[key] = ['']; } return; }
      if (m[2]) { out[key] = (out[key] || []).concat(el.value); return; }
      if (!(key in out)) { out[key] = el.value; }
    });
    return out;
  }

  function installGuards(form, config, widget) {
    function allow(type) {
      var v = widget.validate();
      if (v.ok) { return true; }
      if (type === 'save-continue' && !config.blockDraftWhenInvalid) { return true; }
      widget.showErrors(v.errors, true);
      return false;
    }
    // 1) Gravity Forms' own button handler (used by Submit, Save Draft and the theme's approval flow).
    function patch() {
      var g = window.gform;
      if (!g || !g.submission || typeof g.submission.handleButtonClick !== 'function' || g.submission.__adspPatched) { return !!(g && g.submission && g.submission.__adspPatched); }
      var orig = g.submission.handleButtonClick;
      g.submission.handleButtonClick = function (button) {
        var f = button && button.form;
        if (f && f.id === 'gform_' + config.formId) {
          var type = (button.getAttribute && button.getAttribute('data-submission-type')) || 'submit';
          if (!allow(type)) { return false; }
        }
        return orig.apply(this, arguments);
      };
      g.submission.__adspPatched = true;
      return true;
    }
    if (!patch()) { document.addEventListener('gform_main_scripts_loaded', patch); window.addEventListener('load', patch); }
    // 2) The theme's "Submit for Approval" checkbox triggers a submit; stop it before the theme sees it.
    if (config.approvalCheckboxId) {
      document.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.id === config.approvalCheckboxId && t.checked && !allow('submit')) {
          e.stopImmediatePropagation(); e.preventDefault(); t.checked = false;
        }
      }, true);
    }
    // 3) Native submit event, in case anything submits the form directly.
    form.addEventListener('submit', function (e) {
      var saveField = form.querySelector('input[name="gform_save"]');
      var saving = saveField && saveField.value === '1';
      if (!allow(saving ? 'save-continue' : 'submit')) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  var GF = {
    config: null,
    init: function (userConfig) {
      var config = merge(DEFAULTS, userConfig || {});
      GF.config = config;
      var form = document.getElementById('gform_' + config.formId);
      if (!form || form.getAttribute('data-adsp-init') === '1') { return null; }
      var els = resolveElements(form, config);
      if (!els.mount) { if (window.console) { console.warn('[ads-parentage] no mount point and no pollen-parent field found; widget not shown'); } return null; }
      form.setAttribute('data-adsp-init', '1');
      var lookup = createLookup(merge(config.lookup, { formId: config.formId, getFieldValues: function () { return collectFieldValues(form); } }));
      var tree = Core.fromJSON(els.tree && els.tree.value) || Core.fromNative(readNative(els, config));
      var widget = new ParentageWidget(els.mount, {
        tree: tree, lookup: lookup, maxDepth: config.maxDepth, minChars: config.lookup.minChars, debounceMs: config.lookup.debounceMs,
        requireIds: config.requireIds, labels: config.labels,
        onChange: function (state) { writeHidden(els, state); syncNative(els, config, state.tree); }
      });
      if (config.hideNativeFields) { hideNative(config); }
      installGuards(form, config, widget);
      widget.emit();
      window.ADSParentage.instances[config.formId] = widget;
      return widget;
    }
  };

  window.ADSParentage = { Core: Core, createLookup: createLookup, ParentageWidget: ParentageWidget, GF: GF, instances: {}, collectFieldValues: collectFieldValues };

  function boot() {
    var cfg = window.adsParentageConfig;
    if (cfg) { GF.init(cfg); }
  }
  if (window.jQuery) {
    window.jQuery(document).on('gform_post_render', function (e, formId) {
      var cfg = window.adsParentageConfig;
      if (cfg && String(formId) === String(cfg.formId)) { GF.init(cfg); }
    });
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); } else { boot(); }
  window.addEventListener('load', boot);
}(window, document));
