/**
 * 字幕连贯性的测试。
 *
 * 来自用户的实际反馈：字幕能出，但“闪一句、空一段、再闪一句”，
 * 中间大片空白。根因是渲染循环一遇到“当前时刻没有对应字幕”就清空——
 * 而块与块之间必然有间隔（等下一块攒够 + 识别耗时）。
 *
 * 真人录制的字幕不会这样：一句话说完后字幕**一直留到下一句出现**。
 * 这里锁住这个行为，以及必要的例外（拖动进度、暂停时应当清空）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/** 加载主控脚本（skipping overlay.js，用替身记录显示的文本）。 */
async function loadController({
  chunkSeconds = 6,
  extraSettings = {},
  sentMessages = null,
  streamResponder = null
} = {}) {
  const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  const files = manifest.content_scripts[0].js;

  const shown = [];
  const timers = new Set();
  const video = {
    readyState: 4,
    src: 'https://cdn.example.com/a.mp4',
    currentSrc: 'https://cdn.example.com/a.mp4',
    duration: 600,
    currentTime: 0,
    paused: false,
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 500, right: 900, bottom: 500 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null
  };

  const sandbox = {
    console,
    /* 定时器包装一层并登记：主控的自动挂载巡检是自续期的 setTimeout，
     * 不清理会让 Node 进程不退出（表现为“测试卡死”）。 */
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
      clearInterval(id);
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance,
    URL,
    Blob,
    FormData,
    MediaRecorder: class {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      readyState: 'complete',
      title: '课程',
      body: { appendChild: () => {} },
      documentElement: { appendChild: () => {} },
      fullscreenElement: null,
      querySelectorAll: (s) => (s === 'video' ? [video] : []),
      querySelector: () => null,
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
        remove() {}
      }),
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    window: { isSecureContext: true, addEventListener: () => {}, removeEventListener: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { host: 'example.com', pathname: '/s', href: 'https://example.com/s' },
    chrome: {
      runtime: {
        id: 'test-extension-id',
        onMessage: { addListener: () => {} },
        sendMessage: async (message) => {
          if (sentMessages) sentMessages.push(message);
          if (message && message.type === 'zimu:get-public-settings') {
            return {
              ok: true,
              settings: {
                baseUrl: 'https://api.example.com/v1',
                chunkSeconds,
                fontSize: 22,
                bottomPercent: 6,
                /* 这一组用例关心的是“该显示哪一条”，不是逐字动画。
                 * 逐字会让每一帧只放出前几个字，断言会全部失配；
                 * 需要验证逐字时用 extraSettings 单独打开。 */
                typewriter: false,
                ...extraSettings
              }
            };
          }
          if (message && message.type === 'zimu:transcribe-stream' && streamResponder) {
            return streamResponder(message);
          }
          return { ok: true };
        },
        getURL: (p) => 'chrome-extension://test/' + p
      },
      storage: {
        session: { get: async () => ({}), remove: async () => {} },
        local: { get: async () => ({}), set: async () => {} }
      }
    }
  };
  sandbox.globalThis = sandbox;

  // 用替身替换真实叠加层：这样自动挂载建出来的也是替身，
  // 我们能直接读它显示的文本，而且不会有定时器残留
  sandbox.__ZIMU__ = {
    bytesToBase64: () => '',
    base64ToBytes: () => new Uint8Array(0),
    Overlay: class {
      constructor() {
        this.host = { isConnected: false };
        this.state = null;
        this.statusText = '';
        this.captionText = '';
      }
      attachTo() {
        this.host.isConnected = true;
      }
      setState(s) {
        this.state = s;
      }
      setStatus(t) {
        this.statusText = t;
      }
      openCard() {}
      toast() {}
      showCaption(text) {
        this.captionText = text;
        shown.push(text);
      }
      showDiagnosis() {}
      inspect() {
        return '';
      }
      destroy() {
        this.host.isConnected = false;
      }
    }
  };

  const context = vm.createContext(sandbox);
  for (const file of files) {
    if (file.endsWith('overlay.js')) continue;
    const code = await readFile(path.join(distDir, file), 'utf8');
    new vm.Script(code, { filename: file }).runInContext(context);
  }

  const controller = sandbox.__ZIMU__.controller;
  controller.video = video;
  await controller.ensureSettings(true);
  /* start() 里才会从设置同步逐字开关；这里不跑启动流程，
   * 所以按设置手动同步一次，让 extraSettings.typewriter 真的生效。 */
  controller.typewriterEnabled = extraSettings.typewriter === true;
  // 挂上替身叠加层（自动挂载可能已经建过一个，这里统一确保可用）
  controller.overlay = new sandbox.__ZIMU__.Overlay();
  controller.overlay.attachTo(video);
  // 落后上限平时在 start() 里算；测试不跑启动流程，这里按同样规则补上
  controller.maxLagSeconds = controller.computeMaxLagSeconds();

  return {
    controller,
    video,
    shown,
    sandbox,
    stopTimers: () => {
      try {
        sandbox.__ZIMU__.stopAttachRetry?.();
      } catch (err) {
        /* 忽略 */
      }
      for (const id of timers) {
        clearTimeout(id);
        clearInterval(id);
      }
      timers.clear();
    }
  };
}

