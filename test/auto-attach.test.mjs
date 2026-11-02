/**
 * 自动挂载时机的回归测试。
 *
 * 覆盖的是一个真实踩过的坑：插件装好了、设置也填对了，但视频页面上
 * 什么都没有——因为悬浮按钮要等 autoAttach 成功才创建，
 * 而 autoAttach 当时依赖 window 的 load 事件、且只探测一次。
 * 教学平台的 load 可能很久不触发，视频也常常是异步插进 DOM 的，
 * 于是用户彻底找不到入口。
 *
 * 这里用桩件替换 Overlay（不渲染真实 DOM），只验证“发现时机”这一件事。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/** 造一个 video 元素，只要 findVideo 需要的字段和 rect 就够了。 */
function makeVideo({ width = 900, height = 500, currentTime = 0, paused = true, duration = 600 } = {}) {
  const listeners = new Map();
  return {
    readyState: 4,
    src: 'https://cdn.example.com/lesson1.mp4',
    currentSrc: 'https://cdn.example.com/lesson1.mp4',
    duration,
    currentTime,
    paused,
    isConnected: true,
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0, right: width, bottom: height }),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: () => {},
    querySelector: () => null,
    __fire: (type) => (listeners.get(type) || []).forEach((fn) => fn({ type }))
  };
}

