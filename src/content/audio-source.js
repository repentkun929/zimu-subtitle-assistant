/**
 * 音频来源选择：优先用页面里的视频元素，不行就退回抓整个标签页的声音。
 *
 * 为什么要两条路：
 *
 * 【元素模式】用 video.captureStream() 拿这个视频的声音。优点是精准
 *   （只要这个视频的声音，不含页面其他音效）。但有些播放器——尤其是用
 *   MSE/blob 自己喂数据、或者音频走了 Web Audio 的实现——虽然音轨报告
 *   live，却流不出可编码的数据，表现为 MediaRecorder 录出 0 字节。
 *   用户实际用的教学平台就是这类。
 *
 * 【标签页模式】用 chrome.tabCapture 抓整个标签页正在播放的声音。
 *   它是浏览器层面的音频输出捕获，不依赖页面里播放器怎么实现，
 *   因此这类"读不到"的问题它能绕过去。代价是录进来的声音包含
 *   该标签页的所有声音（对看网课来说没有影响）。
 *
 * 选择顺序由设置项 captureMode 决定：auto（先试元素）／element／tab。
 */
(function () {
  const NS = (globalThis.__ZIMU__ = globalThis.__ZIMU__ || {});

  class AudioSourceError extends Error {
    constructor(message, { mode = '', detail = '' } = {}) {
      super(message);
      this.name = 'AudioSourceError';
      this.mode = mode;
      this.detail = detail;
    }
  }

  /**
   * 从元素流里**只取音频轨**，丢掉视频轨。
   *
   * 这是本项目最严重的一个 bug，务必理解为什么必须这么做：
   *
   * video.captureStream() 不带参数时返回的流**同时包含视频轨和音频轨**。
   * 如果把这个流整个交给 MediaRecorder，它会把**画面一起录下来**——
   * 于是 12 秒的块变成 1.4MB~3.4MB（相当于 2.3Mbps），而纯 Opus 音频
   * 12 秒只有约 96KB。
   *
   * 后果不只是浪费流量：语音识别服务拿到一个带视频轨的 WebM，
   * 解不出音轨，就**返回空文本**。用户看到的现象正是“采集一切正常、
   * 上传成功、但识别结果全是空”。
   *
   * 所以这里必须新建一个只含音频轨的 MediaStream。
   */
  function audioOnlyStream(stream) {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return stream;
    const videoTracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
    if (!videoTracks.length) return stream;
    return new MediaStream(audioTracks);
  }

  /**
   * 申请抓取当前标签页的声音。
   *
   * 流程上必须绕一圈：内容脚本不能直接调 tabCapture（它需要扩展 API），
   * 所以让 background 取到 streamId，再由内容脚本把它交给 getUserMedia。
   * 这样拿到的 MediaStream 是浏览器生成的，具备完整的音频数据。
   */
  async function acquireTabStream(sendToBackground, options = {}) {
    const releasePrevious = options.releasePrevious;
    const log = options.log || (() => {});

    // 重新申请之前先释放上一次的抓取，否则 Chrome 会拒绝
    if (typeof releasePrevious === 'function') {
      try {
        await releasePrevious();
      } catch (err) {
        log('释放上一次标签页抓取失败（继续尝试）', err);
      }
    }

    let response = await sendToBackground({ type: 'zimu:acquire-tab-stream' });

    /* “Cannot capture a tab with an active stream” 是 Chrome 的时序问题：
     * 上一次抓取的流可能还没完全释放。这种情况等一会儿重试一次通常就好了，
     * 直接报错给用户看是很差的体验。 */
    if (!response || !response.ok) {
      const text = String((response && response.error) || '');
      if (/active stream|starting tab capture/i.test(text)) {
        log('标签页抓取被上一次的流占用，等待后重试');
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (typeof releasePrevious === 'function') await releasePrevious().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 400));
        response = await sendToBackground({ type: 'zimu:acquire-tab-stream' });
      }
    }

    if (!response || !response.ok || !response.streamId) {
      throw new AudioSourceError(
        `无法抓取标签页声音：${(response && response.error) || '扩展未返回 streamId'}`,
        { mode: 'tab' }
      );
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new AudioSourceError(
        '当前页面不允许访问媒体设备（需要 https 或 localhost）。请改用元素模式，或用 https 打开该平台。',
        { mode: 'tab' }
      );
    }

    try {
      // 扩展专用的约束写法：chromeMediaSource 指定为 tab
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: response.streamId
          }
        },
        video: false
      });
    } catch (err) {
      throw new AudioSourceError(
        `抓取标签页声音被拒绝：${(err && err.message) || err}。` +
          '注意：抓取标签页声音要求当前标签页是正在播放声音的那个标签页。',
        { mode: 'tab', detail: String((err && err.name) || '') }
      );
    }
  }

  /**
   * 按设置选择音频来源。
   *
   * @param {HTMLMediaElement} media
   * @param {{captureMode: string, sendToBackground: Function, log: Function}} options
   * @returns {Promise<{stream: MediaStream, mode: string, note: string}>}
   */
  async function acquireStream(media, options) {
    const log = options.log || (() => {});
    const mode = options.captureMode || 'auto';
    const tabOptions = { releasePrevious: options.releasePrevious, log };

    if (mode === 'tab') {
      const stream = await acquireTabStream(options.sendToBackground, tabOptions);
      log('按设置使用标签页模式采集');
      return { stream, mode: 'tab', note: '正在抓取整个标签页的声音' };
    }

    // 元素模式（或 auto 的第一顺位）
    let elementError = null;
    if (media && typeof media.captureStream === 'function') {
      try {
        const raw = media.captureStream();
        const tracks = raw.getAudioTracks();
        if (tracks.length) {
          const stream = audioOnlyStream(raw);
          const dropped = raw.getVideoTracks ? raw.getVideoTracks().length : 0;
          log(
            `使用元素模式采集（video.captureStream）` +
              (dropped ? `，已丢弃 ${dropped} 条视频轨（否则会把画面一起录进去）` : '')
          );
          return { stream, mode: 'element', note: '' };
        }
        elementError = new AudioSourceError('视频流里没有音轨', { mode: 'element' });
      } catch (err) {
        elementError = new AudioSourceError(`无法采集该视频的音频：${(err && err.message) || err}`, {
          mode: 'element'
        });
      }
    } else {
      elementError = new AudioSourceError('当前浏览器不支持 captureStream()', { mode: 'element' });
    }

    if (mode === 'element') throw elementError;

    // auto：元素模式失败就退到标签页模式
    log('元素模式不可用，改用标签页模式：', elementError.message);
    const stream = await acquireTabStream(options.sendToBackground, tabOptions);
    return {
      stream,
      mode: 'tab',
      note: '已自动切换为抓取整个标签页的声音（页面里的视频音频读不到）'
    };
  }

  NS.AudioSourceError = AudioSourceError;
  NS.acquireStream = acquireStream;
  NS.acquireTabStream = acquireTabStream;
  NS.audioOnlyStream = audioOnlyStream;
})();