/** 造一条已结束的字幕，模拟“这句话说完了，等下一块返回”的状态。 */
function seedFinishedSegment(controller, { start, end, text }) {
  controller.track = { segments: [{ start, end, text }] };
  controller.track.segmentAt = (t) => (t >= start && t < end ? controller.track.segments[0] : null);
  controller.track.lastSegmentBefore = (t) => (controller.track.segments[0].end <= t ? controller.track.segments[0] : null);
  controller.track.addChunk = () => ({ added: [] });
  controller.track.reset = () => {};
}

test('一句话说完后字幕会保留，不会立刻消失（连贯性的核心）', async (t) => {
  const { controller, video, stopTimers } = await loadController();
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 108, text: '这一句已经说完了' });

  // 视频已经走到这句之后 3 秒，但下一块还没返回
  video.currentTime = 111;
  video.paused = false;
  controller.renderFrame();

  assert.equal(
    controller.overlay.captionText,
    '这一句已经说完了',
    '下一块还没回来时必须继续显示上一条，否则中间就是一片空白'
  );
});

test('等下一块返回的整个等待期内字幕都保持显示', async (t) => {
  const { controller, video, stopTimers } = await loadController({ chunkSeconds: 6 });
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 106, text: '等待下一块' });

  video.paused = false;
  /* 从刚结束一直查到很后面。这里刻意跨过“旧的持有上限”（分块 12 秒时高达 36 秒）：
   * 只要识别还没返回，字幕就该一直在，不能因为“太旧”被清掉。 */
  for (const t of [106.5, 108, 110, 113, 116, 119, 130, 145]) {
    video.currentTime = t;
    controller.renderFrame();
    assert.equal(controller.overlay.captionText, '等待下一块', `在 ${t}s 时字幕不该消失`);
  }
});

/* 反过来：不能因为“时间隔得久”就清空。
 * 这条锁的是用户实测里最刺眼的一幕——识别服务偶尔要二三十秒才返回，
 * 屏幕上那行字忽然消失，用户只会以为插件坏了。所以只有“换了播放位置”
 * 才该清空；识别慢不构成清空的理由。 */
test('识别落后时仍保留最近一条，不因时间久远而清空', async (t) => {
  const { controller, video, stopTimers } = await loadController({ chunkSeconds: 6 });
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 106, text: '最近说过的话' });
  video.paused = false;

  // 没有拖动、没有暂停，只是识别迟迟不返回
  video.currentTime = 106 + 40;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '最近说过的话', '识别落后时屏幕不该变成空白');
});

test('拖动进度到别处后，不再显示跳转点之前的字幕', async (t) => {
  const { controller, video, stopTimers } = await loadController({ chunkSeconds: 6 });
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 106, text: '跳转前说的话' });
  // 同一个视频内拖动（换视频会走另一条分支：字幕轨整个清空）
  controller.videoKey = controller.computeVideoKey(video);
  video.paused = false;

  // 拖到 300s：那条 100→106 的字幕属于“别的位置说的话”，必须让位
  video.currentTime = 300;
  controller.onTimelineJump();
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '', '跳转点之前的字幕不该继续显示');
});

/* 补显必须快于实时。否则“识别慢过一次”这件事会被永久记住：
 * 按原速重播等于用同样的速度追同样的距离，永远追不平。 */
test('补显速度快于实时，落后才可能被追平', async (t) => {
  const { controller, stopTimers } = await loadController({ chunkSeconds: 6 });
  t.after(stopTimers);
  const segment = { start: 100, end: 110 }; // 自然时长 10 秒
  const dwell = controller.catchUpDwellFor(segment);
  assert.ok(
    dwell < (segment.end - segment.start) * 1000,
    `补显停留必须短于自然时长，实际 ${dwell}ms`
  );
  assert.ok(dwell <= controller.catchUpMaxDwellMs, `还要被上限夹住，实际 ${dwell}ms`);
  assert.ok(dwell >= controller.catchUpMinDwellMs, `但不能短到读不完，实际 ${dwell}ms`);
});