/** 造一个够用的浏览器环境；Overlay 被替换成桩件，所以不需要真实渲染能力。 */
function makeSandbox({ videos = [] } = {}) {
  const videoList = [...videos];
  const intervals = new Set();
  const timeouts = new Set();
  const documentListeners = new Map();

  const sandbox = {
    console,
    /* 定时器全部登记：主控的自动挂载巡检是自续期的 setTimeout，
     * 不清理就会让 Node 进程一直不退出（表现为测试卡死）。 */
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => {
        timeouts.delete(id);
        fn();
      }, ms);
      timeouts.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timeouts.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
      clearInterval(id);
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance,
    URL,
    Blob,
    FormData,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      readyState: 'interactive',
      title: '课程页面',
      body: { appendChild: () => {}, removeChild: () => {} },
      documentElement: { appendChild: () => {}, removeChild: () => {} },
      fullscreenElement: null,
      querySelectorAll: (selector) => (selector === 'video' ? videoList.slice() : []),
      querySelector: () => null,
      createElement: () => ({
        style: { cssText: '', display: '', left: '', top: '', width: '', height: '' },
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        appendChild: () => {},
        remove: () => {},
        click: () => {},
        setAttribute: () => {}
      }),
      addEventListener: (type, fn) => {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(fn);
      },
      removeEventListener: () => {},
      __listeners: documentListeners
    },
    window: {
      isSecureContext: true,
      addEventListener: () => {},
      removeEventListener: () => {},
      open: () => {}
    },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { host: '172.18.0.1', pathname: '/sections/abc', href: 'https://172.18.0.1/sections/abc' },
    chrome: {
      runtime: {
        /* id 必须有：主控用 chrome.runtime.id 判断“本页面是否还和扩展连着”。
         * 缺了它会被判定为“扩展已失联”，从而走上下文失效分支。 */
        id: 'test-extension-id',
        // 主控会注册消息监听（用于插件图标手动唤出面板）
        onMessage: { addListener: () => {} },
        sendMessage: async () => ({ ok: true, settings: { baseUrl: 'https://api.siliconflow.cn/v1', fontSize: 22, bottomPercent: 8 } }),
        getURL: (p) => 'chrome-extension://test/' + p
      },
      storage: {
        session: { get: async () => ({}), remove: async () => {} },
        local: { get: async () => ({}), set: async () => {} }
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  return {
    sandbox,
    videoList,
    /** 模拟“播放器稍后才被插进页面” */
    addVideoLater: (video, delayMs = 0) => {
      setTimeout(() => videoList.push(video), delayMs);
    },
    stopAllTimers: () => {
      // 先停掉主控自续期的巡检，否则它会一直排新的定时器
      try {
        sandbox.__ZIMU__?.stopAttachRetry?.();
      } catch (err) {
        /* 还没加载到就忽略 */
      }
      for (const id of intervals) clearInterval(id);
      intervals.clear();
      for (const id of timeouts) clearTimeout(id);
      timeouts.clear();
    }
  };
}
/**
 * 只加载内容主控（跳过真实 overlay.js，用桩件代替），
 * 并把桩件 Overlay 注入到命名空间里。
 */
/** 让扩展的配置读取返回桩件数据，并记录所有发往 background 的消息。 */
async function loadControllerWithStubOverlay(sandbox, initialSettings = {}) {  const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  const files = manifest.content_scripts[0].js;
  const context = vm.createContext(sandbox);

  // 桩件的配置来源，测试可以改它来模拟“用户改了设置”
  const storedSettings = {
    baseUrl: 'https://api.siliconflow.cn/v1',
    fontSize: 22,
    bottomPercent: 8,
    ...initialSettings
  };

  const attached = [];
  /* 桩件 Overlay：不做渲染，但必须模拟真实 Overlay 对外可见的两个关键成员——
   * host.isConnected（挂载逻辑靠它判断“节点是否还在文档里”，从而决定重建与否）
   * 和 attachTo。缺了它们就测不出“悬浮球消失后能否自愈”这个关键行为。 */
  // 内容脚本会用这两个函数把音频编成 base64（真实实现从 dist 引入）
  const binarySource = await readFile(path.join(distDir, 'content', 'binary.js'), 'utf8');
  const binarySandbox = { console, Uint8Array, ArrayBuffer, Blob, Error };
  binarySandbox.globalThis = binarySandbox;
  vm.createContext(binarySandbox);
  new vm.Script(binarySource, { filename: 'content/binary.js' }).runInContext(binarySandbox);
  sandbox.__ZIMU__ = {
    bytesToBase64: binarySandbox.__ZIMU__.bytesToBase64,
    base64ToBytes: binarySandbox.__ZIMU__.base64ToBytes,
    Overlay: class {
      constructor() {
        this.state = null;
        this.status = null;
        this.attachedTo = null;
        this.host = { isConnected: false };
      }
      attachTo(video) {
        if (this.attachedTo === video && this.host.isConnected) return;
        this.attachedTo = video;
        this.host.isConnected = true;
        attached.push(video);
      }
      setState(s) {
        this.state = s;
      }
      setStatus(t) {
        this.status = t;
      }
      openCard() {}
      toast() {}
      showCaption() {}
      destroy() {
        this.host.isConnected = false;
      }
    }
  };

  // 让扩展的配置读取返回桩件数据，并记录所有发出的消息
  const sentMessages = [];
  sandbox.chrome.runtime.sendMessage = async (message) => {
    sentMessages.push(message);
    if (message && message.type === 'zimu:get-public-settings') {
      return { ok: true, settings: { ...storedSettings } };
    }
    return { ok: true };
  };

  for (const file of files) {
    if (file.endsWith('overlay.js')) continue; // 用桩件代替真实的叠加层
    const code = await readFile(path.join(distDir, file), 'utf8');
    new vm.Script(code, { filename: file }).runInContext(context);
  }
  return {
    attached,
    storedSettings,
    sentMessages
  };
}

test('页面一开始就有视频时，立即挂上悬浮按钮', async (t) => {
  const video = makeVideo();
  const env = makeSandbox({ videos: [video] });
  t.after(() => env.stopAllTimers());

  const { attached } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(attached.length, 1, '应立即自动挂载，不依赖 load 事件');
  assert.equal(attached[0], video);
  assert.ok(env.sandbox.__ZIMU__.controller.overlay, 'controller.overlay 应已就绪');
});

test('视频是稍后才插入 DOM 时，重试机制能发现它', async (t) => {
  const env = makeSandbox({ videos: [] });
  t.after(() => env.stopAllTimers());

  const { attached } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(attached.length, 0, '一开始没有视频，不应挂载');

  // 1.6 秒后才出现，晚于第一次探测，只能靠定时重试发现
  const video = makeVideo();
  env.addVideoLater(video, 1600);
  await new Promise((r) => setTimeout(r, 3600));

  assert.equal(attached.length, 1, '重试应发现后插入的视频');
  assert.equal(attached[0], video);
});

test('播放器拿到元数据（loadedmetadata）时也会补一次探测', async (t) => {
  const env = makeSandbox({ videos: [] });
  t.after(() => env.stopAllTimers());

  const { attached } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 50));

  const video = makeVideo();
  env.videoList.push(video);
  // 直接触发 document 上的 loadedmetadata（主控用捕获阶段监听）
  const handlers = env.sandbox.document.__listeners?.get('loadedmetadata') || [];
  assert.ok(handlers.length > 0, '主控应注册 loadedmetadata 监听');
  for (const fn of handlers) fn();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(attached.length, 1, 'loadedmetadata 应触发一次补探测');
});

