/**
 * 逐字 / 消隐节奏的时间轴仿真（临时排错工具）。
 *
 * 单测只能证明"某一帧算得对"，证明不了"整条时间轴上看着顺不顺"。
 * 这个脚本把 renderFrame 按 0.25 秒一帧真实推演一遍，把屏幕上出现过的
 * 内容按时间打印出来——一眼就能看出：字是不是按语速长出来的、
 * 句子之间有没有长时间空白、有没有哪句被打断。
 *
 * 用法：node tools/sim-timeline.mjs [识别延迟秒数] [播放倍速] [逐字 1/0]
 */

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

const LAG = Number(process.argv[2] ?? 5); // 识别比语音慢几秒
const RATE = Number(process.argv[3] ?? 1); // 播放倍速
const TYPEWRITER = process.argv[4] !== '0'; // 逐字开关
const CHUNK = 6; // 分块秒数（一次识别覆盖多长的音频）

/** 模拟一段课程语音：每句话 [start, end] 与内容 */
const SCRIPT = [
  [100.0, 104.0, '好，我们来看这个图啊，我们看这个什么是欠拟合。'],
  [104.0, 106.0, '就是说，模型太简单了。'],
  [106.0, 110.0, '模型的复杂度不够的时候，训练误差下不去。'],
  [110.0, 116.5, '然后呢，随着模型复杂度提高，训练误差会一直减小。'],
  [116.5, 120.0, '但是测试误差是先降后升的，这个点就是最优点。'],
  [120.0, 124.0, '所以我们做正则化，其实就是在控制复杂度。'],
  [124.0, 126.5, '好，那接下来。'],
  [126.5, 131.0, '我们看具体的正则化方法有哪些。']
];

async function main() {
  const timers = new Set();
  const shown = [];
  /* 虚拟时钟。
   *
   * 这件事很关键：主控里"补显节奏"用的是挂钟 Date.now()，而"逐字进度"用的是
   * 媒体时间 video.currentTime。仿真循环一瞬间就跑完 40 秒的剧情，挂钟根本没动，
   * 于是补显的节流永远不会到期——队列会假性地越积越多，看起来像"字幕卡住"。
   * 真实播放时两者是同步走的，所以这里把 Date.now() 接到媒体时间上。 */
  const BASE_MS = Date.now();
  let virtualMs = 0;
  class FakeDate extends Date {
    static now() {
      return BASE_MS + virtualMs;
    }
  }

  const video = {
    readyState: 4,
    src: 'https://cdn.example.com/a.mp4',
    currentSrc: 'https://cdn.example.com/a.mp4',
    duration: 600,
    currentTime: 99,
    paused: false,
    playbackRate: RATE,
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 500, right: 900, bottom: 500 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null
  };

  const sandbox = {
    console,
    Date: FakeDate,
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
        id: 'sim',
        onMessage: { addListener: () => {} },
        sendMessage: async (m) => ({
          ok: true,
          settings: { baseUrl: 'https://api.example.com/v1', chunkSeconds: 6, fontSize: 22, typewriter: TYPEWRITER }
        }),
        getURL: (p) => 'chrome-extension://sim/' + p
      },
      storage: {
        session: { get: async () => ({}), remove: async () => {} },
        local: { get: async () => ({}), set: async () => {} }
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.__ZIMU__ = {
    bytesToBase64: () => '',
    base64ToBytes: () => new Uint8Array(0),
    Overlay: class {
      constructor() {
        this.host = { isConnected: false };
      }
      attachTo() {
        this.host.isConnected = true;
      }
      setState() {}
      setStatus() {}
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

  const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  const context = vm.createContext(sandbox);
  for (const file of manifest.content_scripts[0].js) {
    if (file.endsWith('overlay.js')) continue;
    const code = await readFile(path.join(distDir, file), 'utf8');
    new vm.Script(code, { filename: file }).runInContext(context);
  }

  const NS = sandbox.__ZIMU__;
  const controller = NS.controller;
  controller.video = video;
  await controller.ensureSettings(true);
  controller.overlay = new NS.Overlay();
  controller.overlay.attachTo(video);
  controller.typewriterEnabled = TYPEWRITER;
  controller.track = new NS.SubtitleTrack({ splitLongLines: true, minDisplaySeconds: 1.2 });
  controller.maxLagSeconds = controller.computeMaxLagSeconds();

  console.log(`识别延迟 ${LAG}s，播放倍速 ${RATE}x，分块 ${CHUNK}s，逐字：${TYPEWRITER ? '开' : '关'}`);
  console.log('时间    | 屏幕上的字幕');
  console.log('--------|' + '-'.repeat(50));

  /* 真实的识别是"按块回来"的：每 CHUNK 秒音频送一次，回来时把落在这一块里的
   * 全部句子一起给出。所以这里按块推进——一块里常常有 1~3 句，
   * 这才会走到"积压 ≥2"的补显分支（只看单句是验不到的）。 */
  const startAt = SCRIPT[0][0];
  const chunks = [];
  for (let s = startAt; s < SCRIPT[SCRIPT.length - 1][1]; s += CHUNK) {
    const e = s + CHUNK;
    const inChunk = SCRIPT.filter(([a]) => a >= s - 0.001 && a < e - 0.001);
    if (inChunk.length) chunks.push({ at: e + LAG, items: inChunk });
  }

  let next = 0;
  let lastLine = null;
  const STEP = 0.25;

  for (let t = startAt; t <= SCRIPT[SCRIPT.length - 1][1] + LAG + 8; t += STEP) {
    video.currentTime = Number(t.toFixed(2));
    virtualMs = (video.currentTime - startAt) * 1000;
    while (next < chunks.length && chunks[next].at <= video.currentTime) {
      const block = chunks[next];
      for (const [a, b, text] of block.items) {
        const r = controller.track.addChunk({ start: a, end: b, text });
        controller.enqueueLaggingSegments(r.added);
      }
      next++;
    }
    controller.renderFrame();
    const text = controller.overlay.captionText || '';
    if (text !== lastLine) {
      lastLine = text;
      console.log(`${video.currentTime.toFixed(2).padStart(6)}s | ${text || '（空）'}`);
    }
  }

  /* 末尾：让真实的墙钟走一会儿，看"打完停留一会儿再消失"到底会不会触发。
   * 前面那些帧是瞬间跑完的，挂钟几乎没动，所以这一步必须真等。 */
  console.log('');
  console.log('--- 末尾（真实等待，观察"打完 → 停留 → 消失"）---');
  let lastAfter = controller.overlay.captionText || '';
  console.log(`${video.currentTime.toFixed(2).padStart(6)}s | ${lastAfter || '（空）'}`);
  for (let i = 0; i < 8; i++) {
    const wait = 400;
    await new Promise((r) => setTimeout(r, wait));
    virtualMs += wait;
    video.currentTime = Number((video.currentTime + wait / 1000).toFixed(2));
    controller.renderFrame();
    const text = controller.overlay.captionText || '';
    if (text !== lastAfter) {
      lastAfter = text;
      console.log(`${video.currentTime.toFixed(2).padStart(6)}s | ${text || '（空）← 已消失'}`);
    }
  }

  for (const id of timers) {
    clearTimeout(id);
    clearInterval(id);
  }
  try {
    NS.stopAttachRetry?.();
  } catch (err) {
    /* 忽略 */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
