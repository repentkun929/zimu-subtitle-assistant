/**
 * Background service worker。
 *
 * 它承担三件事：
 *  1. 保管 API Key —— 页面里的 content script 永远拿不到明文 Key；
 *  2. 发起跨域识别请求 —— 页面脚本受同源策略限制，service worker 不受；
 *  3. 记住用户授权过的域名 —— MV3 的可选权限机制，装插件时不用一次要全部网站权限。
 *
 * MV3 的 service worker 会被浏览器随时休眠，所以这里不保存任何内存状态，
 * 设置一律走 chrome.storage。
 */

import {
  loadSettings,
  saveSettings,
  publicSettings,
  normalizeSettings,
  permissionPatternFor,
  isLocalRelayUrl
} from '../common/settings.js';
import { transcribeBlob, testConnection, TranscriptionError } from '../common/asr-client.js';
import { bufferToBlob, describeBinary, base64ToBytes } from '../common/binary.js';

// 说明：音频数据用 base64 字符串传输，而不是二进制对象。
// 实测这台机器上 chrome.runtime.sendMessage 不保留 ArrayBuffer/TypedArray 的类型，
// 接收端会拿到普通对象（见 common/binary.js 顶部说明）。字符串则始终可靠。

const LOG_PREFIX = '[字幕助手]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

/** 每个标签页/每个视频的识别结果缓存，避免重看或拖动后重复花钱。 */
const CACHE_LIMIT = 400;

async function readCache() {
  try {
    const stored = await chrome.storage.session.get('transcriptCache');
    return stored.transcriptCache || {};
  } catch (err) {
    return {};
  }
}

async function writeCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    for (const key of keys.slice(0, keys.length - CACHE_LIMIT)) delete cache[key];
  }
  try {
    await chrome.storage.session.set({ transcriptCache: cache });
  } catch (err) {
    log('写缓存失败', err);
  }
}

/** 用音频内容 + 关键参数算缓存键：同一段音频重复识别时直接命中。 */
async function cacheKeyFor(blob, settings) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hash}|${settings.model}|${settings.language}|${settings.baseUrl}`;
}

/**
 * 确保扩展有权访问目标服务。
 * MV3 里跨域 fetch 需要 host permission；为了不在安装时索要“所有网站”权限，
 * 这里按需申请，用户在设置页点一下同意即可。
 *
 * 关键限制：chrome.permissions.request 必须由用户手势触发，
 * service worker 里没有手势，所以这里只做检查，真正的申请交给设置页按钮。
 */
async function ensureHostPermission(url) {
  let pattern;
  let broad;
  try {
    pattern = permissionPatternFor(url);
    broad = `${new URL(url).origin}/*`;
  } catch (err) {
    throw new TranscriptionError(`接口地址不是合法的网址：${url}`);
  }

  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  if (await chrome.permissions.contains({ origins: [broad] })) return true;

  throw new TranscriptionError(
    `还没有授权访问 ${new URL(url).origin}。请点插件图标，在设置里按“授权访问该服务域名”，然后重试。`
  );
}

function requireApiKey(settings) {
  if (settings.apiKey || isLocalRelayUrl(settings.baseUrl)) return;
  let host = settings.baseUrl;
  try {
    host = new URL(settings.baseUrl).hostname;
  } catch (err) {
    /* 地址非法时下面 ensureHostPermission 会给出更准确的报错 */
  }
  throw new TranscriptionError(
    `还没有填 API Key。请点插件图标填入 ${host} 的 Key；` +
      '或者改用本地中继（把 Key 存在自己电脑上，扩展里可以留空）。'
  );
}

