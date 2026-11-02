/**
 * 设置面板逻辑。作为扩展页面，它可以直接 import 公共模块。
 */

import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  loadSettings,
  saveSettings,
  normalizeSettings,
  permissionPatternFor,
  resolveEndpointUrl
} from '../common/settings.js';
import { detectTextOnlyProvider } from '../common/asr-client.js';

const $ = (id) => document.getElementById(id);

let current = null;

/**
 * 当前生效的调用协议。
 *
 * 为什么不直接从表单读：预设里带着协议（例如百炼的 qwen3-asr-flash 必须走 chat），
 * 换供应商时要跟着一起换。用户也可以在下拉框里手动改，改完同步到这里。
 */
let currentApiStyle = 'transcriptions';

function setStatus(message, level = '') {
  const el = $('status');
  el.textContent = message || '';
  el.className = level;
}

/**
 * 填地址时就提醒“这家只有文本模型”。
 * 与其等用户点了测试连接再看报错，不如在他粘贴地址的当下就说清楚，
 * 免得他反复检查自己的 Key 是不是写错了。
 */
function warnIfTextOnlyProvider() {
  const found = detectTextOnlyProvider($('baseUrl').value.trim());
  const note = $('providerNote');
  if (found) {
    note.innerHTML =
      `<b style="color:var(--err)">${found.name} 不支持语音识别。</b>` +
      `${found.hint}请改用有音频转录接口的服务。`;
    return true;
  }
  applyProviderPreset($('provider').value, { overwriteUrl: false });
  return false;
}

/**
 * 申请访问识别服务所需的 host permission。
 * 必须由用户点击触发（chrome.permissions.request 的硬性要求），
 * 所以这个函数只在按钮回调里调用。
 */
async function requestOriginPermission(url) {
  let pattern;
  let broad;
  try {
    pattern = permissionPatternFor(url);
    broad = `${new URL(url).origin}/*`;
  } catch (err) {
    setStatus('接口地址不是合法的网址。', 'err');
    return false;
  }
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  if (await chrome.permissions.contains({ origins: [broad] })) return true;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch (err) {
    setStatus(`授权失败：${(err && err.message) || err}`, 'err');
    return false;
  }
}

