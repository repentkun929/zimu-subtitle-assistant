/**
 * 录音参数备选链的测试。
 *
 * 背景是一个真实故障：用户机器上 MediaRecorder.isTypeSupported()
 * 报告支持 audio/webm;codecs=opus，但带 { mimeType, audioBitsPerSecond }
 * 调用 start() 时会抛 NotSupportedError。原代码只挑一个“报告支持”的格式，
 * 于是整段字幕功能直接不可用。
 *
 * 现在的要求是：逐个实测参数组合，只要有一组能 start() 成功就必须能用起来。
 * 这里用可控的 MediaRecorder 桩件把各种拒绝情况都跑一遍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/**
 * 造一个 MediaRecorder 桩件。
 * @param {(options: object) => {ok: boolean, error?: string}} decide
 *        给定参数组合，返回是否允许启动；不允许时给出错误信息。
 */
function makeRecorderStub(decide) {
  const attempts = [];

  class FakeMediaRecorder {
    static isTypeSupported(type) {
      return /webm|ogg|mp4/.test(type);
    }
    constructor(stream, options = {}) {
      this.stream = stream;
      this.options = options || {};
      this.state = 'inactive';
      this.listeners = new Map();
      this.mimeType = this.options.mimeType || 'audio/webm';
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    }
    emit(type, payload) {
      for (const fn of this.listeners.get(type) || []) fn(payload || {});
    }
    start() {
      const verdict = decide(this.options);
      attempts.push({ options: this.options, ok: verdict.ok, error: verdict.error });
      if (!verdict.ok) {
        const err = new Error(verdict.error || 'There was an error starting the MediaRecorder');
        err.name = verdict.name || 'NotSupportedError';
        throw err;
      }
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.emit('dataavailable', { data: new Blob([new Uint8Array(64)], { type: this.mimeType }) });
      this.emit('stop');
    }
  }

  return { FakeMediaRecorder, attempts };
}

/** 造一个能驱动 AudioChunkCapturer 的最小环境。 */
async function loadCapturer({ decide } = {}) {
  const code = await readFile(path.join(distDir, 'content', 'capture.js'), 'utf8');
  const { FakeMediaRecorder, attempts } = makeRecorderStub(decide || (() => ({ ok: true })));

  const audioTrack = { label: 'audio', enabled: true, muted: false, readyState: 'live', stop() {} };
  const stream = {
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack],
    addEventListener: () => {}
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    URL,
    Blob,
    MediaRecorder: FakeMediaRecorder,
    document: { createElement: () => ({ getContext: () => ({ drawImage: () => {} }) }) },
    window: { isSecureContext: true },
    location: { href: 'https://example.com/lesson' },
    AudioContext: undefined
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'capture.js' }).runInContext(sandbox);

  const media = {
    currentTime: 0,
    paused: false,
    duration: 600,
    captureStream: () => stream
  };

  const events = [];
  const capturer = new sandbox.__ZIMU__.AudioChunkCapturer(media, {
    chunkSeconds: 4,
    overlapSeconds: 1,
    onChunk: (chunk) => events.push(chunk),
    onStatus: (status) => events.push(status),
    log: () => {}
  });
  created.push(capturer);

  /* 采集器的流现在由上层提供（元素模式或标签页模式），
   * 所以测试里要显式把流传进去。 */
  const startWithStream = (info) => capturer.start(stream, info || { mode: 'element' });

  return { capturer, attempts, events, media, NS: sandbox.__ZIMU__, stream, startWithStream };
}

/* 采集器内部有 setInterval 定时器（负责按窗口切块）。
 * 测试结束若不停止，定时器会一直挂着，Node 进程不退出——
 * 表现就是测试看起来“卡死”。这里统一兜底清理。 */
const created = [];
test.afterEach(async () => {
  for (const capturer of created.splice(0)) {
    try {
      await capturer.stop('test-cleanup');
    } catch (err) {
      /* 已停止就忽略 */
    }
  }
});

