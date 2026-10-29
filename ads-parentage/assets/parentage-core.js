/*!
 * ADS Parentage – core model (no DOM, no network).
 * Shared by the browser widget, the demo page and the Node tests.
 *
 * A parentage is a tree. Every node is one of:
 *   { type: 'cross', pod: node, pollen: node }   one "(pod × pollen)" pair
 *   { type: 'registered', id, name }             a cultivar picked from the registry lookup
 *   { type: 'sdlg' }                             an unregistered seedling
 *   { type: 'unknown' }                          identity not known
 *   { type: 'empty' }                            not chosen yet (never valid for submission)
 *
 * The tree is the source of truth. The string "(A × (B × sdlg))" is only ever
 * rendered FROM the tree, never parsed from user input.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.ADSParentageCore = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TIMES = '×';   // × U+00D7, never the letter x
  var SDLG = 'sdlg';
  var UNKNOWN = 'unknown';
  var TYPES = ['cross', 'registered', 'sdlg', 'unknown', 'empty'];

  function empty() { return { type: 'empty' }; }
  function sdlg() { return { type: 'sdlg' }; }
  function unknown() { return { type: 'unknown' }; }
  function registered(id, name) {
    var hasId = !(id === undefined || id === null || id === '');
    return { type: 'registered', id: hasId ? String(id) : null, name: String(name == null ? '' : name).trim() };
  }
  function cross(pod, pollen) { return { type: 'cross', pod: pod || empty(), pollen: pollen || empty() }; }

  /** Canonical string. Empty nodes render as '' (the validator rejects them). */
  function render(node) {
    if (!node) { return ''; }
    switch (node.type) {
      case 'cross': return '(' + render(node.pod) + ' ' + TIMES + ' ' + render(node.pollen) + ')';
      case 'registered': return node.name || '';
      case 'sdlg': return SDLG;
      case 'unknown': return UNKNOWN;
      default: return '';
    }
  }

  /** Number of nested cross levels. A plain "(A × B)" has depth 1. */
  function depth(node) {
    return node && node.type === 'cross' ? 1 + Math.max(depth(node.pod), depth(node.pollen)) : 0;
  }

  function walk(node, fn, path) {
    path = path || [];
    fn(node, path);
    if (node && node.type === 'cross') {
      walk(node.pod, fn, path.concat('pod'));
      walk(node.pollen, fn, path.concat('pollen'));
    }
  }

  function getAt(tree, path) {
    var n = tree;
    for (var i = 0; i < path.length; i++) {
      if (!n || n.type !== 'cross') { return null; }
      n = n[path[i]];
    }
    return n;
  }

  /** Returns the (possibly new) tree. Replacing the root returns the new node. */
  function setAt(tree, path, node) {
    if (!path.length) { return node; }
    var parent = getAt(tree, path.slice(0, -1));
    if (parent && parent.type === 'cross') { parent[path[path.length - 1]] = node; }
    return tree;
  }

  function hasContent(node) {
    if (!node) { return false; }
    if (node.type === 'cross') { return hasContent(node.pod) || hasContent(node.pollen); }
    return node.type !== 'empty';
  }

  function leafNames(tree) {
    var out = [];
    walk(tree, function (n) { if (n && n.type === 'registered' && n.name) { out.push(n.name); } });
    return out;
  }

  function countEmpty(tree) {
    var c = 0;
    walk(tree, function (n) { if (!n || n.type === 'empty') { c++; } });
    return c;
  }

  function pathLabel(path) {
    if (!path.length) { return 'Parentage'; }
    var side = path[path.length - 1] === 'pod' ? 'Pod parent' : 'Pollen parent';
    if (path.length === 1) { return side; }
    var where = path.slice(0, -1).map(function (p) { return p === 'pod' ? 'pod side' : 'pollen side'; }).join(' › ');
    return side + ' (' + where + ')';
  }

  /**
   * Structural validation.
   * opts.maxDepth   (default 4)  maximum nested cross levels
   * opts.requireIds (default false) registered leaves must carry the registry id
   */
  function validate(tree, opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth || 4;
    var requireIds = !!opts.requireIds;
    var errors = [];
    function err(path, code, message) { errors.push({ path: path, code: code, message: message, label: pathLabel(path) }); }

    if (!tree || tree.type !== 'cross') {
      err([], 'bad-root', 'Parentage must be a single cross: pod parent ' + TIMES + ' pollen parent.');
      return { ok: false, errors: errors, string: '' };
    }
    walk(tree, function (n, path) {
      if (!n || TYPES.indexOf(n.type) < 0) { err(path, 'bad-type', pathLabel(path) + ': unrecognised entry.'); return; }
      if (n.type === 'empty') { err(path, 'empty', pathLabel(path) + ' has not been chosen.'); }
      if (n.type === 'registered') {
        var name = n.name || '';
        if (!name) { err(path, 'missing-name', pathLabel(path) + ' has no cultivar name.'); }
        else if (name !== name.trim() || /\s{2,}/.test(name)) { err(path, 'bad-name', pathLabel(path) + ': name has stray spaces.'); }
        else if (/[()×]/.test(name)) { err(path, 'bad-name', pathLabel(path) + ': name may not contain parentheses or ' + TIMES + '.'); }
        if (requireIds && !n.id) { err(path, 'missing-id', pathLabel(path) + ' must be picked from the registered-name list.'); }
      }
    });
    var d = depth(tree);
    if (d > maxDepth) { err([], 'depth', 'Parentage is nested ' + d + ' generations deep; the limit is ' + maxDepth + '.'); }
    var str = errors.length ? '' : render(tree);
    if (!errors.length && !isWellFormed(str, leafNames(tree))) { err([], 'malformed', 'Generated parentage string failed the structure check.'); }
    return { ok: errors.length === 0, errors: errors, string: str };
  }

  /**
   * Self-check of a rendered string: substitute each registered name with the
   * token N (longest first), then repeatedly collapse "(X × Y)" into C.
   * A well-formed string collapses to exactly "C", which proves balanced
   * parentheses, one pair per ×, exact spacing and an allowed leaf set.
   */
  function isWellFormed(str, names) {
    if (typeof str !== 'string' || !str) { return false; }
    var s = str;
    var sorted = (names || []).slice().sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < sorted.length; i++) { if (sorted[i]) { s = s.split(sorted[i]).join('N'); } }
    var re = /\((N|sdlg|unknown|C) × (N|sdlg|unknown|C)\)/g;
    var prev;
    do { prev = s; s = s.replace(re, 'C'); } while (s !== prev);
    return s === 'C';
  }

  /** Strip to the canonical shape (drops any stray properties). */
  function strip(n) {
    if (!n || typeof n !== 'object') { return empty(); }
    switch (n.type) {
      case 'cross': return { type: 'cross', pod: strip(n.pod), pollen: strip(n.pollen) };
      case 'registered': return registered(n.id, n.name);
      case 'sdlg': return sdlg();
      case 'unknown': return unknown();
      default: return empty();
    }
  }
  function toJSON(tree) { return JSON.stringify(strip(tree)); }
  function fromJSON(json) {
    if (!json) { return null; }
    var obj;
    try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return null; }
    if (!obj || obj.type !== 'cross') { return null; }
    return strip(obj);
  }

  /**
   * The native form only knows the immediate parents. A nested cross on either
   * side is, by the registrar's rule, an unregistered seedling -> 'sdlg'.
   */
  function rootToNative(tree) {
    function side(n) {
      if (!n) { return { mode: 'empty' }; }
      if (n.type === 'registered') { return { mode: 'choose', id: n.id, name: n.name }; }
      if (n.type === 'unknown') { return { mode: 'unknown' }; }
      if (n.type === 'sdlg' || n.type === 'cross') { return { mode: 'sdlg', nested: n.type === 'cross' }; }
      return { mode: 'empty' };
    }
    return { pod: side(tree && tree.pod), pollen: side(tree && tree.pollen) };
  }
  function fromNative(native) {
    function leaf(s) {
      if (!s) { return empty(); }
      if (s.mode === 'choose') { return (s.id || s.name) ? registered(s.id, s.name) : empty(); }
      if (s.mode === 'unknown') { return unknown(); }
      if (s.mode === 'sdlg') { return sdlg(); }
      return empty();
    }
    return cross(leaf(native && native.pod), leaf(native && native.pollen));
  }

  return {
    TIMES: TIMES, SDLG: SDLG, UNKNOWN: UNKNOWN, TYPES: TYPES,
    empty: empty, sdlg: sdlg, unknown: unknown, registered: registered, cross: cross,
    render: render, depth: depth, walk: walk, getAt: getAt, setAt: setAt, hasContent: hasContent,
    leafNames: leafNames, countEmpty: countEmpty, pathLabel: pathLabel,
    validate: validate, isWellFormed: isWellFormed,
    strip: strip, toJSON: toJSON, fromJSON: fromJSON, rootToNative: rootToNative, fromNative: fromNative
  };
}));