function fillProviderOptions() {
  const select = $('provider');
  select.innerHTML = '';
  for (const [key, preset] of Object.entries(PROVIDERS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

function applyProviderPreset(key, { overwriteUrl = true } = {}) {
  const preset = PROVIDERS[key];
  if (!preset) return;
  if (overwriteUrl) {
    $('baseUrl').value = preset.baseUrl || '';
    $('model').value = preset.model || '';
    if (preset.apiStyle) {
      currentApiStyle = preset.apiStyle;
      $('apiStyle').value = preset.apiStyle;
    }
  }
  $('providerNote').innerHTML =
    preset.note + (preset.needsKey ? '' : ' <b>这个方案下 API Key 可以留空。</b>');
  if (!preset.needsKey) $('apiKey').value = '';
  updateKeyHint(key);
  updateEndpointHint();
}

/**
 * 把“这次请求到底会发到哪个地址”写出来。
 *
 * 存在的理由：填了 baseUrl 不等于发对了地址——少一个 /v1、或者协议选错
 * 导致端点名不对，都会得到一个干净的 404/400。把最终地址显示出来，
 * 用户和自己填的一对照，问题立刻可见，不用去猜。
 */
function updateEndpointHint() {
  const el = $('endpointHint');
  const baseUrl = $('baseUrl').value.trim();
  if (!baseUrl) {
    el.textContent = '';
    return;
  }
  const endpoint = resolveEndpointUrl(baseUrl, currentApiStyle);
  const isChat = currentApiStyle === 'chat';
  el.innerHTML =
    `实际请求地址：<code>${endpoint}</code><br />` +
    (isChat
      ? '音频会以 data URI 形式放进 messages 里发送。'
      : '音频会以 multipart 表单上传。');
}

/**
 * 把“API Key 该不该填、去哪里拿”说在当前这一步。
 *
 * 之前这里的占位文字写死了“留空表示由本地中继持有”，
 * 只对走中继的人成立，反而会让用云端服务的人以为自己不该填 Key。
 */
function updateKeyHint(providerKey) {
  const preset = PROVIDERS[providerKey] || {};
  const el = $('keyHint');
  if (providerKey === 'localWhisper') {
    el.innerHTML =
      '<b>不用填 Key</b>：模型跑在你自己电脑上。' +
      '请先在另一个窗口启动服务：<br>' +
      '<code>python tools/local-asr/server.py</code><br>' +
      '首次启动会自动下载模型（约 460MB）；' +
      '想先确认环境是否就绪可以跑 <code>--selftest</code>。';
    return;
  }
  if (preset.needsKey === false) {
    el.innerHTML =
      '这个方案<b>不用填 Key</b>：Key 放在你自己电脑的 ' +
      '<code>tools/server/relay.config.json</code> 里，浏览器扩展这边不保存任何密钥。';
    return;
  }
  if (providerKey === 'siliconflow' || providerKey === 'siliconflowQwenAsr' || providerKey === 'siliconflowXingchen') {
    el.innerHTML =
      '在 <a href="https://cloud.siliconflow.cn/account/ak" target="_blank" rel="noreferrer">' +
      '硅基流动控制台 → API 密钥</a> 创建后，把形如 <code>sk-xxxx</code> 的一整串粘贴到上面这个框里。' +
      '这些语音识别模型目前标价免费。填完点下面的“测试连接”验证。';
    return;
  }
  if (providerKey === 'bailianQwenAsr' || providerKey === 'bailianFunAsr') {
    el.innerHTML =
      '在 <a href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">' +
      '阿里云百炼控制台</a> 开通后，到「API-KEY」页面创建一个 <code>sk-</code> 开头的 Key 粘贴到这里。' +
      '注意百炼的地址是 <code>…/compatible-mode/v1</code>，与普通 OpenAI 兼容地址不同。' +
      '新账号通常有 10 小时语音识别免费额度。';
    return;
  }
  if (providerKey === 'openai') {
    el.innerHTML =
      '在 <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">' +
      'OpenAI 平台 → API keys</a> 创建后粘贴到这里（<code>sk-</code> 开头）。需要能访问 api.openai.com。';
    return;
  }
  el.innerHTML =
    '粘贴你的服务商提供的 Key。填好后点下面的“测试连接”，成功再点“保存设置”。';
}

/** 采集方式的说明文案：让用户明白什么时候该换另一个选项。 */
const CAPTURE_HINTS = {
  auto:
    '默认先用视频元素（只含这个视频的声音，最精准）。' +
    '如果这个播放器的音频读不出来，插件会自动改成抓取整个标签页的声音。',
  element:
    '只读视频元素的声音。若播放器是自绘/MSE 实现，可能录不到数据——' +
    '这时请改成“自动”或“抓取整个标签页声音”。',
  tab:
    '直接抓整个标签页正在播放的声音，兼容性最好，' +
    '代价是录进来的还包括该标签页的其他声音（例如提示音）。' +
    '注意：抓取期间请保持这个标签页在播放。'
};

function updateCaptureHint() {
  const mode = $('captureMode').value;
  $('captureHint').textContent = CAPTURE_HINTS[mode] || '';
}

function render(settings) {
  current = settings;
  $('provider').value = settings.provider;
  $('baseUrl').value = settings.baseUrl;
  $('model').value = settings.model;
  currentApiStyle = settings.apiStyle || DEFAULT_SETTINGS.apiStyle;
  $('apiStyle').value = currentApiStyle;
  $('apiKey').value = settings.apiKey;
  $('language').value = settings.language;
  $('captureMode').value = settings.captureMode;
  updateCaptureHint();
  $('chunkSeconds').value = settings.chunkSeconds;
  $('chunkValue').textContent = settings.chunkSeconds + 's';
  $('streaming').checked = settings.streaming;
  $('streamSliceSeconds').value = settings.streamSliceSeconds;
  $('sliceValue').textContent = settings.streamSliceSeconds + 's';
  $('fontSize').value = settings.fontSize;
  $('fontValue').textContent = settings.fontSize + 'px';
  $('bottomPercent').value = settings.bottomPercent;
  $('bottomValue').textContent = settings.bottomPercent + '%';
  $('captionOpacity').value = settings.captionOpacity;
  $('opacityValue').textContent = settings.captionOpacity + '%';
  $('typewriter').checked = settings.typewriter;
  $('panelPosition').value = settings.panelPosition;
  $('panelCollapsed').checked = settings.panelCollapsed;
  $('splitLongLines').checked = settings.splitLongLines;
  $('showFloatingButton').checked = settings.showFloatingButton;
  $('enableCache').checked = settings.enableCache;
  $('debug').checked = settings.debug;
  applyProviderPreset(settings.provider, { overwriteUrl: false });
}

function collect() {
  return normalizeSettings({
    provider: $('provider').value,
    baseUrl: $('baseUrl').value,
    model: $('model').value,
    apiKey: $('apiKey').value,
    apiStyle: currentApiStyle,
    language: $('language').value,
    captureMode: $('captureMode').value,
    chunkSeconds: Number($('chunkSeconds').value),
    overlapSeconds: current ? current.overlapSeconds : DEFAULT_SETTINGS.overlapSeconds,
    streaming: $('streaming').checked,
    streamSliceSeconds: Number($('streamSliceSeconds').value),
    streamOverlapSeconds: current ? current.streamOverlapSeconds : DEFAULT_SETTINGS.streamOverlapSeconds,
    fontSize: Number($('fontSize').value),
    bottomPercent: Number($('bottomPercent').value),
    captionOpacity: Number($('captionOpacity').value),
    typewriter: $('typewriter').checked,
    panelPosition: $('panelPosition').value,
    panelCollapsed: $('panelCollapsed').checked,
    splitLongLines: $('splitLongLines').checked,
    showFloatingButton: $('showFloatingButton').checked,
    enableCache: $('enableCache').checked,
    debug: $('debug').checked
  });
}

function wire() {
  $('provider').addEventListener('change', (event) => {
    applyProviderPreset(event.target.value, { overwriteUrl: true });
    setStatus('已切换到该供应商的默认地址和模型，别忘了点“保存设置”。');
  });

  // 用户手动改地址时，立刻检查是不是填了只有文本模型的服务商
  $('baseUrl').addEventListener('input', () => {
    warnIfTextOnlyProvider();
    updateEndpointHint();
  });
  $('baseUrl').addEventListener('blur', () => {
    warnIfTextOnlyProvider();
    updateEndpointHint();
  });
  $('apiStyle').addEventListener('change', (event) => {
    currentApiStyle = event.target.value;
    updateEndpointHint();
  });
  $('captureMode').addEventListener('change', updateCaptureHint);

  $('chunkSeconds').addEventListener('input', (event) => {
    $('chunkValue').textContent = event.target.value + 's';
  });
  $('streamSliceSeconds').addEventListener('input', (event) => {
    $('sliceValue').textContent = Number(event.target.value).toFixed(1) + 's';
  });
  $('fontSize').addEventListener('input', (event) => {
    $('fontValue').textContent = event.target.value + 'px';
  });
  $('bottomPercent').addEventListener('input', (event) => {
    $('bottomValue').textContent = event.target.value + '%';
  });
  $('captionOpacity').addEventListener('input', (event) => {
    $('opacityValue').textContent = event.target.value + '%';
  });

  $('save').addEventListener('click', async () => {
    const next = collect();
    if (!next.baseUrl) {
      setStatus('请先填写接口地址。', 'err');
      return;
    }
    await saveSettings(next);
    current = next;
    /* 这里必须明确要求刷新视频页面。
     * 内容脚本只在页面加载时注入，已打开的页面里跑的还是旧的那一份；
     * 用户改了设置却觉得“没生效”，绝大多数情况就是这个原因。 */
    setStatus('已保存。\n请刷新视频页面（F5）让新设置生效，然后点悬浮按钮开启字幕。', 'ok');
  });

  $('test').addEventListener('click', async () => {
    const next = collect();
    if (!next.baseUrl) {
      setStatus('请先填写接口地址。', 'err');
      return;
    }
    setStatus('正在测试…（会先请求域名授权）');
    try {
      const granted = await requestOriginPermission(next.baseUrl);
      if (!granted) {
        setStatus('未获得域名授权，无法访问该服务。', 'err');
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: 'zimu:test-connection', settings: next });
      if (response && response.ok) {
        setStatus(`连接成功，延迟约 ${response.latencyMs}ms。服务返回：${response.text || '（空文本，属正常）'}`, 'ok');
      } else {
        setStatus(`连接失败：${(response && response.error) || '未知错误'}`, 'err');
      }
    } catch (err) {
      setStatus(`测试出错：${(err && err.message) || err}`, 'err');
    }
  });

  $('grant').addEventListener('click', async () => {
    const url = $('baseUrl').value;
    if (!url) {
      setStatus('请先填写接口地址。', 'err');
      return;
    }
    try {
      const granted = await requestOriginPermission(url);
      setStatus(granted ? '已获得该域名的访问授权。' : '授权被拒绝。', granted ? 'ok' : 'err');
    } catch (err) {
      setStatus(`授权失败：${(err && err.message) || err}`, 'err');
    }
  });

  $('clearCache').addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'zimu:clear-cache' });
    setStatus(response && response.ok ? '识别缓存已清除。' : '清除失败。', response && response.ok ? 'ok' : 'err');
  });

  /* 手动唤出面板。这是自动探测失败时的兜底入口：
   * 内容脚本在页面上找不到 video、或页面结构特殊时，悬浮球可能不出现，
   * 这时用户可以从插件图标主动唤出，而不是只能干等。 */
  $('showOverlay').addEventListener('click', async () => {
    setStatus('正在唤出面板…');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || typeof tab.id !== 'number') {
        setStatus('找不到当前标签页。', 'err');
        return;
      }
      const response = await chrome.runtime.sendMessage({
        type: 'zimu:ping-content',
        tabId: tab.id,
        command: 'retryAttach'
      });

      if (!response || !response.ok) {
        setStatus(`唤出失败：${(response && response.error) || '未知错误'}`, 'err');
        return;
      }

      const result = response.response && response.response.result;
      if (result && result.attached) {
        setStatus('已唤出面板。回到视频页面查看（默认在右下角，可在上面改）。', 'ok');
        return;
      }
      // 没挂上时把原因说清楚，别让用户以为插件坏了
      const state = result && result.status;
      if (state && !state.videoFound) {
        setStatus(
          '面板没能挂上：这个页面里没找到视频元素。\n' +
            '请先把视频播放起来，再点一次这个按钮。若播放中仍找不到，' +
            '可以用 F12 在 Console 里输入 __ZIMU__.inspect() 查看详情。',
          'warn'
        );
      } else {
        setStatus(`面板没能挂上：${(result && result.error) || '原因未知'}`, 'warn');
      }
    } catch (err) {
      setStatus(`唤出失败：${(err && err.message) || err}`, 'err');
    }
  });
}

async function init() {
  fillProviderOptions();
  wire();
  const settings = await loadSettings();
  render(settings);

  const stored = await chrome.storage.session.get('installHint').catch(() => ({}));
  if (stored && stored.installHint) {
    setStatus('第一次使用：先选好供应商并填好地址与 Key，点“测试连接”验证，再点“保存设置”。', 'warn');
    await chrome.storage.session.remove('installHint').catch(() => {});
  }
}

init().catch((err) => setStatus(`初始化失败：${(err && err.message) || err}`, 'err'));