test('首选参数可用时直接用首选，不做多余尝试', async () => {
  const { capturer, attempts, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();
  assert.equal(capturer.state, 'recording');
  assert.equal(attempts.length, 1, '只应尝试一次');
  assert.equal(attempts[0].options.mimeType, 'audio/webm;codecs=opus');
  capturer.stop();
});

test('带码率的组合被拒绝时，自动退到不带码率的组合', async () => {
  // 精确复现用户遇到的情况：带 audioBitsPerSecond 就失败
  const { capturer, attempts, startWithStream } = await loadCapturer({
    decide: (options) =>
      options.audioBitsPerSecond
        ? { ok: false, error: 'There was an error starting the MediaRecorder' }
        : { ok: true }
  });
  startWithStream();
  assert.equal(capturer.state, 'recording', '必须能退到可用组合并成功启动');
  assert.ok(attempts.length >= 2, `应尝试多个组合，实际 ${attempts.length}`);
  assert.ok(attempts[0].options.audioBitsPerSecond, '第一次应带码率');
  const winner = attempts.find((a) => a.ok);
  assert.equal(winner.options.audioBitsPerSecond, undefined, '成功的那次不应带码率');
  capturer.stop();
});

test('所有带 mimeType 的组合都被拒绝时，退到“不带任何约束”', async () => {
  const { capturer, attempts, startWithStream } = await loadCapturer({
    decide: (options) =>
      options.mimeType ? { ok: false, error: 'unsupported format' } : { ok: true }
  });
  startWithStream();
  assert.equal(capturer.state, 'recording');
  const winner = attempts.find((a) => a.ok);
  assert.ok(winner, '应有一组参数成功');
  /* 注意：winner.options 来自 vm 沙箱里的另一个 realm，
   * 用 assert.deepEqual 和主 realm 的 {} 比较会失败，所以这里查自有键。 */
  assert.equal(Object.keys(winner.options).length, 0, '最终应使用空参数，把选择权交给浏览器');
});

test('全部组合都失败时，报错要带音轨状态和安全上下文', async () => {
  const { capturer, events, startWithStream } = await loadCapturer({
    decide: () => ({ ok: false, error: 'There was an error starting the MediaRecorder' })
  });
  startWithStream();
  const error = events.filter((e) => e.state === 'error').pop();
  assert.ok(error, '应报告错误状态');
  assert.match(error.message, /启动录音失败/);
  assert.match(error.message, /NotSupportedError/, '应保留浏览器的原始错误名');
  assert.match(error.message, /muted=false/, '应带上音轨状态');
  assert.match(error.message, /state=live/, '应带上音轨状态');
  assert.match(error.message, /安全上下文/, '应带上安全上下文');
});

test('确认不可用的组合不会在下一块里重复尝试', async () => {
  const { capturer, attempts, media, startWithStream } = await loadCapturer({
    decide: (options) => (options.audioBitsPerSecond ? { ok: false, error: 'nope' } : { ok: true })
  });
  startWithStream();
  const firstRound = attempts.length;
  assert.ok(firstRound >= 2, `首轮应尝试多个组合，实际 ${firstRound}`);

  // 推进到下一块的时间点，让调度器再开一个会话
  media.currentTime = 10;
  const before = attempts.length;
  await new Promise((r) => setTimeout(r, 60));

  const retriedBlocked = attempts
    .slice(before)
    .some((a) => a.options.audioBitsPerSecond && a.ok === false);
  assert.equal(retriedBlocked, false, '已确认失败的组合不该反复重试');
});

test('视频暂停时不开录音，恢复播放后才开始采集', async () => {
  /* 这一条对应真实故障：视频暂停时启动录音，显式格式会抛
   * NotSupportedError、不带格式则录出 0 字节，后台报“音频数据无效或为空”。
   * 根因不是格式，而是暂停的视频不产生音频数据。 */
  const { capturer, attempts, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });

  media.paused = true;
  startWithStream();
  assert.equal(capturer.state, 'recording', '状态仍是进行中，只是还没数据');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(attempts.length, 0, '暂停时不该尝试录音');

  // 用户点了播放
  media.paused = false;
  capturer.handlePlaybackChange();
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(attempts.length > 0, '恢复播放后应开始采集');
});