/* 当前时刻已经有字幕时，历史补显必须立刻让位。
 * 这是用户那句“Console 里明明有文字返回，屏幕上却不动”的直接对应项。 */
test('当前时刻已有字幕时，历史补显队列会被清掉并让位', async (t) => {
  const { controller, video, shown, sandbox, stopTimers } = await loadController();
  t.after(stopTimers);
  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.maxLagSeconds = 6;
  controller.catchUpMinDwellMs = 0;
  controller.catchUpMaxDwellMs = 0;

  // 先制造一段“迟到的历史内容”进队列
  video.paused = false;
  video.currentTime = 115;
  const old = controller.track.addChunk({ start: 100, end: 112, text: '旧的内容。' });
  controller.enqueueLaggingSegments(old.added);
  assert.ok(controller.catchUpQueue.length > 0, '前置条件：队列里应有历史内容');

  // 再来一块覆盖当前时刻：segmentAt 必须命中，队列让位
  video.currentTime = 130;
  controller.track.addChunk({ start: 126, end: 138, text: '正在说的话。' });
  controller.renderFrame();

  assert.equal(controller.catchUpQueue.length, 0, '当前时刻已有字幕，历史补显必须让位');
  assert.equal(
    controller.overlay.captionText,
    sandbox.__ZIMU__.normalizeText('正在说的话。'),
    '屏幕上应当显示当前时刻的内容'
  );
  assert.ok(shown.includes(sandbox.__ZIMU__.normalizeText('正在说的话。')));
});

test('下一条字幕出现时自然切换过去', async (t) => {
  const { controller, video, stopTimers } = await loadController();
  t.after(stopTimers);
  const first = { start: 100, end: 106, text: '第一句' };
  const second = { start: 108, end: 114, text: '第二句' };
  controller.track = {
    segments: [first, second],
    segmentAt: (t) => (t >= 108 && t < 114 ? second : t >= 100 && t < 106 ? first : null),
    lastSegmentBefore: (t) => (t >= 114 ? second : t >= 106 ? first : null),
    addChunk: () => ({ added: [] }),
    reset: () => {}
  };

  video.paused = false;
  video.currentTime = 109;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '第二句');
});

test('拖动进度条时清空字幕（旧内容已经对不上画面）', async (t) => {
  const { controller, video, stopTimers } = await loadController();
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 200, end: 206, text: '拖动前的内容' });

  video.paused = false;
  video.currentTime = 203;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '拖动前的内容');

  // 用户往回拖了 50 秒
  video.currentTime = 150;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '', '往回拖动后必须清空，否则会显示完全无关的内容');
});

test('视频暂停时清空字幕', async (t) => {
  const { controller, video, stopTimers } = await loadController();
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 106, text: '暂停前的话' });

  video.paused = false;
  video.currentTime = 108;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '暂停前的话');

  video.paused = true;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '', '暂停后画面静止，字幕不该继续挂着');
});

test('落后上限随分块时长收紧（分块越短，字幕越新鲜）', async (t) => {
  const short = await loadController({ chunkSeconds: 4 });
  const long = await loadController({ chunkSeconds: 12 });
  t.after(() => {
    short.stopTimers();
    long.stopTimers();
  });
  assert.ok(
    short.controller.maxLagSeconds < long.controller.maxLagSeconds,
    `分块 4 秒的落后上限应小于分块 12 秒的（${short.controller.maxLagSeconds} vs ${long.controller.maxLagSeconds}）`
  );
  assert.ok(short.controller.maxLagSeconds >= 6, '但也不该小到稍有波动就放弃补显');
});

/* ===========================================================================
 * 识别落后时的“追赶”
 *
 * 用户原话：“出现字幕后该条字幕会持续存在一段时间……导致中间的那段字幕
 * 直接不显示，视频中的语言没有被字幕完整的表达出来。”
 *
 * 根因：识别一旦落后，一整块的字幕都落在当前播放位置**之前**，
 * `segmentAt()` 一条也命中不了，渲染层只能退到 `lastSegmentBefore()`
 * ——也就是该块的**最后一句**。块里其余的句子永远上不了屏。
 * 下面几条锁住“迟到的一整块会逐条补显”。
 * ======================================================================== */