test('挂载成功后不再重复挂载，避免页面上出现多个悬浮按钮', async (t) => {
  const video = makeVideo();
  const env = makeSandbox({ videos: [video] });
  t.after(() => env.stopAllTimers());

  const { attached } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 3200)); // 跨过好几轮重试

  assert.equal(attached.length, 1, `只应挂载一次，实际 ${attached.length} 次`);
});

test('没有视频的页面不会挂载，也不会抛错', async (t) => {
  const env = makeSandbox({ videos: [] });
  t.after(() => env.stopAllTimers());

  const { attached } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(attached.length, 0);
});

test('悬浮球被页面删掉后能自己回来（自愈）', async (t) => {
  const video = makeVideo();
  const env = makeSandbox({ videos: [video] });
  t.after(() => env.stopAllTimers());

  const { attached } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(attached.length, 1, '应先正常挂载一次');

  // 模拟节点被页面删除：用户看到的现象就是“悬浮球凭空消失了”
  const controller = env.sandbox.__ZIMU__.controller;
  controller.overlay.host.isConnected = false;

  // 巡检间隔是 8 秒，这里给足时间
  await new Promise((r) => setTimeout(r, 9000));
  assert.equal(attached.length, 2, '巡检应发现节点已丢失并重新挂上去');
  assert.ok(controller.overlay.host.isConnected, '重建后的节点应在文档里');
});

test('用户关掉悬浮按钮时不再强行挂载', async (t) => {
  const video = makeVideo();
  const env = makeSandbox({ videos: [video] });
  t.after(() => env.stopAllTimers());

  const { attached, storedSettings } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(attached.length, 1);

  /* 模拟“用户在设置里关掉了悬浮按钮，节点也被删掉”。
   * 必须改桩件的配置源，而不是直接改 controller.settings——
   * 巡检会重新读取配置，直接改内存里的对象会被覆盖掉。 */
  storedSettings.showFloatingButton = false;
  env.sandbox.__ZIMU__.controller.overlay.host.isConnected = false;

  await new Promise((r) => setTimeout(r, 9000));
  assert.equal(attached.length, 1, '用户明确关掉后不该再挂载');
});

test('自动降级只影响本次会话，绝不改写用户保存的设置', async (t) => {
  /* 这是一个真实造成严重后果的 bug：早期版本把自动降级的结果写进了设置，
   * 于是 captureMode 被永久改成 tab。此后每次开启字幕都强制走标签页模式，
   * 而那条路在用户平台上报 “Cannot capture a tab with an active stream”，
   * 表现为——明明元素模式可用（诊断录到 156KB、峰值 1.0），插件却一路报错。
   * 所以这里锁死：降级不得触发任何保存设置的消息。 */
  const video = makeVideo();
  const env = makeSandbox({ videos: [video] });
  t.after(() => env.stopAllTimers());

  const { storedSettings, sentMessages } = await loadControllerWithStubOverlay(env.sandbox);
  const controller = env.sandbox.__ZIMU__.controller;
  controller.video = video;

  // 模拟“元素模式连续多块读不到数据”的通知
  await controller.handleNoAudioData({ state: 'no-audio-data', mode: 'element' });

  const saveCalls = sentMessages.filter((m) => m && m.type === 'zimu:save-settings');
  assert.deepEqual(
    saveCalls.map((m) => JSON.stringify(m.patch)),
    [],
    '自动降级不该保存任何设置'
  );
  assert.equal(storedSettings.captureMode, undefined, '用户的采集方式设置不该被自动改写');
  assert.equal(controller.sessionCaptureMode, 'tab', '降级应只作用于本次会话');

  /* 关键：start() 不能把刚设好的会话级覆盖清掉。
   * 早期实现把重置放在 start() 开头，导致降级刚生效就被自己清空——
   * 这正是那条回归测试抓到的 bug。 */
  assert.equal(
    sentMessages.filter((m) => m && m.type === 'zimu:acquire-tab-stream').length,
    0,
    '本测试没有 fake 浏览器 API，不应真的走到抓取标签页'
  );
});

