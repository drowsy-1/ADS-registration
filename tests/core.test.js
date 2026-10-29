'use strict';
// Run: node tests/core.test.js
const assert = require('assert');
const Core = require('../ads-parentage/assets/parentage-core.js');
const X = Core.TIMES;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } }

const A = Core.registered(9333, 'Heavenly Delight');
const B = Core.registered(9327, "Heaven's Gate");
const C = Core.registered(91789, "'S Wonderful, 'S Marvelous");

console.log('render');
test('simple cross uses × with single spaces and one paren pair', () => {
  assert.strictEqual(Core.render(Core.cross(A, Core.sdlg())), '(Heavenly Delight ' + X + ' sdlg)');
});
test('nested cross: one paren pair per ×, no spaces inside parens', () => {
  const t = Core.cross(Core.cross(A, B), Core.cross(C, Core.unknown()));
  assert.strictEqual(Core.render(t), "((Heavenly Delight " + X + " Heaven's Gate) " + X + " ('S Wonderful, 'S Marvelous " + X + " unknown))");
});
test('multiplication sign is U+00D7, never x', () => {
  assert.strictEqual(X, '×');
  assert.ok(!/ x /.test(Core.render(Core.cross(A, B))));
});

console.log('validate');
test('complete tree is valid and the string matches render()', () => {
  const t = Core.cross(A, Core.cross(B, Core.sdlg()));
  const v = Core.validate(t, { maxDepth: 4, requireIds: true });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  assert.strictEqual(v.string, Core.render(t));
});
test('empty slot is reported with a readable path', () => {
  const v = Core.validate(Core.cross(A, Core.cross(Core.empty(), B)));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.errors[0].code, 'empty');
  assert.strictEqual(v.errors[0].label, 'Pod parent (pollen side)');
  assert.strictEqual(v.string, '');
});
test('depth limit is enforced', () => {
  const deep = Core.cross(Core.cross(Core.cross(Core.cross(Core.cross(A, B), B), B), B), B); // depth 5
  assert.strictEqual(Core.depth(deep), 5);
  const v = Core.validate(deep, { maxDepth: 4 });
  assert.ok(v.errors.some(e => e.code === 'depth'));
  assert.strictEqual(Core.validate(deep, { maxDepth: 5 }).ok, true);
});
test('root must be a cross', () => {
  assert.strictEqual(Core.validate(A).ok, false);
  assert.strictEqual(Core.validate(null).errors[0].code, 'bad-root');
});
test('requireIds rejects a name without a registry id', () => {
  const v = Core.validate(Core.cross(Core.registered(null, 'Stella de Oro'), Core.sdlg()), { requireIds: true });
  assert.ok(v.errors.some(e => e.code === 'missing-id'));
  assert.strictEqual(Core.validate(Core.cross(Core.registered(null, 'Stella de Oro'), Core.sdlg()), { requireIds: false }).ok, true);
});
test('names with parentheses, × or stray spaces are rejected', () => {
  assert.ok(Core.validate(Core.cross(Core.registered(1, 'Bad (Name)'), B)).errors.some(e => e.code === 'bad-name'));
  assert.ok(Core.validate(Core.cross(Core.registered(1, 'A ' + X + ' B'), B)).errors.some(e => e.code === 'bad-name'));
  assert.ok(Core.validate(Core.cross({ type: 'registered', id: '1', name: 'Two  Spaces' }, B)).errors.some(e => e.code === 'bad-name'));
});

console.log('isWellFormed (string self-check)');
const names = ['Stella de Oro', 'Heavenly Delight', "Heaven's Gate"];
test('accepts the canonical forms', () => {
  ['(Stella de Oro ' + X + ' sdlg)', '((Stella de Oro ' + X + ' Heavenly Delight) ' + X + ' unknown)',
   "((Stella de Oro " + X + " sdlg) " + X + " (Heavenly Delight " + X + " Heaven's Gate))", '(unknown ' + X + ' unknown)']
    .forEach(s => assert.strictEqual(Core.isWellFormed(s, names), true, s));
});
test('rejects the known-bad forms', () => {
  ['Stella de Oro ' + X + ' sdlg', '(Stella de Oro x sdlg)', '( Stella de Oro ' + X + ' sdlg )', '((Stella de Oro ' + X + ' sdlg) ' + X + ' )',
   '(Stella de Oro ' + X + ' Sdlg.)', '(Stella de Oro ' + X + ' Heavenly Delight ' + X + " Heaven's Gate)", '(Stella de Oro ' + X + ' Nobody Home)', '']
    .forEach(s => assert.strictEqual(Core.isWellFormed(s, names), false, s || '<empty>'));
});
test('a registered name that contains a literal is still handled (longest-first substitution)', () => {
  assert.strictEqual(Core.isWellFormed('(Unknown Soldier ' + X + ' unknown)', ['Unknown Soldier']), true);
});

console.log('serialisation');
test('toJSON/fromJSON round-trips and strips stray props', () => {
  const t = Core.cross(A, Core.cross(B, Core.unknown()));
  t.pod.extra = 'junk';
  const back = Core.fromJSON(Core.toJSON(t));
  assert.deepStrictEqual(back, Core.cross(Core.registered('9333', 'Heavenly Delight'), Core.cross(Core.registered('9327', "Heaven's Gate"), Core.unknown())));
  assert.strictEqual(Core.fromJSON('not json'), null);
  assert.strictEqual(Core.fromJSON('{"type":"registered"}'), null);
});

console.log('native mapping');
test('root maps onto the native fields; a nested cross becomes sdlg', () => {
  const nat = Core.rootToNative(Core.cross(Core.cross(A, B), C));
  assert.strictEqual(nat.pod.mode, 'sdlg'); assert.strictEqual(nat.pod.nested, true);
  assert.deepStrictEqual(nat.pollen, { mode: 'choose', id: '91789', name: "'S Wonderful, 'S Marvelous" });
  assert.strictEqual(Core.rootToNative(Core.cross(Core.unknown(), Core.empty())).pollen.mode, 'empty');
});
test('fromNative rebuilds a root from the four native values', () => {
  const t = Core.fromNative({ pod: { mode: 'choose', id: '9333', name: 'Heavenly Delight' }, pollen: { mode: 'sdlg' } });
  assert.strictEqual(Core.render(t), '(Heavenly Delight ' + X + ' sdlg)');
  assert.strictEqual(Core.fromNative({ pod: { mode: 'choose' }, pollen: { mode: 'unknown' } }).pod.type, 'empty');
});
test('getAt/setAt/countEmpty/hasContent', () => {
  const t = Core.cross();
  Core.setAt(t, ['pod'], Core.cross());
  assert.strictEqual(Core.countEmpty(t), 3);
  Core.setAt(t, ['pod', 'pollen'], A);
  assert.strictEqual(Core.getAt(t, ['pod', 'pollen']).name, 'Heavenly Delight');
  assert.strictEqual(Core.hasContent(t.pod), true);
  assert.strictEqual(Core.hasContent(t.pollen), false);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