test('识别落后时，一整块里的每条字幕都会补显，而不是只剩最后一条', async (t) => {
  const { controller, video, shown, sandbox, stopTimers } = await loadController();
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.maxLagSeconds = 6;
  // 停留时长归零：这条测试只关心“有没有轮到每一条”
  controller.catchUpMinDwellMs = 0;
  controller.catchUpMaxDwellMs = 0;

  // 这一块（100→112）此刻才回来，视频已到 115——落后 3 秒，仍在补偿上限内
  video.paused = false;
  video.currentTime = 115;
  const result = controller.track.addChunk({
    start: 100,
    end: 112,
    text: '第一句已经说完了。第二句也已经说完了。第三句同样说完了。'
  });
  assert.ok(result.added.length >= 2, `这一段应被拆成多条，实际 ${result.added.length}`);

  controller.enqueueLaggingSegments(result.added);
  assert.equal(controller.catchUpQueue.length, result.added.length, '迟到的整块都应进入补显队列');

  // 逐帧推进，把队列排空
  for (let i = 0; i < 12; i++) controller.renderFrame();

  for (const segment of result.added) {
    assert.ok(shown.includes(segment.text), `这条字幕必须出现过：${segment.text}`);
  }
});

/* 反向约束：落后**超过**上限时必须放弃逐条补显。
 *
 * 这条同样来自用户实测：分块 12 秒、服务偶尔要 20~30 秒才返回时，
 * 补显队列会让屏幕连着几十秒都在放“很久以前说的话”，与画面完全脱节，
 * 用户的原话是“新的一句和前面不连贯，好像视频里已经说过很多话了”。
 * 所以超过上限就对齐最新——但内容不能丢，它们仍要留在字幕轨里供导出。 */
test('落后超过上限时跳过逐条补显，直接对齐最新内容（内容仍保留在字幕轨里）', async (t) => {
  const { controller, video, shown, sandbox, stopTimers } = await loadController();
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.maxLagSeconds = 6;
  controller.catchUpMinDwellMs = 0;
  controller.catchUpMaxDwellMs = 0;

  video.paused = false;
  video.currentTime = 130; // 落后 18 秒，远超上限
  const result = controller.track.addChunk({
    start: 100,
    end: 112,
    text: '甲句已经说完了。乙句已经说完了。丙句已经说完了。'
  });
  assert.ok(result.added.length >= 2, `这一段应被拆成多条，实际 ${result.added.length}`);

  controller.enqueueLaggingSegments(result.added);
  assert.ok(controller.catchUpQueue.length >= 2, '先确认它们确实进了补显队列');

  controller.renderFrame();

  assert.equal(controller.catchUpQueue.length, 0, '落后超上限时应丢掉补显队列，不再回放历史');
  assert.ok(controller.lastShownText, '对齐最新后屏幕上仍必须有字幕，不能变成空白');
  assert.ok(shown.includes(controller.lastShownText), '屏幕上显示的应当是最近一条已识别内容');

  // 关键：屏幕跳过 ≠ 内容丢失。它们仍在字幕轨里，导出 SRT 一条不少。
  for (const segment of result.added) {
    assert.ok(
      controller.track.segments.includes(segment),
      `跳过的内容仍应保留在字幕轨里供导出：${segment.text}`
    );
  }
});

test('拖动进度条后不再补显跳转前的内容', async (t) => {
  const { controller, video, shown, sandbox, stopTimers } = await loadController();
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.catchUpMinDwellMs = 0;
  controller.catchUpMaxDwellMs = 0;
  controller.videoKey = controller.computeVideoKey(video);
  controller.lastShownTime = 130;

  video.paused = false;
  video.currentTime = 130;
  const result = controller.track.addChunk({ start: 100, end: 112, text: '跳转前说的话。' });
  controller.enqueueLaggingSegments(result.added);
  assert.ok(controller.catchUpQueue.length > 0, '这一块已经落后，应进入队列');

  // 用户把进度条拖到了 400 秒
  video.currentTime = 400;
  controller.onTimelineJump();
  assert.equal(controller.catchUpQueue.length, 0, '跳转后必须丢掉属于旧位置的补显队列');

  controller.renderFrame();
  assert.ok(
    !shown.includes(sandbox.__ZIMU__.normalizeText('跳转前说的话。')),
    '跳转后不该再补显旧位置的内容'
  );
});

test('落后太多时只保留最近的若干条，队列不会无限增长', async (t) => {
  const { controller, video, sandbox, stopTimers } = await loadController();
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.catchUpQueueLimit = 3;

  video.paused = false;
  video.currentTime = 1000;
  for (let i = 0; i < 6; i++) {
    const result = controller.track.addChunk({
      start: i * 10,
      end: i * 10 + 8,
      text: `第${i}段内容。`
    });
    controller.enqueueLaggingSegments(result.added);
  }
  assert.equal(controller.catchUpQueue.length, 3, '队列应被裁到上限（多余的在 SRT 里仍然完整）');
});

