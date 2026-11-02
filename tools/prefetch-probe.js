/**
 * 预转写可行性诊断 —— 整段复制到视频页面的 Console 里回车执行。
 *
 * 要回答的问题只有一个：**这个页面的视频，能不能整段拿到音频？**
 *
 * 为什么要问这个：现在的方案是「边播边录、录一段识别一段」，
 * 所以延迟 ≈ 分块秒数 + 识别耗时，这是架构决定的，再怎么调参也有下限。
 * 如果能把整段音频先拿下来、提前转写成带时间戳的字幕，
 * 播放时只是"查表显示"——延迟就归零了。
 *
 * 三种结果对应三条路：
 *   容易 —— 直接是 mp4/webm 这类整段文件：可以下载、可以解码，直接做。
 *   要费点劲 —— 是 HLS(m3u8)/DASH 分片：得按清单把分片拉下来再拼接。
 *   走不通 —— DRM 加密、直播流、或音频由页面实时合成：只能继续用现在的实时方案。
 *
 * 用法：F12 → Console → 粘贴 → 回车。然后把输出整段发回。
 */

(async () => {
  const log = (...args) => console.log('%c[预转写诊断]', 'color:#0a7;font-weight:bold', ...args);
  const warn = (...args) => console.warn('%c[预转写诊断]', 'color:#c80;font-weight:bold', ...args);

  log('=== 1. 页面里的媒体元素 ===');
  const videos = [...document.querySelectorAll('video')];
  const audios = [...document.querySelectorAll('audio')];
  log(`video ${videos.length} 个，audio ${audios.length} 个`);

  const media = videos[0] || audios[0];
  if (!media) {
    warn('页面上没有找到 <video>/<audio>，这条路走不通（可能是 canvas 渲染或 iframe 里的播放器）。');
    return;
  }

  const src = media.currentSrc || media.src || '';
  const sources = [...media.querySelectorAll('source')].map((s) => s.src);
  log('当前源：', src);
  if (sources.length) log('source 备用源：', sources);
  log('时长：', Number.isFinite(media.duration) ? `${media.duration.toFixed(1)}s` : '未知（直播或尚未加载）');
  log('crossOrigin 属性：', media.crossOrigin || '(未设置)');
  log('currentTime / paused：', media.currentTime, media.paused);

  log('=== 2. 页面加载过的媒体请求（找 m3u8 / mp4 / ts） ===');
  const entries = performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((u) => /\.(m3u8|mpd|mp4|m4s|ts|webm|m4a|mp3|aac)(\?|$)/i.test(u));
  if (!entries.length) {
    log('没找到明显的媒体请求（可能被 iframe 隔离，或用了 blob:）');
  } else {
    for (const u of entries.slice(0, 15)) log('  ', u);
    if (entries.length > 15) log(`   … 另有 ${entries.length - 15} 条`);
  }

  if (src.startsWith('blob:')) {
    warn('当前源是 blob: —— 说明播放器用了 MSE（分片喂给播放器），整段文件拿不到。');
    warn('这种情况要看上面的资源列表里有没有 m3u8/mpd：有的话就把清单拉下来自己拼。');
  }

  log('=== 3. 尝试整段下载 ===');
  if (!src) {
    warn('没有可下载的 URL。');
    return;
  }

  let bytes = null;
  let contentType = '';
  try {
    const started = performance.now();
    const response = await fetch(src, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
    contentType = response.headers.get('content-type') || '(未提供)';
    const ms = Math.round(performance.now() - started);
    log(`下载成功 ✅ ${(bytes.byteLength / 1048576).toFixed(2)} MB，耗时 ${ms}ms`);
    log('content-type：', contentType);
    if (/mpegurl|dash\+xml/i.test(contentType) || /\.(m3u8|mpd)(\?|$)/i.test(src)) {
      warn('这其实是一份**播放清单**，不是音频本体。要走 HLS/DASH 拼接那条路。');
    }
  } catch (err) {
    warn('整段下载失败 ❌', err.message);
    warn('注意：页面上下文的 fetch 受同源策略限制，**失败不等于扩展做不到**——');
    warn('扩展的 background 带 host 权限，可以绕过 CORS。这里失败只说明需要在扩展里做。');
    return;
  }

  log('=== 4. 尝试解码成音频 ===');
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    // 只解前 4MB：足够判断“能不能解”，又不会把页面卡死
    const head = bytes.slice(0, Math.min(bytes.byteLength, 4 * 1024 * 1024));
    const audio = await ctx.decodeAudioData(head);
    log(`解码成功 ✅ 时长 ${audio.duration.toFixed(1)}s，声道 ${audio.numberOfChannels}，采样率 ${audio.sampleRate}`);
    const fullSec = Number.isFinite(media.duration) ? media.duration : audio.duration;
    log(`按此推算，整段音频约 ${(fullSec / 60).toFixed(1)} 分钟。`);
    log('本地 Whisper(small) 实测约 3.5 倍实时 → 预计转写需 ' + `${(fullSec / 3.5 / 60).toFixed(1)} 分钟。`);
    log('');
    log('%c结论：可以走「预转写」这条路 ✅', 'color:#0a7;font-weight:bold');
  } catch (err) {
    warn('整体解码失败 ❌', err.message);
    warn('常见原因：HLS 分片(TS)、或编码不被 decodeAudioData 直接支持。');
    warn('不代表走不通——分片拼接后通常可以解码，只是要多写一段。');
  }
})();