async function handleTranscribe(message, sender) {
  const settings = await loadSettings();
  const incoming = message.settings || {};

  /* 识别参数一律以“已保存的设置”为准，页面消息只能覆盖 language 这一项。
   *
   * 为什么这么严：normalizeSettings 会把缺失字段补成默认值，
   * 如果直接 {...settings, ...message.settings}，一个字段没发的消息
   * 也会把 enableCache、baseUrl 等重置成默认值——等于让页面间接改了配置。
   * 更要紧的是 baseUrl/apiKey 属于请求目标，绝不能让页面改写。 */
  const effective = normalizeSettings({
    ...settings,
    ...(typeof incoming.language === 'string' || incoming.language === ''
      ? { language: incoming.language }
      : {})
  });

  if (!effective.baseUrl) {
    throw new TranscriptionError('还没配置识别服务，请点插件图标进入设置。');
  }

  requireApiKey(effective);
  await ensureHostPermission(effective.baseUrl);

  // 内容脚本传的是原始字节，这里还原成 Blob（见 bufferToBlob 的说明）
  const blob = bufferToBlob(message);

  /* 精确诊断：内容脚本说发了 98KB，这里必须能看出收到了什么形态、还原成多大。 */
  log(
    `收到音频：${describeBinary(message)} → 还原后 ${blob ? blob.size : '失败'} 字节` +
      `（第 ${message.chunkIndex ?? '?'} 块）`
  );

  if (!blob) {
    throw new TranscriptionError(
      `音频数据形态无法识别（收到的是 ${describeBinary(message)}）。请把这条日志发给开发者。`
    );
  }
  if (blob.size === 0) {
    throw new TranscriptionError(
      `音频数据在传输过程中变成了 0 字节（内容脚本报告 ${message.expectedSize ?? '未知'} 字节）。` +
        '这是传输层问题，请把这条日志发给开发者。'
    );
  }

  const cache = await readCache();
  const key = await cacheKeyFor(blob, effective);
  if (effective.enableCache && cache[key]) {
    return { ok: true, text: cache[key], cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const result = await transcribeBlob(blob, effective, { signal: controller.signal });
    if (effective.enableCache) {
      cache[key] = result.text;
      await writeCache(cache);
    }
    return { ok: true, text: result.text, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

/* 可被设置页覆盖的字段。测试连接要用“还没保存的表单值”，所以允许这些字段覆盖。 */
const TESTABLE_FIELDS = ['baseUrl', 'apiKey', 'model', 'language', 'provider'];

/**
 * 流式识别：把一小片音频投给本机识别服务，取回「本次新定稿」的字幕段。
 *
 * 为什么只允许本机服务：
 *  - 云端接口没有 /audio/stream 这个端点，发过去只会 404；
 *  - 更要紧的是云端按次计费，而流式会把同一段音频反复解码（未定稿的部分
 *    每次都要重解），等于把费用乘上好几倍。
 * 所以非本机地址直接返回 fallback，让内容脚本安安静静退回分段模式。
 *
 * 注意 baseUrl/apiKey 仍以**已保存的设置**为准，页面消息不能改写请求目标——
 * 与 handleTranscribe 同一条规矩。
 */
async function handleTranscribeStream(message) {
  const settings = await loadSettings();
  const incoming = message.settings || {};
  const effective = normalizeSettings({
    ...settings,
    ...(typeof incoming.language === 'string' || incoming.language === ''
      ? { language: incoming.language }
      : {})
  });

  if (!effective.baseUrl) {
    throw new TranscriptionError('还没配置识别服务，请点插件图标进入设置。');
  }
  if (!isLocalRelayUrl(effective.baseUrl)) {
    return { ok: false, fallback: true, error: '流式识别只对本机识别服务生效，已退回分块模式。' };
  }

  requireApiKey(effective);
  await ensureHostPermission(effective.baseUrl);

  const endpoint = `${effective.baseUrl.replace(/\/+$/, '')}/audio/stream`;
  const form = new FormData();
  form.append('session', String(message.session || ''));
  form.append('model', effective.model || 'local-whisper');
  if (effective.language) form.append('language', effective.language);
  if (message.flush) form.append('flush', '1');
  if (Number.isFinite(message.start)) form.append('start', String(message.start));
  if (Number.isFinite(message.end)) form.append('end', String(message.end));

  if (!message.flush) {
    const bytes = base64ToBytes(message.base64);
    const blob = new Blob([bytes], { type: message.mimeType || 'audio/wav' });
    if (!blob.size) {
      throw new TranscriptionError('流式切片的音频是空的。');
    }
    form.append('file', blob, 'slice.wav');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal });
    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      const detail =
        (payload && (payload.error?.message || payload.message || payload.msg)) || rawText.slice(0, 200);
      return { ok: false, error: `流式识别失败（${response.status}）：${detail}` };
    }

    return {
      ok: true,
      segments: Array.isArray(payload && payload.segments) ? payload.segments : [],
      text: (payload && payload.text) || '',
      pending: (payload && payload.pending) || '',
      decodes: (payload && payload.decodes) || 0,
      avgDecodeMs: (payload && payload.avgDecodeMs) || 0
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: '流式识别超时（本机服务可能正忙于解码）。' };
    }
    return { ok: false, error: `连不上本机识别服务：${(err && err.message) || err}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 预热识别服务。
 *
 * 为什么要做：用户实测发现前几块识别要 14~23 秒，而之后只要 0.3~0.5 秒——
 * 说明慢的是服务端冷启动/排队，不是模型算力。那就在用户点“开启字幕”的
 * 同时先发一个极小的静音请求把实例热起来，等第一块音频就绪时服务已经是热的。
 * 这个请求几乎不消耗额度（0.4 秒静音）。
 */
async function handleWarmUp(message) {
  const settings = await loadSettings();
  const effective = normalizeSettings({ ...settings, ...(message.settings || {}) });
  if (!effective.baseUrl || !effective.enableCache) {
    /* 这里不抛错：预热失败不该打断用户的主流程 */
  }
  try {
    requireApiKey(effective);
    await ensureHostPermission(effective.baseUrl);
    const started = Date.now();
    await testConnection(effective);
    const elapsedMs = Date.now() - started;
    log(`识别服务预热完成，耗时 ${elapsedMs}ms`);
    return { ok: true, elapsedMs };
  } catch (err) {
    // 预热只是优化，失败就静默返回，让正常流程自己报错
    log('预热失败（不影响正常流程）：', (err && err.message) || err);
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function handleTest(message) {
  const settings = await loadSettings();
  const incoming = message.settings || {};
  const overrides = {};
  for (const field of TESTABLE_FIELDS) {
    if (field in incoming) overrides[field] = incoming[field];
  }
  const effective = normalizeSettings({ ...settings, ...overrides });
  if (!effective.baseUrl) {
    throw new TranscriptionError('请先填写接口地址。');
  }
  requireApiKey(effective);
  await ensureHostPermission(effective.baseUrl);
  const result = await testConnection(effective);
  return { ok: true, ...result };
}

/**
 * 抓取某个标签页的声音（兜底采集路径）。
 *
 * 只申请**一个** streamId，交给内容脚本去生成 MediaStream 并分块录音。
 *
 * 这里踩过一个坑：为了“抓取后把声音接回扬声器”，我原先额外申请了第二个
 * streamId 给离屏文档做回放。结果是 Chrome 直接报
 * “Cannot capture a tab with an active stream”——同一个标签页不允许同时
 * 存在两个抓取。所以现在只申请一个，回放交给页面自己（页面播放不受影响）。
 *
 * 离屏文档仍然需要：getMediaStreamId 要求扩展存在可用的扩展页面上下文。
 */
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: '抓取标签页声音用于生成字幕'
    });
  } catch (err) {
    const text = String((err && err.message) || err);
    if (!/already exists|single offscreen/i.test(text)) throw err;
  }
}

async function handleAcquireTabStream(message, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') {
    return { ok: false, error: '拿不到当前标签页的 id，无法抓取声音。' };
  }

  await ensureOffscreenDocument();

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return { ok: true, streamId };
  } catch (err) {
    return {
      ok: false,
      error:
        `无法抓取这个标签页的声音：${(err && err.message) || err}。` +
        '常见原因：该标签页没有正在播放的声音；或上一次抓取还没完全释放。'
    };
  }
}

/**
 * 向当前标签页的内容脚本发一条指令（例如“请唤出面板”）。
 *
 * 存在的理由：自动探测依赖页面上能找到一个像样的 video 元素，
 * 而教学平台可能把它异步插入、放在特殊 iframe 里、或尺寸异常。
 * 一旦探测失败，用户看到的是“插件好像没生效”却毫无反馈。
 * 有了这个从插件图标触发的入口，用户可以随时手动唤出。
 */
async function handlePingContent(message, sender) {
  const tabId =
    (message && typeof message.tabId === 'number' && message.tabId) ||
    (sender && sender.tab && sender.tab.id);

  if (typeof tabId !== 'number') {
    // 从弹窗调用时没有 sender.tab，需要自己查当前活动标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') {
      return { ok: false, error: '找不到当前标签页。' };
    }
    return sendToTab(tab.id, message.command || 'retryAttach');
  }

  return sendToTab(tabId, message.command || 'retryAttach');
}

async function sendToTab(tabId, command) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { target: 'content', command });
    return { ok: true, response };
  } catch (err) {
    return {
      ok: false,
      error:
        `无法与页面通信：${(err && err.message) || err}。` +
        '通常是内容脚本还没加载——刷新一下视频页面（F5）再试。'
    };
  }
}

const HANDLERS = {
  'zimu:get-public-settings': async () => ({ ok: true, settings: publicSettings(await loadSettings()) }),
  'zimu:save-settings': async (message) => ({ ok: true, settings: publicSettings(await saveSettings(message.patch || {})) }),
  'zimu:transcribe': (message, sender) => handleTranscribe(message, sender),
  'zimu:transcribe-stream': (message, sender) => handleTranscribeStream(message, sender),
  'zimu:test-connection': (message) => handleTest(message),
  'zimu:warm-up': (message) => handleWarmUp(message),
  'zimu:acquire-tab-stream': (message, sender) => handleAcquireTabStream(message, sender),
  'zimu:ping-content': (message, sender) => handlePingContent(message, sender),
  'zimu:release-tab-playback': async () => {
    // 兼容旧调用：现在不需要离屏文档做任何释放，只是让内容脚本有统一的收尾点
    return { ok: true };
  },
  'zimu:permission-check': async (message) => {
    const origins = message.origins || [];
    if (!origins.length) return { ok: true, granted: true };
    return { ok: true, granted: await chrome.permissions.contains({ origins }) };
  },
  'zimu:permission-request': async (message) => {
    const origins = message.origins || [];
    if (!origins.length) return { ok: true, granted: true };
    return { ok: true, granted: await chrome.permissions.request({ origins }) };
  },
  'zimu:clear-cache': async () => {
    await writeCache({});
    return { ok: true };
  },
  'zimu:open-options': async () => {
    // options_ui 指向的就是设置页，openOptionsPage 在部分场景下不弹窗，
    // 所以再兜一层：直接在标签页里打开，保证用户一定看得到。
    try {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    } catch (err) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
      return { ok: true, fallback: true };
    }
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  const handler = HANDLERS[type];
  if (!handler) {
    sendResponse({ ok: false, error: `未知指令：${type}` });
    return false;
  }

  Promise.resolve()
    .then(() => handler(message, sender))
    .then((result) => sendResponse(result))
    .catch((err) => {
      const isKnown = err instanceof TranscriptionError;
      if (!isKnown) log('处理出错', type, err);
      sendResponse({
        ok: false,
        error: (err && err.message) || '未知错误',
        status: err && err.status,
        retryable: Boolean(err && err.retryable),
        detail: err && err.detail
      });
    });

  return true; // 异步响应
});

// 首次安装时给一个明确引导
chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await loadSettings();
  await saveSettings(settings);
  if (details.reason === 'install') {
    await chrome.storage.session.set({ installHint: true });
    log('已安装。请点插件图标完成识别服务配置。');
  }
});

// 工具栏图标直接由 manifest 的 default_popup 打开，无需额外处理。
chrome.action?.setBadgeBackgroundColor?.({ color: '#2f6feb' });