test('没有落后时不会启用补显，字幕照常按时间轴显示', async (t) => {
  const { controller, video, shown, sandbox, stopTimers } = await loadController();
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  video.paused = false;
  // 块还没播完（end 在当前位置之后）→ 不该进补显队列
  video.currentTime = 50;
  const result = controller.track.addChunk({ start: 48, end: 58, text: '正在说的话。' });
  controller.enqueueLaggingSegments(result.added);
  assert.equal(controller.catchUpQueue.length, 0, '没落后的块不该进补显队列');

  video.currentTime = 52;
  controller.renderFrame();
  // normalizeText 会把全角句号统一成半角，断言要按规整后的文本比
  assert.equal(controller.overlay.captionText, sandbox.__ZIMU__.normalizeText('正在说的话。'));
  assert.ok(shown.includes(sandbox.__ZIMU__.normalizeText('正在说的话。')));
});

test('只积压一条时段落立刻显示，不节流（否则倍速下会越积越多）', async (t) => {
  const { controller, video, shown, sandbox, stopTimers } = await loadController();
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  /* 故意把节流设成 60 秒：只要队列里只有一条，就不该被它挡住。
   * 倍速播放时每 2.5 秒就来一块，按固定节奏节流会让积压越滚越大。 */
  controller.catchUpMinDwellMs = 60000;
  controller.catchUpMaxDwellMs = 60000;

  video.paused = false;
  video.currentTime = 200;
  const result = controller.track.addChunk({ start: 190, end: 198, text: '刚说完的一句。' });
  controller.enqueueLaggingSegments(result.added);
  assert.equal(controller.catchUpQueue.length, 1);

  controller.renderFrame();
  assert.ok(
    shown.includes(sandbox.__ZIMU__.normalizeText('刚说完的一句。')),
    '队列只有一条时必须立刻显示，不能被节流挡住'
  );
});

/* ---------------------------------------------------------------------------
 * 流式识别：小切片连续投喂，服务端定稿后带真实时间戳回来
 * ------------------------------------------------------------------------- */

test('流式切片走流式接口，并把服务端给的时间戳直接落盘', async (t) => {
  const sent = [];
  const { controller, sandbox, stopTimers } = await loadController({
    extraSettings: { streaming: true, streamSliceSeconds: 1.6, streamOverlapSeconds: 0.4 },
    sentMessages: sent,
    streamResponder: () => ({
      ok: true,
      segments: [{ start: 10.2, end: 11.4, text: '流式定稿的一句话。' }],
      pending: '还没定稿的尾巴'
    })
  });
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.streamSession = 'sess-1';
  controller.streamActive = true;

  const chunk = {
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }),
    start: 10,
    end: 11.6,
    index: 0,
    durationSec: 1.6
  };
  await controller.sendSliceForStream(chunk, null);

  const request = sent.find((m) => m.type === 'zimu:transcribe-stream');
  assert.ok(request, '流式模式下必须发流式请求');
  assert.equal(request.session, 'sess-1', '请求要带上会话标识');
  assert.equal(request.start, 10, '要带上这一片的媒体起点');
  assert.equal(request.end, 11.6, '要带上这一片的媒体终点');
  assert.notEqual(request.flush, true, '普通切片不是收尾请求');

  assert.equal(controller.track.segments.length, 1, '服务端定稿的段要落进字幕轨');
  assert.equal(controller.track.segments[0].start, 10.2, '时间戳必须用服务端给的，不能再估');
  assert.equal(controller.track.segments[0].end, 11.4);
});

test('服务端说不支持流式时自动降级，不再继续发流式请求', async (t) => {
  const { controller, sandbox, stopTimers } = await loadController({
    extraSettings: { streaming: true },
    streamResponder: () => ({ ok: false, fallback: true, error: '只对本机识别服务生效' })
  });
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.streamSession = 'sess-2';
  controller.streamActive = true;

  const chunk = {
    blob: new Blob([new Uint8Array([9])], { type: 'audio/wav' }),
    start: 1,
    end: 2.6,
    index: 0,
    durationSec: 1.6
  };
  await controller.sendSliceForStream(chunk, null);

  assert.equal(controller.streamActive, false, '收到 fallback 后必须关掉流式，退回分块模式');
});