test('音频块用 base64 字符串传输，不用二进制对象', async (t) => {
  /* 教训（连续踩了三次）：
   *  1. 传 Blob 对象 —— 后台收到 0 字节；
   *  2. 传 ArrayBuffer —— 后台收到“未知二进制形态(object)”；
   *  3. 传 TypedArray —— 同样被克隆降级成普通对象。
   * 结论：这台机器上 sendMessage 不保留二进制类型，只有字符串可靠。
   * 所以音频必须以 base64 字符串发送，这条行为必须锁住。 */
  const env = makeSandbox({ videos: [] });
  t.after(() => env.stopAllTimers());
  const { sentMessages } = await loadControllerWithStubOverlay(env.sandbox);
  const controller = env.sandbox.__ZIMU__.controller;
  await controller.ensureSettings(true);

  const bytes = new Uint8Array(1024).fill(7);
  await controller.sendChunkForTranscription({
    blob: new Blob([bytes], { type: 'audio/webm' }),
    index: 0,
    start: 0,
    end: 12
  });

  const transcribe = sentMessages.find((m) => m && m.type === 'zimu:transcribe');
  assert.ok(transcribe, '应发出识别请求');
  assert.equal(typeof transcribe.base64, 'string', '必须用 base64 字符串传输');
  assert.equal(transcribe.blob, undefined, '不能传 Blob 对象');
  assert.equal(transcribe.buffer, undefined, '不能传二进制缓冲');
  assert.equal(transcribe.expectedSize, 1024, '应带上本地字节数便于对照');
  assert.equal(transcribe.mimeType, 'audio/webm');

  // 字符串内容必须能原样还原出 1024 个字节
  const decoded = env.sandbox.__ZIMU__.base64ToBytes(transcribe.base64);
  assert.equal(decoded.length, 1024, 'base64 解码后字节数必须一致');
  assert.equal(decoded[0], 7);
  assert.equal(decoded[1023], 7);
});

test('扩展上下文失效时明确提示刷新，而不是报“没有配置”', async (t) => {  const video = makeVideo();
  const env = makeSandbox({ videos: [video] });
  t.after(() => env.stopAllTimers());

  const { attached } = await loadControllerWithStubOverlay(env.sandbox);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(attached.length, 1);

  /* 模拟用户点了 chrome://extensions 的刷新按钮：
   * 页面里的脚本还在，但 chrome.runtime.id 变成 undefined。
   * 必须提示“刷新页面”，绝不能报成“还没配置识别服务”——
   * 后者会把用户引去反复检查 API Key，方向完全错了。 */
  delete env.sandbox.chrome.runtime.id;
  const controller = env.sandbox.__ZIMU__.controller;
  controller.settings = null;
  await controller.start();

  assert.ok(controller.overlay, '上下文失效也不该让悬浮球消失');
  assert.match(String(controller.overlay.status), /刷新页面/, `状态提示应要求刷新页面，实际：${controller.overlay.status}`);
  assert.match(String(controller.overlay.status), /扩展/);
  assert.doesNotMatch(String(controller.overlay.status), /还没配置识别服务/);
});
