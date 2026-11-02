/**
 * 内容脚本的加载冒烟测试。
 *
 * 为什么需要它：manifest 里的 content script 是普通脚本，靠共享
 * globalThis.__ZIMU__ 传递类。只要有一个文件忘了挂载、或者加载顺序错了，
 * Chrome 里只会在用户点开关时静默失败。这里按 manifest 的真实顺序
 * 加载一遍，把这类问题提前暴露出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');
const manifestPath = path.join(distDir, 'manifest.json');

/** 造一个够用的浏览器环境假象：内容脚本在顶层只会注册监听、定义类。 */
function makeSandbox() {
  const listeners = [];
  const noop = () => {};
  const timers = new Set();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    /* 主控现在用定时重试来发现异步插入的视频。这里包装一层并登记句柄，
     * 让每个测试结束时能清干净——否则定时器会在测试结束后继续跑，
     * 触碰已经被丢弃的沙箱对象，Node 会报 unhandledRejection。 */
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
    MediaRecorder: class {},
    document: {
      readyState: 'loading',
      addEventListener: (...args) => listeners.push(['document', ...args]),
      removeEventListener: noop,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, appendChild: noop }),
      documentElement: { appendChild: noop },
      body: { appendChild: noop },
      fullscreenElement: null,
      title: 'test'
    },
    window: {
      addEventListener: (...args) => listeners.push(['window', ...args]),
      removeEventListener: noop,
      isSecureContext: true
    },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { host: 'example.com', pathname: '/lesson/1', href: 'https://example.com/lesson/1' },
    chrome: {
      runtime: {
        /* 必须有 id：主控用 chrome.runtime.id 判断“本页面是否是否还和扩展连着”。
         * 缺了它会被判定成扩展已失联，测试就跑到错误的分支上去了。 */
        id: 'test-extension-id',
        onMessage: { addListener: () => {} },
        sendMessage: async () => ({ ok: true, settings: {} }),
        getURL: (p) => 'chrome-extension://test/' + p
      },
      storage: { session: { get: async () => ({}), remove: async () => {} } }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  const stopTimers = () => {
    /* 先让主控停掉自动挂载巡检。它是自续期的 setTimeout，
     * 只清 interval 是拦不住的，定时器会一直排下去，
     * 表现为测试进程永不退出（看起来像卡死）。 */
    try {
      sandbox.__ZIMU__?.stopAttachRetry?.();
    } catch (err) {
      /* 还没加载到就忽略 */
    }
    for (const id of timers) clearInterval(id);
    timers.clear();
  };
  return { sandbox, listeners, stopTimers };
}

async function loadContentScripts(sandbox) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = manifest.content_scripts[0].js;
  const context = vm.createContext(sandbox);
  for (const file of files) {
    const code = await readFile(path.join(distDir, file), 'utf8');
    new vm.Script(code, { filename: file }).runInContext(context);
  }
  return files;
}

test('manifest 声明的内容脚本按顺序都能加载', async (t) => {
  const { sandbox, stopTimers } = makeSandbox();
  t.after(stopTimers);
  const files = await loadContentScripts(sandbox);
  assert.deepEqual(files, [
    'content/transcript.js',
    'content/binary.js',
    // 主控要靠它提前判断“识别服务在不在本机”，决定采集窗口用 1.6s 还是 chunkSeconds
    'content/settings.js',
    'content/capture.js',
    'content/wav-encoder.js',
    'content/audio-source.js',
    'content/overlay.js',
    'content/subtitles.js'
  ]);
  assert.ok(sandbox.__ZIMU__, '内容脚本应把命名空间挂到 globalThis');
});

test('内容脚本挂载了主控需要的全部成员', async (t) => {
  const { sandbox, stopTimers } = makeSandbox();
  t.after(stopTimers);
  await loadContentScripts(sandbox);
  const NS = sandbox.__ZIMU__;
  for (const name of [
    'AudioChunkCapturer',
    'measureLoudness',
    // 主控每块只解码一次：decodeChunk 同时给出 PCM 和响度
    'decodeChunk',
    'Overlay',
    'controller',
    'activate',
    'normalizeText',
    'dedupeAgainstPrevious',
    'splitIntoSegments',
    'SubtitleTrack',
    'toSRT',
    'toVTT',
    'toPlainText',
    // 音频传输用 base64，编码函数必须挂到内容脚本的命名空间上
    'bytesToBase64',
    'base64ToBytes',
    /* 流式只对本机服务生效，而采集窗口的长度要在开始录音前就定下来。
     * 主控靠这个函数提前判断，缺了它就会退回“云端也按 1.6s 切片”的老毛病。 */
    'isLocalRelayUrl'
  ]) {
    assert.ok(NS[name], `缺少 __ZIMU__.${name}`);
  }
  assert.equal(typeof NS.controller.toggle, 'function');
  assert.equal(typeof NS.controller.findVideo, 'function');
});