test('暂停时正在录的窗口会被丢掉，避免时间戳横跨暂停区间', async () => {
  const { capturer, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  media.paused = false;
  startWithStream();
  await new Promise((r) => setTimeout(r, 50));
  const sessionsBefore = capturer.sessions.length;
  assert.ok(sessionsBefore > 0, '播放时应有正在录的窗口');

  media.paused = true;
  capturer.handlePlaybackChange();
  assert.equal(capturer.sessions.length, 0, '暂停时必须丢掉正在录的窗口');
});

test('诊断结论：暂停状态下的录音失败不能误判成格式不支持', async () => {
  const { NS } = await loadCapturer({ decide: () => ({ ok: true }) });

  const pausedReport = {
    hasMedia: true,
    hasCaptureStream: true,
    hasMediaRecorder: true,
    isSecureContext: true,
    pageUrl: 'https://example.internal/sections/x',
    currentSrc: 'blob:https://example.internal/abc',
    crossOriginAttr: null,
    duration: 816,
    paused: true,
    audioTracks: [{ label: 'audio', muted: false, readyState: 'live' }],
    tainted: false,
    recorderStartOk: false,
    recorderError: 'NotSupportedError: There was an error starting the MediaRecorder',
    optionResults: [
      { label: 'audio/webm;codecs=opus', ok: false, error: 'NotSupportedError: nope' },
      { label: '浏览器默认', ok: true, bytes: 0 }
    ],
    measures: null,
    recordedBytes: 0
  };
  const text = NS.explainDiagnosis(pausedReport);
  assert.match(text, /⚠ 诊断时视频处于暂停状态/, '应醒目提示暂停导致结果不可信');
  assert.match(text, /【结论】诊断时视频是暂停的/, '结论应归因于暂停，而不是格式');
  assert.match(text, /点播放让视频真正出声音/, '应给出可操作的下一步');

  // 播放状态下同样的失败才是真的需要进一步排查
  const playingReport = { ...pausedReport, paused: false };
  const playingText = NS.explainDiagnosis(playingReport);
  assert.match(playingText, /【结论】音轨正常，但 MediaRecorder 在这个页面上无法启动/);
  assert.doesNotMatch(playingText, /诊断时视频是暂停的/);
});

test('单个空块不触发切换采集方式（刚播放时的空块是正常的）', async () => {
  /* 真实场景：用户点了“开启字幕”之后才播放视频，第一块录在暂停期间，
   * 是个空块。那时不能急着切换采集方式，否则会平白引入标签页模式。 */
  const { capturer, events, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();

  const session = {
    parts: [],
    startedAt: 0,
    mediaStart: 0,
    mediaEnd: 12,
    closing: true,
    recorder: { stop() {} }
  };
  capturer.sessions.push(session);
  capturer.finalizeSession(session);

  const noAudioEvents = events.filter((e) => e.state === 'no-audio-data');
  assert.equal(noAudioEvents.length, 0, '单块空不该触发切换');
});

test('连续三块空才触发切换采集方式', async () => {
  const { capturer, events, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();

  for (let i = 0; i < 3; i++) {
    const session = {
      parts: [],
      startedAt: 0,
      mediaStart: i * 12,
      mediaEnd: (i + 1) * 12,
      closing: true,
      recorder: { stop() {} }
    };
    capturer.sessions.push(session);
    capturer.finalizeSession(session);
  }

  const noAudioEvents = events.filter((e) => e.state === 'no-audio-data');
  assert.equal(noAudioEvents.length, 1, '连续三块空应触发一次切换通知');
  assert.match(noAudioEvents[0].message, /抓取标签页声音/);
});

test('空块之后只要有一块成功，计数就归零', async () => {
  const { capturer, events, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();

  const pushEmpty = (i) => {
    const session = {
      parts: [],
      startedAt: 0,
      mediaStart: i * 12,
      mediaEnd: (i + 1) * 12,
      closing: true,
      recorder: { stop() {} }
    };
    capturer.sessions.push(session);
    capturer.finalizeSession(session);
  };
  const pushData = (i) => {
    const session = {
      parts: [new Blob([new Uint8Array(2048)])],
      startedAt: 0,
      mediaStart: i * 12,
      mediaEnd: (i + 1) * 12,
      closing: true,
      recorder: { stop() {} }
    };
    capturer.sessions.push(session);
    capturer.finalizeSession(session);
  };

  pushEmpty(0);
  pushEmpty(1);
  pushData(2); // 中间成功一块
  pushEmpty(3);
  pushEmpty(4);

  const noAudioEvents = events.filter((e) => e.state === 'no-audio-data');
  assert.equal(noAudioEvents.length, 0, '中间有成功块时不该累积成“流有问题”');
});

test('录音参数实测能列出每一组的结果（供诊断使用）', async () => {
  const NS = await loadCapturer({
    decide: (options) => (options.mimeType === 'audio/webm' ? { ok: true } : { ok: false, error: 'rejected' })
  }).then((env) => env.NS);

  // buildRecorderOptions 是内部函数，这里通过诊断报告间接验证它的输出
  const report = await NS.diagnoseMedia({
    currentTime: 0,
    paused: false,
    duration: 100,
    currentSrc: 'https://cdn.example.com/a.mp4',
    crossOrigin: null,
    captureStream: () => ({
      getAudioTracks: () => [{ label: 'audio', muted: false, readyState: 'live', getSettings: () => ({}) }],
      getTracks: () => [{ stop() {} }]
    })
  });

  assert.ok(Array.isArray(report.optionResults), '诊断应逐组记录实测结果');
  assert.ok(report.optionResults.length >= 2, '应实测多个组合');
  const text = NS.explainDiagnosis(report);
  assert.match(text, /录音参数实测：/);
});

/* ===========================================================================
 * 分块计时基准
 *
 * 用户报的是“字幕不连贯、视频里的话没有被完整表达出来”。往下追发现采集侧
 * 有两处在音频里挖洞，而**洞里的声音从来没被录下来过**，识别再准也补不回来：
 *   1. 恢复播放时故意等满一个分块周期才开始录 → 每暂停一次就少一段；
 *   2. 窗口按墙钟计时 → 倍速播放下一个窗口能装进成倍的音频；主线程一卡，
 *      追赶逻辑还会直接跳过中间若干个窗口。
 * 下面三条把这两点锁住。
 * ======================================================================== */

test('恢复播放后立刻开始采集，不再白等一个分块周期', async () => {
  const { capturer, attempts, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });

  media.paused = true;
  startWithStream();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(attempts.length, 0, '暂停时不该尝试录音');

  media.paused = false;
  capturer.handlePlaybackChange();
  /* 原来这里会等满 chunkSeconds（本测试是 4 秒）才开窗口，那 4 秒音频
   * 从来没有被录下来——字幕里就永久缺一段。 */
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(attempts.length > 0, '恢复播放后应当立刻开始采集，而不是等一个完整周期');
});

test('窗口按媒体时间关闭：媒体时间没走够就不产出块', async () => {
  const { capturer, events, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  const chunks = () => events.filter((e) => e.blob);

  startWithStream(); // chunkSeconds = 4
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(capturer.sessions.length, 1, '应有一个窗口在录');

  media.currentTime = 3.5;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(chunks().length, 0, '媒体时间只走了 3.5 秒，还不该产出块');

  media.currentTime = 4.2;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(chunks().length, 1, '媒体时间走满 chunkSeconds 就该产出这一块');
  assert.ok(
    Math.abs(chunks()[0].end - 4.2) < 0.01,
    `块的结束时间应取当前的媒体时间，实际 ${chunks()[0].end}`
  );
});

test('拖动进度条时丢掉正在录的窗口（音频与时间戳会张冠李戴）', async () => {
  const { capturer, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(capturer.sessions.length, 1, '播放中应有一个窗口在录');

  media.currentTime = 300;
  capturer.handleTimelineJump();
  assert.equal(capturer.sessions.length, 0, '跨跳转点的窗口必须丢掉，否则字幕会张冠李戴');
});

/* ===========================================================================
 * 覆盖不变式
 *
 * 用户报“输不全”：回看日志，第 0 块结束于 896.9s，第 2 块却从 908.2s 才开始，
 * 中间 11.3 秒**连一条“第 N 块”日志都没有**——那说明当时没有任何窗口在录，
 * 那段音频从未被录下来，识别再准也补不回来。
 *
 * 根因：窗口到点就被关掉，而新窗口要等下一次巡检才开；巡检一旦被推迟
 * （页面主线程繁忙、定时器被节流），就出现一段“没人录音”的空档。
 * 处理：绝不关掉最后一个窗口——宁可让这个块录长一点（识别慢些），
 * 也不能让音频没有副本。下面四条把这条不变式锁住。
 * ======================================================================== */

test('最后一个窗口到点也不关——宁可录长，不能留空档', async () => {
  const { capturer, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();
  await new Promise((r) => setTimeout(r, 60));
  const session = capturer.sessions[0];
  assert.ok(session, '开始后应有一个窗口在录');

  const closed = capturer.closeSessionIfCovered(session, 100);
  assert.equal(closed, false, '最后一个窗口不该被关掉');
  assert.equal(session.closing, false, '也不该被标记成正在关闭');
  assert.equal(capturer.sessions.length, 1, '窗口必须继续在录');
});

test('有第二个窗口在录时，到点的那个才允许关', async () => {
  const { capturer, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream(); // chunkSeconds = 4，重叠 1 → 每 3 秒媒体时间开下一个窗口
  await new Promise((r) => setTimeout(r, 60));

  media.currentTime = 3;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(capturer.sessions.length >= 2, `应有两个窗口在录，实际 ${capturer.sessions.length}`);

  const first = capturer.sessions[0];
  assert.equal(capturer.closeSessionIfCovered(first, media.currentTime), true, '有备用窗口时应当允许关闭');
});

test('媒体时间被跳过大半时，播放期间也不会出现“没人录音”', async () => {
  const { capturer, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();
  await new Promise((r) => setTimeout(r, 60));

  // 模拟主线程被占住几秒：恢复时媒体时间已经跳过了好几个分块窗口
  media.currentTime = 30;
  let sawEmpty = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 60));
    if (capturer.sessions.length === 0) sawEmpty = true;
  }
  assert.equal(sawEmpty, false, '播放期间任何一刻都必须有窗口在录');
  assert.equal(capturer.coverageHoles.length, 0, '不该出现采集空档');
});

test('真的中断了采集时，空档会被记录并报出时间点', async () => {
  const { capturer, events, media, startWithStream } = await loadCapturer({ decide: () => ({ ok: true }) });
  startWithStream();
  await new Promise((r) => setTimeout(r, 60));

  // 人为制造一次中断：窗口被清空，而媒体时间已经前进了 8 秒
  capturer.sessions = [];
  capturer.lastCoveredMedia = 10;
  media.currentTime = 18;
  capturer.onMediaProgress();

  assert.equal(capturer.coverageHoles.length, 1, '应记录 1 处空档');
  assert.equal(capturer.coverageHoles[0].start, 10);
  assert.equal(capturer.coverageHoles[0].end, 18);
  const holeStatus = events.filter((e) => e.state === 'coverage-hole');
  assert.equal(holeStatus.length, 1, '应向界面报告空档，否则用户只会以为“识别不准”');
});