/* ---------------------------------------------------------------------------
 * 逐字显示（打字机效果）
 *
 * 两轮用户反馈，两条相反的要求：
 *  ①「一个字一个字出来，不要一下出完」
 *  ②「要跟随音频中的时间逐个输出，不是整句说完之后才把上一句输出出来」
 *
 * 结论是**节奏的来源必须是这句话自己的音频时长**（end - start）：
 * 6 秒说完的句子就花 6 秒打完，字的出场节奏与话音一一对应。
 * 用一个固定的 0.75~1.8 秒去补放整句，观感就是"事后的回放"——那正是②在骂的。
 * ------------------------------------------------------------------------- */

test('逐字节奏跟着这句话自己的音频时长走（6 秒的句子就打 6 秒）', async (t) => {
  const { controller, stopTimers } = await loadController({ extraSettings: { typewriter: true } });
  t.after(stopTimers);
  assert.equal(controller.typewriterEnabled, true, '前置条件：逐字必须打开');

  const text = '这是一句完整的话';
  // 这句话在音频里说了 6 秒
  const seg = { start: 100, end: 106, text };

  const at0 = controller.typewriterSlice(seg, 100);
  assert.equal(at0.partial, true, '刚开始应当是半截文字');
  assert.ok(at0.text.length < text.length, `第一帧不该显示整句，实际「${at0.text}」`);
  assert.ok(text.startsWith(at0.text), '放出来的必须是这句话的前缀');

  // 说了 3 秒 → 大约放出一半的字
  const at3 = controller.typewriterSlice(seg, 103);
  assert.ok(at3.text.length > at0.text.length, '过了 3 秒应当多放出一些字');
  assert.ok(
    Math.abs(at3.text.length - text.length / 2) <= 2,
    `3 秒时应当放出约一半（实际 ${at3.text.length}/${text.length}）`
  );

  // 一句话说完 → 正好放完整句
  const at6 = controller.typewriterSlice(seg, 106);
  assert.equal(at6.text, text);
  assert.equal(at6.partial, false);
});

test('逐字只增不减：同一句话里进度不会回退', async (t) => {
  const { controller, stopTimers } = await loadController({ extraSettings: { typewriter: true } });
  t.after(stopTimers);
  const seg = { start: 100, end: 106, text: '进度只增不减的一句话' };

  let prev = 0;
  for (const time of [100, 101, 102, 103, 104, 105, 106]) {
    const out = controller.typewriterSlice(seg, time);
    assert.ok(out.text.length >= prev, `在 ${time}s 时字数不该倒退`);
    prev = out.text.length;
  }
  assert.equal(prev, seg.text.length);
});

test('迟到时仍然逐字放，不会整句一次蹦出', async (t) => {
  /* 识别慢一两句是常态。这时段的 [start,end] 早就过去了，锚点只能取
   * "文本到手的那一刻"，再按同样的语速自播一遍——**整体后移，但语速对得上话音**。
   * 注意这与旧版相反：旧版刻意不按音频时长，结果是把整句在一秒多里吐出来。 */
  const { controller, video, stopTimers } = await loadController({
    extraSettings: { typewriter: true }
  });
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 106, text: '这句话在视频里早就说完了' });

  video.paused = false;
  video.currentTime = 111; // 迟到 5 秒
  controller.renderFrame();

  assert.notEqual(
    controller.overlay.captionText,
    '这句话在视频里早就说完了',
    '迟到不该导致整句一次蹦出'
  );
  assert.ok(
    '这句话在视频里早就说完了'.startsWith(controller.overlay.captionText),
    `屏幕上应当是这句话的前缀，实际「${controller.overlay.captionText}」`
  );
  assert.equal(controller.lastShownPartial, true, '半截文字要标成 partial');

  // 再往后 6 秒（= 这句话的时长）应当已经放完
  video.currentTime = 117;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '这句话在视频里早就说完了');
});

test('整句直接显示过之后，逐字逻辑不会再把它缩回去', async (t) => {
  /* 追赶补显是整句直接上屏的。如果逐字逻辑把它当成一条新句重来，
   * 屏幕上已经完整的一句话会缩回头几个字，肉眼看着像在抽搐。 */
  const { controller, stopTimers } = await loadController({ extraSettings: { typewriter: true } });
  t.after(stopTimers);

  controller.show('完整的一句话', { partial: false });
  const again = controller.typewriterSlice({ start: 100, end: 106, text: '完整的一句话' }, 5000);
  assert.equal(again.text, '完整的一句话');
  assert.equal(again.partial, false);
});

