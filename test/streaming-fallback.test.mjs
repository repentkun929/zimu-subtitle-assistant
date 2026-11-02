/**
 * 流式降级 / 采集窗口回滚的测试。
 *
 * 来自用户实测日志。日志里明明写着「流式识别不可用，已退回分块模式」，
 * 可紧接着的每一块却都是 1.6s —— 因为采集窗口的长度是在**开始录音前**
 * 按流式的切片长度定下的，降级时只改了 streamActive、没改窗口。
 *
 * 后果很严重：每 1.6 秒就把一句话从中间切断送一次识别，模型拿不到上下文，
 * 错字漏字成倍增加，请求数还变成原来的三四倍。这一组测试把两个防线都钉住：
 *  1. 云端地址根本不该起流式（shouldUseStreaming 提前判否）；
 *  2. 万一还是降级了，必须把采集窗口改回 chunkSeconds。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/** 造一个够用的浏览器假象，并按 manifest 的真实顺序加载内容脚本。 */
async function loadContentScripts() {
  const timers = new Set();
  const noop = () => {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
      clearInterval(id);
    },
    requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: noop,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    performance,
    URL,
    Blob,
    FormData,
    MediaRecorder: class {
      static isTypeSupported() {
        return true;
      }
    },
    document: {
      readyState: 'loading',
      addEventListener: noop,
      removeEventListener: noop,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({
        style: {},
        classList: { add: noop, remove: noop, toggle: noop },
        appendChild: noop
      }),
      documentElement: { appendChild: noop },
      body: { appendChild: noop },
      fullscreenElement: null,
      title: 'test'
    },
    window: { addEventListener: noop, removeEventListener: noop, isSecureContext: true },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { host: 'example.com', pathname: '/lesson/1', href: 'https://example.com/lesson/1' },
    chrome: {
      runtime: {
        id: 'test-extension-id',
        onMessage: { addListener: noop },
        sendMessage: async () => ({ ok: true, settings: {} }),
        getURL: (p) => 'chrome-extension://test/' + p
      },
      storage: { session: { get: async () => ({}), remove: async () => {} } }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  const context = vm.createContext(sandbox);
  for (const file of manifest.content_scripts[0].js) {
    const code = await readFile(path.join(distDir, file), 'utf8');
    new vm.Script(code, { filename: file }).runInContext(context);
  }

  const stopTimers = () => {
    try {
      sandbox.__ZIMU__?.stopAttachRetry?.();
    } catch (err) {
      /* 还没加载到就忽略 */
    }
    for (const id of timers) clearInterval(id);
    timers.clear();
  };
  return { sandbox, stopTimers };
}

/** 造一个最小的控制器替身：只跑与“流式决策/降级”有关的那几个方法。 */
function makeController(sandbox, { chunkSeconds = 6, overlapSeconds = 0, baseUrl, streaming = true }) {
  const controller = sandbox.__ZIMU__.controller;
  const chunkingCalls = [];
  const statuses = [];

  controller.settings = {
    streaming,
    baseUrl,
    chunkSeconds,
    overlapSeconds,
    streamSliceSeconds: 1.6,
    streamOverlapSeconds: 0.4
  };
  controller.capturer = {
    chunkSeconds: streaming ? 1.6 : chunkSeconds,
    setChunking(options) {
      chunkingCalls.push(options);
      return true;
    }
  };
  controller.overlay = { setStatus: (text) => statuses.push(text) };
  controller.streamActive = streaming;
  return { controller, chunkingCalls, statuses };
}

test('云端地址不该起流式：采集窗口一开始就用 chunkSeconds', async (t) => {
  const { sandbox, stopTimers } = await loadContentScripts();
  t.after(stopTimers);

  const cloud = makeController(sandbox, {
    baseUrl: 'https://api.siliconflow.cn/v1',
    streaming: true
  });
  assert.equal(
    cloud.controller.shouldUseStreaming(),
    false,
    '云端没有 /audio/stream，而且反复解码会多花钱，必须判否'
  );

  const bailian = makeController(sandbox, {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    streaming: true
  });
  assert.equal(bailian.controller.shouldUseStreaming(), false, '百炼同样是云端');
});

test('本机服务才起流式', async (t) => {
  const { sandbox, stopTimers } = await loadContentScripts();
  t.after(stopTimers);

  for (const baseUrl of ['http://127.0.0.1:8788/v1', 'http://localhost:8787/v1']) {
    const { controller } = makeController(sandbox, { baseUrl, streaming: true });
    assert.equal(controller.shouldUseStreaming(), true, `${baseUrl} 应走流式`);
  }
});

test('用户关掉流式开关时不启用（哪怕服务在本机）', async (t) => {
  const { sandbox, stopTimers } = await loadContentScripts();
  t.after(stopTimers);

  const { controller } = makeController(sandbox, {
    baseUrl: 'http://127.0.0.1:8788/v1',
    streaming: false
  });
  assert.equal(controller.shouldUseStreaming(), false);
});

test('降级时把采集窗口改回 chunkSeconds（这是错字漏字的真因）', async (t) => {
  const { sandbox, stopTimers } = await loadContentScripts();
  t.after(stopTimers);

  const { controller, chunkingCalls, statuses } = makeController(sandbox, {
    baseUrl: 'http://127.0.0.1:8788/v1',
    chunkSeconds: 6,
    overlapSeconds: 1,
    streaming: true
  });
  controller.streamActive = true;

  controller.fallBackToChunkMode('本机服务不支持流式识别');

  assert.equal(controller.streamActive, false, '降级后不能再走流式分支');
  assert.equal(chunkingCalls.length, 1, '必须调用一次 setChunking');
  /* 注意：这个对象是在 vm 上下文里造的，原型与本测试文件不同，
   * 所以只能逐字段比，不能 deepStrictEqual（会因原型不同而失败）。 */
  assert.equal(chunkingCalls[0].chunkSeconds, 6);
  assert.equal(chunkingCalls[0].overlapSeconds, 1);
  assert.equal(statuses.length, 1, '要给用户一条看得见的提示');
  assert.match(statuses[0], /退回/);
});

test('已经在分块模式时降级是空操作（不重复改窗口）', async (t) => {
  const { sandbox, stopTimers } = await loadContentScripts();
  t.after(stopTimers);

  const { controller, chunkingCalls } = makeController(sandbox, {
    baseUrl: 'http://127.0.0.1:8788/v1',
    streaming: false
  });
  controller.streamActive = false;

  controller.fallBackToChunkMode('重复调用');
  assert.equal(chunkingCalls.length, 0, '本来就没在流式，不该动采集窗口');
});

test('setChunking：生效、幂等、坏值不动', async (t) => {
  const { sandbox, stopTimers } = await loadContentScripts();
  t.after(stopTimers);

  const media = {
    paused: false,
    currentTime: 0,
    readyState: 4,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  const capturer = new sandbox.__ZIMU__.AudioChunkCapturer(media, {
    chunkSeconds: 1.6,
    overlapSeconds: 0.4,
    onChunk: () => {},
    onStatus: () => {},
    log: () => {}
  });

  assert.equal(capturer.chunkSeconds, 1.6, '构造时应保留流式的短窗口');

  assert.equal(capturer.setChunking({ chunkSeconds: 6, overlapSeconds: 1 }), true);
  assert.equal(capturer.chunkSeconds, 6);
  assert.equal(capturer.overlapSeconds, 1);

  assert.equal(capturer.setChunking({ chunkSeconds: 6, overlapSeconds: 1 }), false, '没变化应返回 false');
  assert.equal(capturer.chunkSeconds, 6, '没变化时不该被改坏');

  // 坏值：既不接受 0/负数，也不接受 NaN —— 否则会退化成“每 0 秒开一个窗口”
  capturer.setChunking({ chunkSeconds: 0 });
  assert.equal(capturer.chunkSeconds, 6);
  capturer.setChunking({ chunkSeconds: -3 });
  assert.equal(capturer.chunkSeconds, 6);
  capturer.setChunking({ chunkSeconds: Number.NaN });
  assert.equal(capturer.chunkSeconds, 6);

  capturer.setChunking({});
  assert.equal(capturer.chunkSeconds, 6, '只传空对象时两个值都不动');
  assert.equal(capturer.overlapSeconds, 1);

  // 重叠上限与设置侧保持一致（≤5 秒）
  capturer.setChunking({ chunkSeconds: 6, overlapSeconds: 99 });
  assert.equal(capturer.overlapSeconds, 5);
});

test('本机地址判定函数确实被内联进了内容脚本', async (t) => {
  const { sandbox, stopTimers } = await loadContentScripts();
  t.after(stopTimers);

  assert.equal(typeof sandbox.__ZIMU__.isLocalRelayUrl, 'function');
  assert.equal(sandbox.__ZIMU__.isLocalRelayUrl('http://127.0.0.1:8788/v1'), true);
  assert.equal(sandbox.__ZIMU__.isLocalRelayUrl('https://api.siliconflow.cn/v1'), false);
});
