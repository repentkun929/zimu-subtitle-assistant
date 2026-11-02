/**
 * 诊断逻辑的测试。
 *
 * 这段代码的价值全在“结论是否正确”：把跨域污染误判成播放器问题，
 * 用户会去折腾播放器；把非安全上下文误判成跨域，用户会去找运维。
 * 所以三种典型故障各写一条，锁死分类结果。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/** 加载 capture.js，只取诊断相关函数。 */
async function loadCapture() {
  const code = await readFile(path.join(distDir, 'content', 'capture.js'), 'utf8');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    URL,
    Blob,
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: sandbox.__drawImage
        })
      })
    },
    window: { isSecureContext: true },
    location: { href: 'https://example.com/lesson/1' },
    MediaRecorder: class {},
    __drawImage: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'capture.js' }).runInContext(sandbox);
  return sandbox.__ZIMU__;
}

/** 造一个诊断报告的基准对象，各测试只覆盖关心的字段。 */
function makeReport(overrides = {}) {
  return {
    hasMedia: true,
    hasCaptureStream: true,
    hasMediaRecorder: true,
    currentSrc: 'https://cdn.other.com/a.mp4',
    crossOriginAttr: null,
    duration: 300,
    paused: false,
    audioTracks: [{ label: 'MediaStreamAudioDestinationNode', muted: false, readyState: 'live' }],
    tainted: false,
    taintError: null,
    recorderStartOk: true,
    recorderError: null,
    measures: { rms: 0.05, peak: 0.4 },
    recordedBytes: 4096,
    ...overrides
  };
}

test('正常情况给出“可以正常识别”的结论', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(makeReport());
  assert.match(text, /【结论】音频采集链路看起来正常/);
});

test('跨域污染 → 指向同源策略，并给出运维层面的解法', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(
    makeReport({
      tainted: true,
      taintError: 'Failed to execute drawImage: tainted canvas',
      measures: { rms: 0, peak: 0 }
    })
  );
  assert.match(text, /【结论】视频与页面不同域/);
  assert.match(text, /Access-Control-Allow-Origin/, '应给出具体的响应头名称');
  assert.match(text, /系统级录音/, '应给出绕不过去时的替代方案');
});

test('音轨 muted → 指向播放器，不要误报成跨域', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(
    makeReport({ audioTracks: [{ label: 'audio', muted: true, readyState: 'live' }] })
  );
  assert.match(text, /【结论】音轨处于 muted/);
  assert.doesNotMatch(text, /Access-Control-Allow-Origin/, '不应误判为跨域问题');
});

test('没有音轨 → 指向静音视频或播放器实现', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(makeReport({ audioTracks: [] }));
  assert.match(text, /【结论】视频流里没有音轨/);
});

test('录音格式全部被拒 → 结论指向格式/环境，不误判成音轨或跨域', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(
    makeReport({
      isSecureContext: false,
      pageUrl: 'http://172.18.0.1/sections/abc',
      recorderStartOk: false,
      recorderError: 'NotSupportedError: There was an error starting the MediaRecorder',
      optionResults: [
        { label: 'audio/webm;codecs=opus @ 64kbps', ok: false, error: 'NotSupportedError: nope' },
        { label: 'audio/webm;codecs=opus', ok: false, error: 'NotSupportedError: nope' },
        { label: '浏览器默认', ok: false, error: 'NotSupportedError: nope' }
      ]
    })
  );
  // 报告要标出安全上下文状态
  assert.match(text, /安全上下文：否/, '报告应标出非安全上下文');
  // 结论要落在“格式/环境不被接受”，并且列出逐组实测证据
  assert.match(text, /NotSupportedError/, '应指出这是格式/环境类错误');
  assert.match(text, /录音参数实测：/, '应列出逐组实测结果');
  assert.match(text, /✗ audio\/webm/, '应逐条列出失败的参数组合');
  // 不能误判成另外两类问题，否则用户会去找错人
  assert.doesNotMatch(text, /Access-Control-Allow-Origin/, '不应误判为跨域问题');
  assert.doesNotMatch(text, /音轨处于 muted/, '不应误判为音轨问题');
});

test('某组参数可用时，诊断要报出可用组合', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(
    makeReport({
      recorderStartOk: true,
      workingOptions: 'audio/webm;codecs=opus',
      optionResults: [
        { label: 'audio/webm;codecs=opus @ 64kbps', ok: false, error: 'NotSupportedError: nope' },
        { label: 'audio/webm;codecs=opus', ok: true, bytes: 8192 }
      ]
    })
  );
  assert.match(text, /✓ audio\/webm;codecs=opus/);
  assert.match(text, /可用参数组合：audio\/webm;codecs=opus/);
  assert.match(text, /【结论】音频采集链路看起来正常/);
});

test('页面里没有视频 → 提示先播放视频再重试', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(makeReport({ hasMedia: false }));
  assert.match(text, /【结论】这个页面里没找到可用的 <video>/);
});

test('浏览器不支持 captureStream → 提示换浏览器', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(makeReport({ hasCaptureStream: false }));
  assert.match(text, /【结论】浏览器不支持 captureStream/);
});

test('录音能启动但内容近乎静音 → 仍归因于跨域采集被静音', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(makeReport({ measures: { rms: 0.0001, peak: 0.001 } }));
  assert.match(text, /【结论】录音能启动，但录到的是近乎静音/);
});

test('诊断报告包含排查所需的原始数据', async () => {
  const NS = await loadCapture();
  const text = NS.explainDiagnosis(makeReport({ crossOriginAttr: 'anonymous' }));
  assert.match(text, /视频地址：/);
  assert.match(text, /crossorigin 属性：anonymous/);
  assert.match(text, /音频音轨数：1/);
  assert.match(text, /跨域污染检测：正常/);
  assert.match(text, /安全上下文：/);
});
