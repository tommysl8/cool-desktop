// node --test tests/color.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { contrast, formatRatio, hexToRgb, isHex6, relLuminance, rgbToHex, withAlpha } from '../tools/lib/color.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ~${b}`);

test('black on white is 21:1 in both orders, same color is 1:1', () => {
  near(contrast('#000', '#fff'), 21);
  near(contrast('#000000', '#ffffff'), 21);
  near(contrast('#ffffff', '#000000'), 21);
  near(contrast('#33ff66', '#33ff66'), 1);
});

test('known WCAG reference values around the 4.5:1 line', () => {
  // #767676 is the classic lightest gray that passes AA on white; #777777 fails.
  assert.equal(formatRatio(contrast('#767676', '#ffffff')), '4.54');
  assert.ok(contrast('#767676', '#ffffff') >= 4.5);
  assert.equal(formatRatio(contrast('#777777', '#ffffff')), '4.47');
  assert.ok(contrast('#777777', '#ffffff') < 4.5);
});

test('relative luminance of primaries', () => {
  near(relLuminance('#ffffff'), 1);
  near(relLuminance('#000000'), 0);
  near(relLuminance('#ff0000'), 0.2126);
  near(relLuminance('#00ff00'), 0.7152);
  near(relLuminance('#0000ff'), 0.0722);
  near(relLuminance([255, 255, 255]), 1);
});

test('hexToRgb / rgbToHex', () => {
  assert.deepEqual(hexToRgb('#33ff66'), [51, 255, 102]);
  assert.deepEqual(hexToRgb('#33FF66'), [51, 255, 102]);
  assert.deepEqual(hexToRgb('#abc'), [170, 187, 204]);
  assert.throws(() => hexToRgb('red'), /not a #rrggbb/);
  assert.throws(() => hexToRgb('#12345'), /not a #rrggbb/);
  assert.throws(() => hexToRgb(123), /expected a string/);
  assert.equal(rgbToHex([51, 255, 102]), '#33ff66');
  assert.equal(rgbToHex([300, -5, 127.6]), '#ff0080');
});

test('isHex6, withAlpha, formatRatio never rounds a fail up to a pass', () => {
  assert.equal(isHex6('#0b140c'), true);
  assert.equal(isHex6('#0b14'), false);
  assert.equal(isHex6('0b140c'), false);
  assert.equal(isHex6(null), false);
  assert.equal(withAlpha('#0b140c', 0.85), 'rgba(11, 20, 12, 0.85)');
  assert.equal(withAlpha('#33ff66', 0.45), 'rgba(51, 255, 102, 0.45)');
  assert.equal(formatRatio(4.4999), '4.49');
  assert.equal(formatRatio(21), '21.00');
});
