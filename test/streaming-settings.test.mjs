/**
 * 流式识别相关设置的单元测试。
 *
 * 这些默认值和钳位规则看着琐碎，但它们直接决定「会不会连着发几百个请求」：
 * 切片秒数一旦被写成 0，采集器就会以接近零的间隔不停开窗；
 * 重叠一旦大于切片本身，窗口之间就会全部互相覆盖。
 * 所以边界必须在归一化这一层就钉死，而不是指望调用方自觉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, DEFAULT_SETTINGS } from '../dist/common/settings.js';

test('默认开启流式识别，并给出可用的切片参数', () => {
  const s = normalizeSettings({});
  assert.equal(s.streaming, true, '默认应开启流式（这是延迟最低的模式）');
  assert.equal(s.streamSliceSeconds, DEFAULT_SETTINGS.streamSliceSeconds);
  assert.equal(s.streamOverlapSeconds, DEFAULT_SETTINGS.streamOverlapSeconds);
  assert.ok(s.streamSliceSeconds >= 1, '默认切片不能小于 1 秒');
});

test('显式关掉流式时不会被默认值覆盖', () => {
  assert.equal(normalizeSettings({ streaming: false }).streaming, false);
});

test('切片秒数被钳在 1~5 秒之间', () => {
  assert.equal(normalizeSettings({ streamSliceSeconds: 0 }).streamSliceSeconds, 1);
  assert.equal(normalizeSettings({ streamSliceSeconds: -3 }).streamSliceSeconds, 1);
  assert.equal(normalizeSettings({ streamSliceSeconds: 60 }).streamSliceSeconds, 5);
  assert.equal(normalizeSettings({ streamSliceSeconds: 2.4 }).streamSliceSeconds, 2.4);
});

test('切片重叠被钳在 0~2 秒之间', () => {
  assert.equal(normalizeSettings({ streamOverlapSeconds: -1 }).streamOverlapSeconds, 0);
  assert.equal(normalizeSettings({ streamOverlapSeconds: 9 }).streamOverlapSeconds, 2);
  assert.equal(normalizeSettings({ streamOverlapSeconds: 0.5 }).streamOverlapSeconds, 0.5);
});

test('切片参数坏值时退回默认，不产生 NaN', () => {
  const s = normalizeSettings({ streamSliceSeconds: 'abc', streamOverlapSeconds: undefined });
  assert.equal(s.streamSliceSeconds, DEFAULT_SETTINGS.streamSliceSeconds);
  assert.equal(s.streamOverlapSeconds, DEFAULT_SETTINGS.streamOverlapSeconds);
});