test('关掉逐字开关后整句直接显示（保持老行为）', async (t) => {
  const { controller, stopTimers } = await loadController();
  t.after(stopTimers);
  controller.typewriterEnabled = false;

  const out = controller.typewriterSlice({ start: 100, end: 106, text: '这是一句完整的话' }, 5000);
  assert.equal(out.text, '这是一句完整的话');
  assert.equal(out.partial, false);
});

/* ---------------------------------------------------------------------------
 * 「组成一句话后再消失，继续下一句」
 * ------------------------------------------------------------------------- */

test('一句话打完并停留够久后消失，不会一直挂在屏幕上', async (t) => {
  const { controller, video, stopTimers } = await loadController({
    extraSettings: { typewriter: true }
  });
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 102, text: '这句话已经打完了' });
  controller.captionLingerMs = 0; // 省掉等待，直接看"打完就该走"

  video.paused = false;
  video.currentTime = 102; // 迟到 0 秒（正好说完）
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '这句话已经打完了', '先说完整句应当上屏');

  // 再走一帧：这一句已经打完且停留够了 → 应当清空
  video.currentTime = 102.2;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '', '打完并且停留够久之后必须消失');

  // 关键：不能下一帧又把它捞回来重打一遍（那会变成无限循环地闪）
  video.currentTime = 102.4;
  controller.renderFrame();
  assert.equal(controller.overlay.captionText, '', '退休的句子不能被重新捡回来');
});

test('还在逐字打的过程中不会被清掉', async (t) => {
  const { controller, video, stopTimers } = await loadController({
    extraSettings: { typewriter: true }
  });
  t.after(stopTimers);
  seedFinishedSegment(controller, { start: 100, end: 108, text: '这句话还长着呢' });
  controller.captionLingerMs = 0;

  video.paused = false;
  video.currentTime = 109; // 迟到 1 秒，刚开始打字
  controller.renderFrame();
  const first = controller.overlay.captionText;
  assert.ok(first.length > 0 && first.length < '这句话还长着呢'.length, `应当在打字中，实际「${first}」`);

  video.currentTime = 110; // 又过了 1 秒，还没打完
  controller.renderFrame();
  assert.ok(
    controller.overlay.captionText.length > 0,
    '还没打完就不该被清空'
  );
});

test('正在打字的句子不会被下一条截断（要组成完整一句才换）', async (t) => {
  /* 「组成一句话后再消失」意味着：下一句已经回来了，也不能把这句还剩一半的
   * 字直接扔掉。这条锁住"正在打的这一句优先于追最新的那一句"。 */
  const { controller, video, stopTimers } = await loadController({
    extraSettings: { typewriter: true }
  });
  t.after(stopTimers);

  const first = { start: 100, end: 106, text: '第一句要说的话' };
  const second = { start: 106, end: 112, text: '第二句要说的话' };
  const third = { start: 108, end: 114, text: '第三句要说的话' };
  const segments = [first, second];
  controller.track = {
    segments,
    segmentAt: (t) => segments.find((s) => t >= s.start && t < s.end) || null,
    lastSegmentBefore: (t) => {
      const past = segments.filter((s) => s.end <= t);
      return past.length ? past[past.length - 1] : null;
    },
    addChunk: () => ({ added: [] }),
    reset: () => {}
  };
  controller.captionLingerMs = 10_000; // 别让"打完就消失"干扰这条断言

  video.paused = false;
  video.currentTime = 113; // 第二句已经说完 1 秒 → 开始逐字打它
  controller.renderFrame();
  const typing = controller.overlay.captionText;
  assert.ok(
    typing.length > 0 && typing.length < second.text.length,
    `应当在打第二句，实际「${typing}」`
  );

  // 第三句这时才回来（它的结束时间也已经过去 → 会取代"最新一条"的位置）
  segments.push(third);
  video.currentTime = 115;
  controller.renderFrame();

  assert.ok(
    second.text.startsWith(controller.overlay.captionText),
    `不该切到第三句、把第二句的后半截扔掉，实际「${controller.overlay.captionText}」`
  );
  assert.ok(
    controller.overlay.captionText.length >= typing.length,
    '已打出的字数只能往前不能倒退'
  );
});