test('源码里用到的每个 __ZIMU__ 成员都真的存在', async (t) => {
  const { sandbox, stopTimers } = makeSandbox();
  t.after(stopTimers);
  // 这条测试是为了抓住一类很难发现的 bug：某个文件里写了 NS.foo，
  // 但没有任何地方定义 foo。JS 不会报错，只会在功能被触发时静默失败
  // （例如“导出 SRT”按钮点了没反应）。所以这里从源码里把所有
  // NS.xxx 的引用抠出来，逐个和运行时命名空间对照。
  const files = await loadContentScripts(sandbox);
  const NS = sandbox.__ZIMU__;

  const referenced = new Set();
  for (const file of files) {
    const code = await readFile(path.join(distDir, file), 'utf8');
    /* 只匹配独立的 NS.foo。
     * 必须加负向后顾：__ZIMU__ 的结尾正好是 "NS."，而 _ 也是单词字符，
     * 所以单纯的 \bNS\. 会把 "__ZIMU__" 里那一段也匹配进来（真的踩过）。 */
    for (const match of code.matchAll(/(?<![\w$])NS\.([A-Za-z_$][\w$]*)/g)) {
      referenced.add(match[1]);
    }
  }

  assert.ok(referenced.size > 5, `应解析出多个命名空间引用，实际 ${referenced.size}`);
  const missing = [...referenced].filter((name) => NS[name] === undefined);
  assert.deepEqual(missing, [], `这些成员被引用但从未定义：${missing.join(', ')}`);
});

test('内容脚本注册了快捷键监听', async (t) => {
  const { sandbox, listeners, stopTimers } = makeSandbox();
  t.after(stopTimers);
  await loadContentScripts(sandbox);
  const keydown = listeners.find(([target, type]) => target === 'window' && type === 'keydown');
  assert.ok(keydown, '应注册 Alt+Shift+Z 快捷键');
});

test('生成的 transcript.js 不含 ES module 语法', async () => {
  // content script 里出现 import/export 会让整个文件加载失败
  const code = await readFile(path.join(distDir, 'content', 'transcript.js'), 'utf8');
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, '内容脚本不得包含 import/export');
  assert.match(code, /NS\.SubtitleTrack = SubtitleTrack/);
});

test('manifest 引用的文件都真实存在', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...manifest.content_scripts[0].js
  ];
  for (const file of referenced) {
    await assert.doesNotReject(
      () => readFile(path.join(distDir, file)),
      `manifest 引用了不存在的文件：${file}`
    );
  }
});

test('manifest 权限遵循最小化原则', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  // 不要求 <all_urls> 之类的宽泛 host permission，改为运行时按需申请
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
  assert.ok(Array.isArray(manifest.optional_host_permissions));
  /* tabCapture / offscreen 是“抓取标签页声音”这条兜底路径必需的；
   * scripting 用于从插件图标手动唤出面板（自动探测失败时的兜底入口）。 */
  assert.deepEqual(manifest.permissions, ['storage', 'tabCapture', 'offscreen', 'scripting']);
  // 不允许把远程脚本当成扩展脚本执行（审核与安全红线）
  assert.equal(manifest.content_scripts[0].matches.includes('<all_urls>'), false);
});

test('抓取标签页声音所需的离屏文档已在 manifest 中被正确引用', async () => {
  // 离屏文档不是 manifest 的常规字段，由 background 在运行时创建，
  // 所以这里直接验证文件存在且内容正确。
  const html = await readFile(path.join(distDir, 'offscreen', 'offscreen.html'), 'utf8');
  assert.match(html, /offscreen\.js/, '离屏文档必须引入它的脚本');
  const js = await readFile(path.join(distDir, 'offscreen', 'offscreen.js'), 'utf8');
  // 离屏文档只提供上下文与就绪探测；真正的流由内容脚本消费
  assert.match(js, /offscreen:probe/, '应能响应 background 的就绪探测');
  /* 不应在离屏文档里再抓一次流：Chrome 拒绝同一标签页存在两个抓取，
   * 那会直接报 “Cannot capture a tab with an active stream”。
   * 注意只匹配真实调用写法——注释里提到这个词是允许的。 */
  assert.doesNotMatch(
    js,
    /navigator\.mediaDevices/,
    '离屏文档不得再消费一个 streamId，否则同一标签页会有两个抓取'
  );
  assert.doesNotMatch(
    js,
    /chromeMediaSource/,
    '离屏文档不得自己抓取标签页音频，streamId 只交给内容脚本消费'
  );
});