test('拖动进度条后逐字状态归零，同一句话会重新打一遍', async (t) => {
  const { controller, video, stopTimers } = await loadController({
    extraSettings: { typewriter: true }
  });
  t.after(stopTimers);
  controller.track = new sandboxTrack(controller);
  controller.videoKey = controller.computeVideoKey(video);

  video.paused = false;
  video.currentTime = 120;
  const result = controller.track.addChunk({ start: 100, end: 106, text: '回来重看的这一句。' });
  assert.ok(result.added.length >= 1);

  // 播到这一句：正常逐字
  controller.renderFrame();

  // 拖回开头，再播到同一句 —— 必须能重新打，而不是被"已退休"挡住
  video.currentTime = 90;
  controller.onTimelineJump();
  assert.equal(controller.retiredText, null, '拖动后必须清掉退休记忆');
  assert.equal(controller.reveal, null, '拖动后逐字进度必须归零');

  video.currentTime = 101;
  controller.renderFrame();
  assert.ok(controller.overlay.captionText.length > 0, '重看到这句时应当重新逐字显示');
});

/* ---------------------------------------------------------------------------
 * 补显通道与逐字的关系
 *
 * 这一组来自 tools/sim-timeline.mjs 的真实推演：单测里是直接调 renderFrame
 * 喂数据、走**正常**路径；而真实运行里，识别慢一两句是常态，于是
 * `enqueueLaggingSegments` 的判据（end <= 当前时间）对本几乎每一句都成立——
 * **几乎每一句都从补显通道过**。补显原本是整句直接上屏的，
 * 所以"逐字显示"写好了却毫无效果。两条路必须都逐字。
 * ------------------------------------------------------------------------- */

test('补显通道也逐字，不会整句直接上屏（逐字"没效果"的真因）', async (t) => {
  const { controller, video, sandbox, stopTimers } = await loadController({
    extraSettings: { typewriter: true }
  });
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.maxLagSeconds = 60; // 排除"落后上限跳历史"的干扰

  video.paused = false;
  video.currentTime = 115;
  const result = controller.track.addChunk({
    start: 100,
    end: 112,
    text: '甲句已经说完了。乙句已经说完了。丙句已经说完了。'
  });
  assert.ok(result.added.length >= 2, `这一段应被拆成多条，实际 ${result.added.length}`);
  controller.enqueueLaggingSegments(result.added);
  assert.ok(controller.catchUpQueue.length >= 2, '前置条件：确实积压了');

  controller.renderFrame();

  const firstSeg = result.added[0].text;
  const shown = controller.overlay.captionText;
  assert.ok(
    shown.length < firstSeg.length,
    `补显也必须逐字，实际整句直接上屏了：「${shown}」`
  );
  assert.ok(firstSeg.startsWith(shown), '放出来的应当是这句话的前缀');
  assert.equal(controller.lastShownPartial, true, '补显中的半截文字也要标 partial');
});

test('只有一条迟到时不会触发"跳历史"，把正在打的那句截断', async (t) => {
  /* 「落后上限」是按时间算的，而识别慢几秒是常态——屏幕本来就该比话音晚。
   * 若只按时间判，这个上限会被常态延迟一直触发，表现就是
   * "一句话打到一半忽然跳到下一句"。所以还要求队列里确实堆了 ≥2 条。 */
  const { controller, video, sandbox, stopTimers } = await loadController({
    extraSettings: { typewriter: true }
  });
  t.after(stopTimers);

  controller.track = new sandbox.__ZIMU__.SubtitleTrack();
  controller.maxLagSeconds = 6; // 故意设得很小，模拟"常态延迟就超上限"

  video.paused = false;
  video.currentTime = 120;
  const result = controller.track.addChunk({ start: 100, end: 112, text: '这一句很长很长很长很长的话。' });
  controller.enqueueLaggingSegments(result.added);
  assert.equal(controller.catchUpQueue.length, 1, '前置条件：只有一条迟到');

  controller.renderFrame();
  const first = controller.overlay.captionText;
  assert.ok(first.length > 0 && first.length < result.added[0].text.length, `应当在逐字打，实际「${first}」`);

  video.currentTime = 124;
  controller.renderFrame();
  const later = controller.overlay.captionText;
  assert.ok(
    result.added[0].text.startsWith(later),
    `不该被"跳历史"截断并切到别的内容，实际「${later}」`
  );
  assert.ok(later.length > first.length, '同一句话的字数应当继续增长');
});

/** 造一个只够本用例使用的字幕轨（避免依赖 vm 里的类） */
function sandboxTrack(controller) {
  const segments = [];
  return {
    segments,
    addChunk({ start, end, text }) {
      const seg = { start, end, text };
      segments.push(seg);
      return { added: [seg] };
    },
    segmentAt: (t) => segments.find((s) => t >= s.start && t < s.end) || null,
    lastSegmentBefore: (t) => {
      const past = segments.filter((s) => s.end <= t);
      return past.length ? past[past.length - 1] : null;
    },
    reset: () => {
      segments.length = 0;
    }
  };
}

