/**
 * 内容脚本主控：探测页面里的视频、启停字幕、把识别结果渲染到叠加层。
 *
 * 注意：这是普通脚本（不是 ES module），依赖 capture.js / overlay.js
 * 先执行并把类挂到 window.__ZIMU__ 上，所以 manifest 里的顺序不能调换。
 */
(function () {
  const NS = (globalThis.__ZIMU__ = globalThis.__ZIMU__ || {});
  if (NS.controller) return; // 防止被重复注入

  const LOG_PREFIX = '[字幕助手]';

  /**
   * 识别服务是不是跑在本机。
   *
   * 规则本身在 `common/settings.js` 的 isLocalRelayUrl 里，打包时会被内联进来
   * （见 tools/build.mjs 的 CLASSIC_INLINE_MODULES），这里只用命名空间引用，
   * 绝不另写一份——两份实现迟早会跑偏，而“算错了”的后果是流式被误开或误关。
   *
   * 内联缺失时返回 false：宁可退回分块模式（功能完好、只是延迟高些），
   * 也不要因为判断不了而把流式发给云端（云端没有 /audio/stream，必然失败）。
   * 后台还会再判定一次，这里只是**提前**把结论拿到，省掉一片白发的音频。
   */
  function isLocalService(baseUrl) {
    if (typeof NS.isLocalRelayUrl !== 'function') return false;
    return NS.isLocalRelayUrl(baseUrl);
  }

  class Controller {
    constructor() {
      this.video = null;
      this.capturer = null;
      this.track = null;
      this.overlay = null;
      this.settings = null;
      /** 上次读取配置失败的原因；用来区分“读不到”和“真的没配” */
      this.settingsError = null;
      this.running = false;
      this.pending = 0;
      this.loudnessChecked = false;
      this.lastShownText = '';
      /** 上一帧显示的是不是“还没放完”的半截文字，参与去重判断 */
      this.lastShownPartial = false;
      /**
       * 逐字显示的进度状态。
       *
       * { full, shown, anchor, span, done, doneAtMs }
       * 参见 typewriterSlice()——为什么按音频时长而不是到达时间，那里有完整解释。
       */
      this.reveal = null;
      /** 句子打完后再停留多久就消失（毫秒）。用户要的节奏是"一句打完就换下一句" */
      this.captionLingerMs = 1500;
      /** 已经打完并清掉的那句，避免下一帧又把它捞回来重打一遍 */
      this.retiredText = null;
      /** 逐字显示是否开启（最终以设置里的值为准，start() 时同步一次） */
      this.typewriterEnabled = true;
      this.currentSegment = null;
      this.silentChunkStreak = 0;
      this.errors = 0;
      this.videoKey = '';
      /**
       * 分块统计。用途很实际：用户看到“共生成 0 条字幕”时，光看这个数字
       * 无法判断卡在哪一环——是没采到音频、还是采到了但被静音判定跳过、
       * 还是识别服务返回了空文本。把这几个数分开记，停止时一并报出来，
       * 问题就能自我定位。
       */
      this.stats = { captured: 0, empty: 0, silent: 0, uploaded: 0, emptyText: 0, failed: 0, sparse: 0, recognizeMs: 0, recognizeCount: 0 };
      /** 是否已经因为“元素模式录不出数据”而自动切换过一次，避免死循环 */
      this.tabFallbackTried = false;
      /**
       * 流式识别的会话标识。
       *
       * 服务端按它维护一段「尚未定稿」的音频缓冲，所以它的生命周期必须和
       * 「一段连续播放的音频」严格对应：开始识别时新建，拖动进度、切集时作废。
       * 否则新位置的音频会被接进旧位置的缓冲里，定稿出来的时间戳整体错位。
       */
      this.streamSession = null;
      /** 流式模式是否真的在用（服务端不支持或连续失败时会自动降级） */
      this.streamActive = false;
      /** 流式模式的计数器，用于停止时报告 */
      this.streamStats = { slices: 0, segments: 0, failed: 0, avgDecodeMs: 0 };
      /**
       * 追赶队列：识别落后于播放时，那些“回来时已经播过去了”的字幕段。
       *
       * 为什么必须有它：识别一旦落后，一整块的字幕都落在当前播放位置之前，
       * `segmentAt()` 一条也命中不了。此时渲染层只能退到
       * `lastSegmentBefore()`——也就是**该块的最后一句**。同一块里的前几句、
       * 以及落后期间回来的那几块，永远没有机会上屏。用户的原话是
       * “中间的那段字幕直接不显示”“视频里的语言没有被完整表达出来”。
       *
       * 所以这里把迟到的段收进队列，由渲染层按人能读的节奏逐条补出来。
       */
      this.catchUpQueue = [];
      /** 下一条补显字幕最早可以出现的时间（Date.now()），控制补显节奏 */
      this.catchUpNextAt = 0;
      /**
       * 正在补显的那一条字幕。
       *
       * 之所以要单独存一份：补显的**换条**有节流（下面 dwell），
       * 但这条字幕的**逐字进度**必须每一帧都继续推进——两者是一件事，
       * 不能因为"还没到下一条"就把正在打的这句话也冻住。
       */
      this.catchUpItem = null;
      /** 补显期间这条字幕被压缩到的放字时长（秒） */
      this.catchUpItemSpan = 0;
      /**
       * 补显时每条的停留时长按**这条字幕原本的时长**来，并夹在上下限之间。
       *
       * 取自然时长的理由：这样字幕和音频保持一个固定的偏移量，而不是越拖越远；
       * 只落后一小截时，看起来就和正常同步字幕一样。
       * 下限保证再短也来得及读，上限保证严重落后时还能慢慢追上。
       */
      this.catchUpMinDwellMs = 700;
      this.catchUpMaxDwellMs = 2200;
      /**
       * 屏幕字幕允许的最大落后量（秒）。实际值在 start() 里按分块时长算。
       *
       * 超过它就不再逐条补显，直接跳到最新内容——见 renderFrame 的 ② 。
       */
      this.maxLagSeconds = 6;
      /** 队列上限，防止长时间落后把内存撑爆（超出的会在 SRT 里保留） */
      this.catchUpQueueLimit = 240;
      /** 当前是否在使用标签页采集（用于停止时通知离屏文档收尾） */
      this.usedTabCapture = false;
      /**
       * 会话级的采集方式覆盖（例如自动降级到标签页模式）。
       * 只在本次“开启字幕”期间有效，不改用户设置；每次手动开启时清空。
       */
      this.sessionCaptureMode = null;
      this.boundOnSeeked = () => this.onTimelineJump();
      this.boundOnLoadedMeta = () => this.onTimelineJump();
      this.boundOnEnded = () => this.stop('视频播放结束');
      this.boundOnPlay = () => this.onPlaybackToggle();
      this.boundOnPause = () => this.onPlaybackToggle();
    }

    log(...args) {
      // 调试日志由用户开关控制（每块的时间、大小等细节）
      if (this.settings && this.settings.debug) console.log(LOG_PREFIX, ...args);
    }

    /**
     * 关键信息：无论是否开调试都打印。
     *
     * 理由：采集类故障（读不到音频、格式被拒）在用户看来只是“没反应”，
     * 而要求用户先去开调试开关、再复现一次，排查成本很高。
     * 所以把少量真正关键的信息——每块的音频大小、识别结果、失败原因——
     * 默认打出来，出问题时 F12 就能看到全貌。
     */
    info(...args) {
      console.info(LOG_PREFIX, ...args);
    }

    /** 页面里可能有多个 video（广告、预览、背景视频），挑最大且可见的那个。 */
    findVideo() {
      const videos = Array.from(document.querySelectorAll('video'));
      let best = null;
      let bestArea = 0;
      for (const video of videos) {
        if (video.readyState === 0 && !video.currentSrc && !video.src) continue;
        const rect = video.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area > bestArea) {
          bestArea = area;
          best = video;
        }
      }
      if (best && bestArea >= 40000) return best;
      return best || videos[0] || null;
    }

    /**
     * 读取插件配置。
     *
     * 这里踩过一个坑：原来不管成功失败都写 this.settings = response.settings || {}。
     * 扩展被刷新后（用户点了 chrome://extensions 的刷新按钮），本页面的脚本
     * 已经和扩展失去联系，读配置必然失败，于是 this.settings 被缓存成 {}；
     * 之后再点“开启字幕”会一直命中这个空缓存，报出“还没配置识别服务”——
     * 而用户明明填好了，这会把人误导到完全错误的方向。
     *
     * 现在的规则：只在真正读到时才缓存；读取失败保留原值并如实报告原因。
     */
    async ensureSettings(force) {
      if (this.settings && !force) return this.settings;
      const response = await this.send({ type: 'zimu:get-public-settings' });

      if (!response || !response.ok || !response.settings) {
        this.settingsError = (response && response.error) || '读取配置失败';
        this.log('读取配置失败：', this.settingsError);
        return this.settings || null;
      }

      this.settingsError = null;
      this.settings = response.settings;
      return this.settings;
    }

    /** 本页面的脚本是否还和扩展连着。扩展被刷新后这里会变成 false。 */
    isExtensionAlive() {
      try {
        return Boolean(chrome.runtime && chrome.runtime.id);
      } catch (err) {
        return false;
      }
    }

    /** 和 background 通信，顺手处理“扩展被重载”这类上下文失效。 */
    async send(message, transfer) {
      // 上下文已失效时直接返回，避免抛出一堆看不懂的原生报错
      if (!this.isExtensionAlive()) {
        this.handleContextLost();
        return { ok: false, error: '扩展上下文已失效，请刷新本页面' };
      }
      try {
        const response = await chrome.runtime.sendMessage(message, transfer);
        return response;
      } catch (err) {
        const text = String((err && err.message) || err);
        if (text.includes('Extension context invalidated') || text.includes('Receiving end does not exist')) {
          this.handleContextLost();
          return { ok: false, error: '扩展上下文已失效，请刷新本页面' };
        }
        throw err;
      }
    }

    /** 扩展被刷新/重载：把情况说清楚，并保证悬浮按钮不会因此消失。 */
    handleContextLost() {
      if (this.running) this.stop('扩展重载');
      // 先把悬浮球保住，再给用户明确的下一步
      this.attachOverlay();
      this.overlay?.setState('error');
      this.overlay?.setStatus('扩展刚被更新过，本页面还在用旧版本。按 F5 刷新页面即可继续。', 'warn');
      this.overlay?.toast('请刷新页面（F5）：扩展更新后已打开的页面需要重新加载才能继续。', 15000);
    }

    /**
     * 屏幕字幕允许的最大落后量（秒）——**病理兜底**，不是日常阈值。
     *
     * 2026-10 抬高过一次。原来的取值是「一个分块时长」，理由是"落后不超过
     * 再来一块就能补上的范围"。加了逐字显示之后这条不再成立：
     *
     *   屏幕上的内容本来就比话音晚「识别延迟 + 最多一个分块」，
     *   6 秒分块 + 5 秒识别延迟 = 常态就 11 秒左右——**这是上游的延迟，
     *   不是"我们没跟上"**。而旧阈值恰好卡在这个常态值上，于是它每几秒就触发一次
     *   "跳过历史、直接对齐最新"，把**正在逐字打的那句拦腰截断**，
     *   屏幕上表现为"一句话打到一半忽然跳到下一句"。这条是仿真跑出来的。
     *
     * 现在改成：只有落后到"再来好几块也补不上"时才认为是真出问题。
     * 日常的追赶交给补显通道的加速打字（见 drainCatchUpQueue），它会自我纠正。
     */
    computeMaxLagSeconds() {
      const chunkSeconds = (this.settings && this.settings.chunkSeconds) || 6;
      return Math.max(20, chunkSeconds * 2 + 8);
    }

    /**
     * 本次会话该不该走流式识别。
     *
     * 两个条件是“与”的关系：
     *  1. 用户打开了流式开关；
     *  2. 识别服务在本机。
     *
     * 第 2 条不能省，也不能推迟到“被后台拒了再回滚”：流式用的是 1~2 秒的小切片，
     * 采集窗口的长度必须在**开始录音之前**就定下来。若先按 1.6s 录几秒、
     * 等后台回一句“不支持流式”再改，那几秒音频既没进分块队列、也没进字幕轨，
     * 白白丢掉。云端既没有 /audio/stream 端点，也会因为反复解码而多花钱，
     * 所以这里直接判否。
     */
    shouldUseStreaming() {
      if (!(this.settings && this.settings.streaming)) return false;
      return isLocalService(this.settings.baseUrl);
    }

    /**
     * 确保悬浮按钮存在。可反复调用，是“自愈”的关键。
     *
     * 为什么必须自愈：悬浮球消失过一次就再也回不来，用户会以为插件坏了。
     * 实际情况可能是页面把我们的节点删了、或者重建时旧的已经脱离文档。
     * 所以每次都检查“叠加层是否真的还挂在文档里”，不在就重新建一个。
     */
    attachOverlay() {
      const video = this.video && this.video.isConnected ? this.video : this.findVideo();
      if (!video) return null;
      this.video = video;

      const alive = this.overlay && this.overlay.host && this.overlay.host.isConnected;
      if (!alive) {
        // 旧的可能还在（只是脱离了文档），先彻底清掉再重建，避免留下幽灵节点
        try {
          this.overlay?.destroy();
        } catch (err) {
          /* 忽略清理失败 */
        }
        this.overlay = this.createOverlay();
      }

      this.overlay.attachTo(video);
      this.overlay.setState(this.running ? 'recording' : 'idle');
      return this.overlay;
    }

    createOverlay() {
      const settings = this.settings || {};
      return new NS.Overlay({
        fontSize: settings.fontSize || 22,
        bottomPercent: settings.bottomPercent ?? 6,
        captionOpacity: settings.captionOpacity == null ? 72 : settings.captionOpacity,
        typewriter: settings.typewriter !== false,
        showButton: settings.showFloatingButton !== false,
        panelPosition: settings.panelPosition || 'bottom-right',
        panelCollapsed: settings.panelCollapsed === true,
        onToggle: () => this.toggle(),
        onOpenSettings: () => this.openSettings(),
        onExport: () => this.exportSRT(),
        onCopy: () => this.copyTranscript(),
        onClear: () => this.clearTranscript(),
        onDiagnose: () => this.runDiagnose(),
        onSaveAudio: () => this.saveLastChunk(),
        onFontSize: (px) => this.send({ type: 'zimu:save-settings', patch: { fontSize: px } }),
        onBottomPercent: (percent) =>
          this.send({ type: 'zimu:save-settings', patch: { bottomPercent: percent } }),
        onCaptionOpacity: (percent) =>
          this.send({ type: 'zimu:save-settings', patch: { captionOpacity: percent } }),
        /* 逐字开关同时写回设置：用户在这里关掉之后，刷新页面不该又自己打开。
         * 同时立刻同步本地的开关，免得要等下一次 start() 才生效。 */
        onTypewriter: (on) => {
          this.typewriterEnabled = on !== false;
          this.send({ type: 'zimu:save-settings', patch: { typewriter: on !== false } });
        },
        onCollapse: (collapsed) =>
          this.send({ type: 'zimu:save-settings', patch: { panelCollapsed: collapsed } })
      });
    }

    async toggle() {
      if (this.running) await this.stop('用户手动停止');
      else await this.start();
    }

    /**
     * @param {{keepSessionMode?: boolean}} [options]
     *   keepSessionMode —— 内部重启用（例如自动降级后重来），保留会话级的采集方式覆盖。
     *   用户手动开启时不传，表示这是一次全新会话，回到用户设置。
     */
    async start(options = {}) {
      if (this.running) return;

      if (!options.keepSessionMode) {
        // 手动开启：全新会话，清掉上次的降级决定，回到用户设置
        this.sessionCaptureMode = null;
        this.tabFallbackTried = false;
      }

      // 扩展被刷新过而页面没刷新：这时什么都会失败，干脆把话说明白
      if (!this.isExtensionAlive()) {
        this.handleContextLost();
        return;
      }

      await this.ensureSettings(true);

      const video = this.findVideo();
      if (!video) {
        this.attachOverlay();
        this.notify('这个页面里没找到视频。请先把视频播放起来，再点开启字幕。', 'err');
        return;
      }
      this.video = video;

      /* 区分“读取配置失败”和“真的没配置”。
       * 这两种情况的处理办法完全不同：前者刷新页面，后者去填设置。
       * 混在一起报“还没配置识别服务”，会把用户引到错误的方向。 */
      if (this.settingsError) {
        this.attachOverlay();
        this.overlay?.setStatus(`${this.settingsError}。若是刚更新过扩展，按 F5 刷新本页面即可。`, 'err');
        this.overlay?.toast('读取设置失败，请刷新页面（F5）后重试。', 12000);
        return;
      }

      if (!this.settings || !this.settings.baseUrl) {
        this.attachOverlay();
        this.overlay?.openCard();
        this.notify('还没配置识别服务：点插件图标，选择供应商并填好地址与 API Key。', 'err');
        return;
      }

      // 挂载（必要时重建），再打开面板
      this.attachOverlay();
      this.overlay.openCard();

      /* 预热识别服务：用户实测前几块要 14~23 秒、之后只要 0.3~0.5 秒，
       * 说明慢的是服务端冷启动/排队。这里不等它返回（不阻塞主流程），
       * 让它在后台先把实例热起来，等第一块音频就绪时服务已经是热的。 */
      this.warmUpService();

      this.track = new NS.SubtitleTrack({
        splitLongLines: this.settings.splitLongLines !== false,
        // 短句至少显示一会儿，否则会一闪而过
        minDisplaySeconds: 1.2
      });
      /** 上一次显示字幕时的播放位置，用来识别“进度跳转”造成的空档 */
      this.lastShownTime = null;
      /* 逐字显示与去重状态每次开新会话都归零：上一个视频残留的半截文字
       * 会让新视频的第一条字幕卡在“只显示两个字”的状态。 */
      this.typewriterEnabled = this.settings.typewriter !== false;
      this.reveal = null;
      this.retiredText = null;
      this.lastShownPartial = false;
      this.overlay?.setTypewriter?.(this.typewriterEnabled);
      /** 一条字幕最多保留多久（等下一块返回），由分块时长推算 */
      this.maxLagSeconds = this.computeMaxLagSeconds();
      /* 分块秒数是延迟的第一大杠杆：延迟 ≈ 分块秒数 + 识别耗时。用户如果把它
       * 调到 10 秒以上，字幕必然长期落后十几秒——与其让他在日志里自己推，不如
       * 开启时就把这笔账算给他看。 */
      if (((this.settings && this.settings.chunkSeconds) || 6) >= 10) {
        const cs = this.settings.chunkSeconds;
        const ov = (this.settings && this.settings.overlapSeconds) || 0;
        this.info(
          `⚠ 分块秒数设为 ${cs}s：仅“等一块”就要 ${Math.max(0, cs - ov)}s，加上识别耗时，` +
            `字幕至少落后 ${Math.max(0, cs - ov)}s 以上。想更跟得上，建议改到 4~6s。`
        );
      }
      // 每次开启都是一次新会话，统计清零
      this.stats = { captured: 0, empty: 0, silent: 0, uploaded: 0, emptyText: 0, failed: 0, sparse: 0, recognizeMs: 0, recognizeCount: 0 };
      /* 流式识别的会话从这里开始。真正的“该不该开”由 shouldUseStreaming() 决定，
       * 打开后会由后台再判定一次，并可能通过 fallBackToChunkMode() 回滚。 */
      const streamingOn = Boolean(this.settings && this.settings.streaming);
      const wantStream = this.shouldUseStreaming();
      this.streamSession = wantStream ? newSessionId() : null;
      this.streamActive = wantStream;
      this.streamStats = { slices: 0, segments: 0, failed: 0, avgDecodeMs: 0 };
      if (wantStream) {
        const slice = this.settings.streamSliceSeconds || 1.6;
        const overlap = this.settings.streamOverlapSeconds || 0.4;
        this.info(
          `流式识别已启用：每 ${slice}s 投喂一片（重叠 ${overlap}s），服务端边解码边定稿。` +
            '若本机服务不支持会自动退回分块模式。'
        );
      } else if (streamingOn) {
        this.info(
          '识别服务在云端：流式只对本机服务生效，本次直接按分块模式运行' +
            `（每块 ${(this.settings && this.settings.chunkSeconds) || 6}s）。`
        );
      }
      /** 最近录到的一块音频，供面板上的“保存最近一段音频”导出 */
      this.lastChunk = null;
      this.videoKey = this.computeVideoKey(video);
      this.loudnessChecked = false;
      this.silentChunkStreak = 0;
      this.errors = 0;
      this.resetCatchUp();

      if (video.paused) {
        // 暂停时 captureStream 没有数据，但先挂上监听，用户一播放就开始出字幕
        this.overlay.setStatus('已就绪，点播放后开始识别。', 'warn');
      } else {
        this.overlay.setStatus('正在采集音频，第一段字幕大约需要几秒。');
      }

      video.addEventListener('seeked', this.boundOnSeeked);
      video.addEventListener('loadedmetadata', this.boundOnLoadedMeta);
      video.addEventListener('ended', this.boundOnEnded);
      video.addEventListener('play', this.boundOnPlay);
      video.addEventListener('pause', this.boundOnPause);

      if (typeof MediaRecorder === 'undefined') {
        this.notify('当前浏览器不支持 MediaRecorder（需要 Chrome/Edge 116+）。', 'err');
        return;
      }

      // 取音频流（元素模式或标签页模式），失败就说清楚原因
      let source;
      try {
        source = await NS.acquireStream(video, {
          // 会话级覆盖优先于用户设置：自动降级只在本次会话生效
          captureMode: this.sessionCaptureMode || this.settings.captureMode || 'auto',
          sendToBackground: (message) => this.send(message),
          releasePrevious: () => this.releaseTabCapture(),
          log: (...args) => this.log(...args)
        });
      } catch (err) {
        this.overlay.setStatus(`无法获取音频：${(err && err.message) || err}`, 'err');
        this.overlay.toast((err && err.message) || '无法获取音频', 12000);
        return;
      }

      /* 流式模式要的是「小切片、密投喂」，所以采集窗口按流式的参数来；
       * 分段模式仍按用户设的分块秒数。两者的差别只在窗口多长，采集机制相同。 */
      const captureChunkSeconds = this.streamActive
        ? this.settings.streamSliceSeconds || 1.6
        : this.settings.chunkSeconds;
      const captureOverlapSeconds = this.streamActive
        ? this.settings.streamOverlapSeconds || 0.4
        : this.settings.overlapSeconds;

      this.capturer = new NS.AudioChunkCapturer(video, {
        chunkSeconds: captureChunkSeconds,
        overlapSeconds: captureOverlapSeconds,
        sourceMode: source.mode,
        onChunk: (chunk) => this.handleChunk(chunk),
        onStatus: (status) => this.handleCapturerStatus(status),
        log: (...args) => this.log(...args)
      });

      this.running = true;
      this.usedTabCapture = source.mode === 'tab';
      this.renderLoop();
      this.capturer.start(source.stream, { mode: source.mode });
      this.overlay.setState('recording');

      if (source.mode === 'tab') {
        this.overlay.setStatus(`正在抓取整个标签页的声音。${source.note || ''}`);
        this.overlay.toast(
          '已切换为抓取整个标签页的声音：这个播放器的音频无法直接读取。' +
            '请保持本标签页在播放，识别的是标签页里正在响的声音。',
          12000
        );
      } else if (source.note) {
        this.overlay.setStatus(source.note);
      }
    }

    /** 后台预热识别服务，不阻塞主流程，失败也不影响正常识别。 */
    warmUpService() {
      const started = Date.now();
      this.send({ type: 'zimu:warm-up', settings: { language: this.settings.language } })
        .then((response) => {
          if (response && response.ok) {
            this.info(`识别服务预热完成，耗时 ${response.elapsedMs}ms（后续请求会明显更快）`);
          } else {
            this.log('预热未成功（不影响正常识别）：', response && response.error);
          }
        })
        .catch((err) => this.log('预热异常（不影响正常识别）：', err));
      this.log(`已在后台发送预热请求（${started}）`);
    }

    computeVideoKey(video) {
      const src = video.currentSrc || video.src || '';
      const base = src.split('?')[0];
      return `${location.host}${location.pathname}|${base}|${Math.round(video.duration || 0)}`;
    }

    handleCapturerStatus(status) {
      if (!this.overlay) return;
      if (status.state === 'no-audio-data') {
        /* 元素模式能拿到音轨、格式也接受，但录出来是 0 字节——
         * 说明这个播放器的音频流不可编码。别让用户干等，
         * 立刻自动换成抓取整个标签页的声音。 */
        this.handleNoAudioData(status);
        return;
      }
      if (status.state === 'error') {
        this.notify(status.message, 'err');
        this.stop('采集出错');
      } else if (status.state === 'unsupported') {
        this.notify(status.message, 'err');
      } else if (status.state === 'waiting-play') {
        // 视频暂停时不录音（没数据，硬录只会拿到 0 字节），把这件事告诉用户
        this.overlay.setStatus('已就绪，等待视频播放。点播放后会自动开始识别。', 'warn');
        this.overlay.setState('recording');
      } else if (status.state === 'idle' && !this.running) {
        this.overlay.setState('idle');
      } else if (status.state === 'coverage-hole') {
        /* 采集空档必须让用户当场看见：那段音频根本没被录下来，
         * 用户如果不知道，只会以为“识别不准”，方向就找错了。 */
        const hole = status.hole || {};
        this.overlay.setStatus(
          `检测到音频采集空档（${hole.start}s→${hole.end}s），这段内容不会有字幕。`,
          'warn'
        );
      }
    }

    /** 元素模式录不出数据时，自动切到标签页模式重来一次。 */
    async handleNoAudioData(status) {
      if (this.tabFallbackTried) {
        this.overlay.setStatus(
          '这个标签页的声音也抓不到数据。请确认视频正在播放且有声音，然后点“诊断”查看详情。',
          'err'
        );
        return;
      }
      this.tabFallbackTried = true;

      const video = this.video;
      // 先停下来（stop 会写自己的状态文案），再覆盖成切换提示，顺序不能反
      await this.stop('自动切换采集方式');
      this.overlay?.setStatus('当前采集方式读不到音频数据，正在改用“抓取标签页声音”重试…', 'warn');

      if (!video || !video.isConnected) return;

      /* 关键：只让**本次会话**改用标签页模式，绝不去改用户保存的设置。
       *
       * 这里踩过一个很严重的坑：早期版本把降级结果写进了设置，
       * 于是 captureMode 被永久改成 tab。此后每次开启字幕都强制走标签页模式，
       * 而那条路在用户平台上返回 “Cannot capture a tab with an active stream”，
       * 结果就是——明明元素模式可用（诊断录到 156KB、峰值 1.0），插件却一路报错。
       * 自动降级是“这一次”的临时决定，不该改写用户的配置。 */
      this.sessionCaptureMode = 'tab';
      this.video = video;
      await this.start({ keepSessionMode: true });
    }

    /** 拿到一块音频：先做静音检测，再交给 background 识别。 */
    async handleChunk(chunk) {
      this.pending++;
      this.updateBusyStatus();

      /* 空音频块绝不能上传。
       *
       * 这是真实踩过的坑：点了“开启字幕”之后才播放视频，第一块是在暂停期间录的，
       * 时间区间够长但内容为 0 字节。这种块发到后台会被判为无效数据并弹出
       * “识别失败：音频数据无效或为空”，看起来像功能坏了，其实只是把空气传了上去。
       * 空块既没有识别价值，也不该占用一次请求，直接跳过。 */
      if (!chunk.blob || chunk.blob.size === 0) {
        this.pending--;
        this.updateBusyStatus();
        this.stats.empty++;
        this.info(`第 ${chunk.index} 块是空音频（0 字节），已跳过上传`);
        return;
      }
      this.stats.captured++;

      /* 留一份最近录到的音频，供“保存最近一段音频”按钮导出检查 */
      this.lastChunk = { blob: chunk.blob, index: chunk.index, start: chunk.start, end: chunk.end };

      /* 这一段音频**只解码一次**，响度和 PCM 一起拿到。
       *
       * 为什么这点很关键：这里原本连着调了两次 `measureLoudness` —— 同一段
       * 音频、内容完全相同的两次解码；发送时 `toWavBuffer` 又解码第三次。
       * 三次 decodeAudioData + 重采样 + 逐样本 WAV 编码全部落在页面主线程上，
       * 每块都要做一遍。主线程被占住之后，分块用的 setTimeout 会被推迟，
       * 窗口被跳过 —— 音频出现空洞，那段时间的话永远进不了字幕。
       * 实测识别耗时能在一批块里从 1.3 秒抖到 73.7 秒，就是这种拥塞的表现。 */
      const decoded = await NS.decodeChunk(chunk.blob);

      if (decoded) {
        this.info(
          `第 ${chunk.index} 块音量：峰值 ${decoded.peak.toFixed(4)}，RMS ${decoded.rms.toFixed(5)}` +
            `（${decoded.peak < 0.01 ? '近乎静音' : '有声音'}）`
        );
      }

      this.info(
        `第 ${chunk.index} 块：${chunk.start.toFixed(1)}s→${chunk.end.toFixed(1)}s，` +
          `${(chunk.blob.size / 1024).toFixed(0)}KB，音频 ${
            decoded ? `${decoded.durationSec.toFixed(1)}s` : '无法解码（将改发原始格式）'
          }`
      );

      // 静音块也跳过：既省钱，也避免模型在无声段乱编内容（幻觉）。
      // 阈值放得很保守，正常说话（哪怕很小声）都不会被误判成静音。
      if (decoded && decoded.peak < 0.01 && decoded.rms < 0.0006) {
        this.pending--;
        this.updateBusyStatus();
        this.silentChunkStreak++;
        this.stats.silent++;
        this.info(
          `第 ${chunk.index} 块判定为静音，跳过上传（峰值 ${decoded.peak.toFixed(4)}，RMS ${decoded.rms.toFixed(5)}）`
        );
        if (this.silentChunkStreak === 4) {
          this.overlay?.setStatus('连续多块没有声音，可能当前片段没人说话，或音频采集有问题。', 'warn');
        }
        return;
      }

      if (!this.loudnessChecked) {
        this.loudnessChecked = true;
        if (decoded && decoded.rms < 0.0015) {
          this.overlay?.toast(
            '采集到的音频非常轻。常见原因是视频来自别的域名且没开放跨域，浏览器不允许读取它的声音。换个视频源或联系平台开启 CORS 后重试。',
            12000
          );
          this.overlay?.setStatus('警告：采到的音频疑似静音，识别结果可能为空。', 'warn');
        }
      }

      /* 流式模式：不在这里等整块，而是把这一小片直接投给本机服务，
       * 由它把「已经稳定」的部分定稿回来。走完就返回，不进下面的分块流程。 */
      if (this.streamActive) {
        try {
          await this.sendSliceForStream(chunk, decoded);
        } finally {
          this.pending--;
          this.updateBusyStatus();
        }
        return;
      }

      this.info(`第 ${chunk.index} 块已上传识别（${(chunk.blob.size / 1024).toFixed(0)}KB，${chunk.start.toFixed(1)}s→${chunk.end.toFixed(1)}s）`);
      this.overlay?.setStatus(
        `第 ${chunk.index + 1} 块已上传识别（${(chunk.blob.size / 1024).toFixed(0)}KB），等待返回…`
      );
      this.stats.uploaded++;

      const sentAt = Date.now();
      const response = await this.sendChunkForTranscription(chunk, decoded);
      const elapsedMs = Date.now() - sentAt;

      // 累计识别耗时，用来判断延迟主要来自哪一段
      this.stats.recognizeMs += elapsedMs;
      this.stats.recognizeCount++;

      // 延迟可测量：识别耗时 + 视频已经跑到哪，一眼看出字幕落后语音多久
      if (this.video) {
        const behind = this.video.currentTime - chunk.end;
        this.info(
          `第 ${chunk.index} 块识别耗时 ${(elapsedMs / 1000).toFixed(1)}s，` +
            `视频进度 ${this.video.currentTime.toFixed(1)}s ` +
            `（该块覆盖 ${chunk.start.toFixed(1)}s→${chunk.end.toFixed(1)}s，` +
            `落后约 ${behind.toFixed(1)}s）`
        );
      }

      this.pending--;
      this.updateBusyStatus();

      if (!response) return;

      if (!response.ok) {
        /* “没采到音频”属于暂时状态（视频还没出声），不该计入失败次数，
         * 否则用户刚点开启字幕、还没按播放，就会被判成“连续失败”而中止。 */
        if (/没有采集到音频|音频数据无效/.test(String(response.error || ''))) {
          this.info('这一块没采到音频内容，跳过（视频可能刚还没出声）');
          return;
        }
        this.info(`第 ${chunk.index} 块识别失败：${response.error}`);
        this.errors++;
        this.stats.failed++;
        this.overlay?.setStatus(
          `第 ${chunk.index + 1} 块识别失败（第 ${this.errors} 次）：${response.error}`,
          'err'
        );
        if (this.errors >= 3) {
          this.notify('连续多次识别失败，已暂停字幕。修好设置后再开启。', 'err');
          this.stop('连续失败');
        }
        return;
      }

      if (!response.text) {
        this.silentChunkStreak++;
        this.stats.emptyText++;
        this.info(`第 ${chunk.index} 块没有识别出文字（可能没人说话，也可能是服务端返回了空）`);
        this.overlay?.setStatus(
          `第 ${chunk.index + 1} 块识别服务返回了空文本（已累计 ${this.stats.emptyText} 块）。` +
            '若持续如此，说明送上去的音频没有人声。',
          'warn'
        );
        if (this.silentChunkStreak === 5) {
          this.overlay?.setStatus('连续多块没有识别出内容，可能是没人说话或音频太轻。', 'warn');
        }
        return;
      }

      this.silentChunkStreak = 0;
      this.errors = 0;
      const result = this.track.addChunk({ start: chunk.start, end: chunk.end, text: response.text });
      /* 这一块如果回来得太晚（整段都已经是“过去”的了），交给追赶队列补显。
       * 不做这一步，块里只有最后一句能被 renderFrame 找到。 */
      this.enqueueLaggingSegments(result.added);
      this.info(
        `第 ${chunk.index} 块识别到：${response.text}${
          result.added.length ? `（拆成 ${result.added.length} 条字幕）` : '（与上一块重复，已去重）'
        }`
      );

      /* 文字量与音频时长的比值，是“有没有漏内容”最直观的指标。
       * 中文正常语速约 3~6 字/秒；明显偏低就说明这一段里大概率有话没被识别出来。
       * 与其让用户凭感觉说“少了几句”，不如把这个数字直接摆到日志里。 */
      const normalize = NS.normalizeText || ((value) => String(value || ''));
      const cleanChars = Array.from(normalize(response.text)).length;
      const audioSec = decoded ? decoded.durationSec : Math.max(0.5, chunk.end - chunk.start);
      const charsPerSecond = cleanChars / Math.max(0.5, audioSec);
      if (cleanChars > 0 && charsPerSecond < 1.2) {
        this.stats.sparse++;
        this.info(
          `⚠ 第 ${chunk.index} 块文字偏少：${cleanChars} 字 / ${audioSec.toFixed(1)}s ≈ ` +
            `${charsPerSecond.toFixed(1)} 字/秒（正常约 3~6），这一段可能有内容没被识别出来`
        );
      }
      if (result.added.length) {
        this.overlay?.setStatus(`已生成 ${this.track.segments.length} 条字幕，当前进度 ${formatClock(chunk.end)}`);
      }
    }

    updateBusyStatus() {
      if (!this.overlay) return;
      if (this.pending > 0) {
        this.overlay.setState(this.running ? 'recording' : 'stopping');
      } else {
        this.overlay.setState(this.running ? 'recording' : 'idle');
      }
    }

    /**
     * 把一块音频送去做识别。
     *
     * 主路径是直接把 Blob 放进消息里（MV3 支持结构化克隆二进制）。
     * 但不同 Chrome 版本对二进制消息的支持并不一致，一旦序列化失败，
     * 用户看到的现象是“开启后一直没反应”，很难排查。
     * 所以这里加一条兜底：失败就退化成传 ArrayBuffer，再失败才算真失败。
     */
    /**
     * 把一块音频送去做识别。
     *
     * 传输方式是一路踩坑踩出来的：**最终改成传 base64 字符串**。
     *
     * 走过的弯路：
     *  1. 传 Blob 对象 —— 出现“本地 96KB、后台 0 字节”；
     *  2. 传 ArrayBuffer —— 后台收到的是“未知二进制形态(object)”；
     *  3. 传 TypedArray —— 同样被克隆降级成普通对象。
     *
     * 结论：在这台机器/这个 Chrome 版本上，chrome.runtime.sendMessage
     * **不保留二进制对象的类型**，接收端拿到的是按索引存字节的普通对象，
     * 无法当二进制使用。而字符串是所有环境都可靠的类型，
     * base64 只增加约 33% 体积（98KB → 131KB），完全值得。
     *
     * @param {object} chunk
     * @param {object|null} decoded handleChunk 里已经解码好的 PCM（含响度）。
     *        传进来就复用，不再解码第二遍 —— 解码是整条链路最贵的一步。
     */
    async sendChunkForTranscription(chunk, decoded) {
      const base = {
        type: 'zimu:transcribe',
        // 配置还没读到时不硬崩：少了 language 只是让服务自动判断语言
        settings: { language: this.settings ? this.settings.language : '' },
        chunkIndex: chunk.index
      };

      let base64;
      let mimeType = chunk.blob.type || 'audio/webm';

      try {
        /* 优先转成 16kHz 单声道 WAV 再发。
         *
         * 关键原因：本地 Whisper 服务通常没有 ffmpeg，只能解 WAV；
         * 而 MediaRecorder 录出来的是 WebM/Opus。在浏览器里转好，
         * 本地服务就只需要 Python 标准库的 wave 模块，依赖降到最低。
         * 云端服务也完全接受 WAV，所以统一走这一条路，不用分叉。 */
        if (decoded) {
          const buffer = NS.encodeWav(decoded.samples, NS.WAV_SAMPLE_RATE);
          const durationSec = decoded.durationSec;
          // 编完码立刻放掉 PCM：别让几百 KB 的浮点数组一直占到网络返回
          decoded.samples = null;
          base64 = NS.bytesToBase64(buffer);
          mimeType = 'audio/wav';
          this.log(
            `第 ${chunk.index} 块已转为 WAV（${durationSec.toFixed(1)}s，${(buffer.byteLength / 1024).toFixed(0)}KB）`
          );
        } else {
          // Web Audio 解码失败时退回原始格式：云端能直接吃 WebM
          const raw = await chunk.blob.arrayBuffer();
          base64 = NS.bytesToBase64(raw);
          this.info(`第 ${chunk.index} 块 WAV 转换失败，改发原始格式（${mimeType}）`);
        }
      } catch (err) {
        this.info(`第 ${chunk.index} 块读取音频字节失败：${(err && err.message) || err}`);
        return { ok: false, error: `读取音频数据失败：${(err && err.message) || err}` };
      }

      const response = await this.send({
        ...base,
        base64,
        mimeType,
        expectedSize: chunk.blob.size
      });

      // 回执异常时把两边的体积一起打出来，便于一眼看出传输是否丢数据
      if (!response || !response.ok) {
        this.info(
          `第 ${chunk.index} 块后台回执异常（本地 ${chunk.blob.size} 字节，` +
            `base64 ${base64.length} 字符）：${(response && response.error) || '无响应'}`
        );
      }
      return response;
    }

    /**
     * 从流式退回分块模式。
     *
     * **这里最容易漏掉的一步是改采集窗口的长度。**
     * 流式模式用的是 1~2 秒的小切片，而“这台服务其实不支持流式”是发出第一片
     * 之后才由后台告知的。如果只把 streamActive 置 false 而不管采集器，
     * 采集器会继续每 1.6 秒切一块送去识别——一句话被反复从中间切断，
     * 补不上下文，错字漏字成倍增加，而且请求数变成原来的三四倍、云端排队更久。
     *
     * 用户实测日志里就是这个现象：日志写着“已退回分块模式”，
     * 可紧接着的“第 N 块”全是 1.6s。所以回滚必须回滚到底。
     */
    fallBackToChunkMode(reason) {
      if (!this.streamActive) return;
      this.streamActive = false;
      this.streamSession = null;

      const chunkSeconds = (this.settings && this.settings.chunkSeconds) || 6;
      const overlapSeconds = (this.settings && this.settings.overlapSeconds) || 0;
      const changed =
        this.capturer && typeof this.capturer.setChunking === 'function'
          ? this.capturer.setChunking({ chunkSeconds, overlapSeconds })
          : false;

      this.info(
        `流式识别不可用（${reason}），已退回分块模式` +
          (changed ? `：每块改回 ${chunkSeconds}s` : '')
      );
      this.overlay?.setStatus(
        `流式识别不可用，已退回每 ${chunkSeconds} 秒一块的分块模式。`,
        'warn'
      );
    }

    /**
     * 流式识别：把这一小片音频投给本机服务，并把它新定稿的字幕落盘。
     *
     * 与 sendChunkForTranscription 最本质的区别在**时间戳从哪来**：
     * 那边只知道「这一块覆盖 a→b 秒」，文字怎么摊到时间上全靠按字数估；
     * 这边每一段都带服务端算出的真实起止时间，直接用即可，不必再估。
     *
     * 失败处理分三档：单片失败不算致命（下一片大概率就恢复了）；服务端明确说
     * 不支持流式时立刻降级；连续失败到一定次数也降级——总比一片字幕都出不来强。
     */
    async sendSliceForStream(chunk, decoded) {
      const session = this.streamSession;
      if (!session) return;

      this.stats.uploaded++;
      this.streamStats.slices++;

      let base64;
      let mimeType = (chunk.blob && chunk.blob.type) || 'audio/webm';
      try {
        if (decoded) {
          const buffer = NS.encodeWav(decoded.samples, NS.WAV_SAMPLE_RATE);
          // 编完码立刻放掉 PCM，别让浮点数组一直占到网络返回
          decoded.samples = null;
          base64 = NS.bytesToBase64(buffer);
          mimeType = 'audio/wav';
        } else {
          const raw = await chunk.blob.arrayBuffer();
          base64 = NS.bytesToBase64(raw);
        }
      } catch (err) {
        this.info(`第 ${chunk.index} 片读取音频字节失败：${(err && err.message) || err}`);
        return;
      }

      const sentAt = Date.now();
      let response;
      try {
        response = await this.send({
          type: 'zimu:transcribe-stream',
          settings: { language: this.settings ? this.settings.language : '' },
          session,
          chunkIndex: chunk.index,
          start: chunk.start,
          end: chunk.end,
          base64,
          mimeType,
          expectedSize: chunk.blob.size
        });
      } catch (err) {
        response = { ok: false, error: (err && err.message) || String(err) };
      }
      const elapsedMs = Date.now() - sentAt;

      /* 会话已经被换掉（拖动进度 / 切集）：这次的结果属于上一个位置，
       * 落盘只会让字幕张冠李戴，直接丢弃。 */
      if (this.streamSession !== session) return;

      if (!response || !response.ok) {
        this.streamStats.failed++;
        if (response && response.fallback) {
          this.fallBackToChunkMode(response.error || '本机服务不支持流式识别');
          return;
        }
        this.info(`第 ${chunk.index} 片流式识别失败：${(response && response.error) || '无响应'}`);
        if (this.streamStats.failed >= 5) {
          this.fallBackToChunkMode('连续 5 次流式请求失败');
        }
        return;
      }

      this.streamStats.failed = 0;
      if (response.avgDecodeMs) this.streamStats.avgDecodeMs = response.avgDecodeMs;
      this.stats.recognizeMs += elapsedMs;
      this.stats.recognizeCount++;

      const segments = Array.isArray(response.segments) ? response.segments : [];
      if (!segments.length) return;

      const result = this.track.addTimedSegments(segments);
      this.streamStats.segments += result.added.length;
      /* 落后时同样交给追赶队列：定稿的时间点可能已经在当前播放位置之前。 */
      this.enqueueLaggingSegments(result.added);
      this.info(
        `第 ${chunk.index} 片定稿 ${result.added.length} 条：${segments.map((s) => s.text).join('')}` +
          `（解码 ${elapsedMs}ms，视频 ${chunk.end.toFixed(1)}s）` +
          (response.pending ? `｜未定稿：${response.pending}` : '')
      );
      if (result.added.length) {
        this.overlay?.setStatus(
          `已生成 ${this.track.segments.length} 条字幕，当前进度 ${formatClock(chunk.end)}`
        );
      }
    }

    /**
     * 每帧检查播放时间，把对应字幕显示出来。
     *
     * 连贯性是这里的核心。早期写法是“当前时刻没有字幕就立刻清空”，
     * 结果是：一块 12 秒的音频识别出几条字幕，文字集中在开头几秒显示完，
     * 剩下的**七八秒一片空白**，直到下一块返回——用户感受就是
     * “闪一句、空一段、再闪一句”。
     *
     * 真人录制的字幕不会这样：一句话说完后**字幕一直留到下一句出现**，
     * 是“切换”而不是“消失”。所以这里一旦显示出某条字幕，就让它持续到
     * 被下一条替换；只在两种情况下才清空：
     *  1. 用户拖了进度条（旧字幕已经不对应当前画面）；
     *  2. 视频暂停了（画面静止，字幕没有继续挂着的意义）。
     *
     * 持有上限按分块时长推算：一块处理完到下一块返回，最长大约
     * 一个分块周期加若干秒识别延迟，多留 4 秒余量。
     */
    renderLoop() {
      if (this.renderHandle) return;
      const tick = () => {
        if (!this.running && this.pending === 0) {
          this.renderHandle = null;
          return;
        }
        this.renderHandle = requestAnimationFrame(tick);
        this.renderFrame();
      };
      this.renderHandle = requestAnimationFrame(tick);
    }

    /**
     * 渲染一帧。抽成独立方法是为了能直接测——否则要驱动 requestAnimationFrame 才能验证，
     * 而“字幕该保留还是该清空”这个判断恰恰是最容易出错、也最需要测试的部分。
     */
    renderFrame() {
      if (!this.video || !this.track) return;

      const time = this.video.currentTime;

      /* ① 当前时刻已经有字幕 → 优先显示它。
       *
       * 这一条必须排在追赶之前。识别一旦追平，当前时刻的内容永远比队列里的
       * 历史内容更新；让队列挡住它，用户看到的就是“Console 里明明有新文字返回，
       * 屏幕上却还挂着很久以前那句”。 */
      const seg = this.track.segmentAt(time);

      if (seg) {
        if (this.catchUpQueue.length) {
          const dropped = this.catchUpQueue.length;
          this.resetCatchUp();
          this.info(`识别已追平画面，放弃补显 ${dropped} 条历史字幕（它们仍完整保留在导出的字幕里）`);
        }
        this.currentSegment = seg;
        this.lastShownTime = time;
        /* 逐字放出：进度按媒体时间推进，节奏跟着这句话自己的音频时长走。
         * 算完仍然是整句时（放完了）partial 为 false，样式与从前一致。 */
        const slice = this.typewriterSlice(seg, time);
        this.retiredText = null;
        this.show(slice.text, { partial: slice.partial });
        return;
      }

      /* 拖了进度条：旧字幕已经对不上画面，必须立刻清掉，
       * 否则用户会看到一段完全不相关的内容。 */
      if (this.lastShownTime !== null && time < this.lastShownTime - 1.5) {
        this.currentSegment = null;
        this.show('');
        return;
      }

      /* 视频暂停：画面静止，没必要继续挂着字幕。
       * 这个判断必须放在“保留上一条”之前，否则暂停时字幕会一直留着。 */
      if (this.video.paused) {
        this.currentSegment = null;
        this.show('');
        return;
      }

      /* ② 落后超过上限 → 放弃逐条补显，直接对齐最新内容。
       *
       * 逐条补显的本意是“把漏掉的补回来”，前提是只落后一点点。但识别一旦
       * 长期落后（服务排队、页面被占），补显就等于给用户放“回忆录”：屏幕上
       * 是几十秒前的话，与画面彻底脱节，而补显本身还在继续加长落后。
       *
       * 所以这里划一条线：屏幕上的字幕最多落后 maxLagSeconds 秒。超过就丢掉
       * 队列、直接显示最新一条。被丢掉的内容在识别结果里是完整的，导出 SRT
       * 一条不少——**屏幕求“跟得上”，文件求“不丢”**。 */
      if (this.catchUpQueue.length) {
        const newest = this.catchUpQueue[this.catchUpQueue.length - 1];
        const lag = time - (newest.end || 0);
        const maxLag = this.maxLagSeconds || 20;
        /* 光看时间不够：识别慢几秒是常态，"屏幕比话音晚几秒"是上游的延迟，
         * 不代表我们没跟上。真正说明跟不上的是**积压**。
         * 所以这条要求两个条件同时成立：屏幕确实落后很多，**并且**队列里还堆着
         * 至少两条。单独一条迟到（backlog 1）永远不跳——否则会把正在逐字打的
         * 那句话拦腰截断，观感是"打到一半忽然跳到下一句"。 */
        if (lag > maxLag && this.catchUpQueue.length >= 2) {
          const dropped = this.catchUpQueue.length;
          this.resetCatchUp();
          this.info(
            `字幕落后约 ${lag.toFixed(1)}s，超过上限 ${maxLag.toFixed(0)}s：跳过 ${dropped} 条补显，` +
              '直接对齐最新内容（导出的字幕仍完整）。若频繁出现，请把「分块秒数」调小到 4~6 秒。'
          );
        }
      }

      /* ③ 落后在可控范围内 → 按顺序补显。
       * 补显速度刻意快于实时（见 catchUpDwellFor），否则落后永远追不平。 */
      if (this.drainCatchUpQueue()) return;

      const last = this.track.lastSegmentBefore(time);
      if (!last) {
        this.currentSegment = null;
        this.show('');
        return;
      }

      /* 拖动进度后，跳转点**之前**的内容属于“别的位置说的话”，不能再显示。 */
      const jump = this.lastJumpMediaTime;
      if (Number.isFinite(jump) && last.end < jump - 1) {
        this.currentSegment = null;
        this.show('');
        return;
      }

      /* ③.5 正在打字的那一句先打完。
       *
       * 用户要的节奏是「组成一句话后再消失，继续下一句」——所以不能因为下一条
       * 已经到了，就把这句还剩一半的字直接扔掉。整句的放字时长上限是 8 秒
       * （见 typewriterSlice 的 MAX_SPAN），所以最多多等这么久，不会无限拖。
       *
       * 这里用 reveal 里的锚点和时长反造一个等价的段交给 typewriterSlice，
       * 节奏与原来完全一致（不这么做的话，换成"最新的那句"会让已打的字重来）。 */
      const typing = this.reveal && !this.reveal.done ? this.reveal : null;
      const target = typing
        ? { text: typing.full, start: typing.anchor, end: typing.anchor + typing.span }
        : last;

      /* 这一条已经打完、并且停留够久了 → 清空，等下一句。
       * 清掉之后记下文本，免得下一帧又把它捞回来重打一遍。 */
      if (target.text === this.retiredText) {
        this.currentSegment = null;
        this.show('');
        return;
      }
      if (this.revealFinishedLongAgo()) {
        this.retiredText = target.text;
        this.currentSegment = null;
        // show('') 会把 reveal 一并清掉，下一句得以从头重新开始打
        this.show('');
        return;
      }

      /* 其余情况一律保留最近说过的这一条，直到更新的内容把它替换掉。
       *
       * 注意这里**没有**“按时间硬清空”的旧逻辑（那个持有上限在分块 12 秒时高达
       * 36 秒，到点就清屏，用户以为插件坏了）。现在唯一的清空时机是上面那条：
       * **这一句自己打完 + 停留够久**，也就是用户要的「一句打完再消失」。 */
      this.currentSegment = last;
      const held = this.typewriterSlice(target, time);
      this.show(held.text, { partial: held.partial });
    }

    /**
     * 把“识别回来时已经播过去了”的字幕段放进追赶队列。
     *
     * 判据很简单：这段的结束时间已经早于当前播放位置，说明它不可能再靠
     * `segmentAt()` 命中——不主动补显就永远看不到。
     */
    enqueueLaggingSegments(added) {
      if (!added || !added.length || !this.video) return;
      const time = this.video.currentTime;
      const lagging = added.filter((segment) => segment.end <= time);
      if (!lagging.length) return;

      for (const segment of lagging) this.catchUpQueue.push(segment);

      /* 落后太多时只保留最近的若干条。
       * 取舍理由：队列无限增长只会让字幕永远在放几十秒前的话，
       * 观感更差；而被丢掉的内容在识别结果里是完整的，导出 SRT 时一条不少。 */
      if (this.catchUpQueue.length > this.catchUpQueueLimit) {
        const dropped = this.catchUpQueue.splice(0, this.catchUpQueue.length - this.catchUpQueueLimit);
        this.info(
          `字幕积压过多，放弃补显最早 ${dropped.length} 条（导出 SRT 时它们仍在，建议调小分块秒数）`
        );
      }
      /* 只积压一条不算落后（识别慢一两句是常态），走正常路径逐字显示，
       * 所以这里用调试日志，免得每句话都往 Console 里刷一行。 */
      if (this.catchUpQueue.length > 1) {
        this.info(
          `有 ${lagging.length} 条字幕已落后于画面，将按顺序补显（当前积压 ${this.catchUpQueue.length} 条）`
        );
      } else {
        this.log(`这 ${lagging.length} 条只是回来得比画面晚，按正常节奏逐字显示（不算积压）`);
      }
    }

    /**
     * 补显一条队列里的字幕。
     *
     * 节奏由 catchUpDwellFor() 控制：哪怕是追赶，每条也要停留足够长，
     * 否则内容照样等于没显示。返回 true 表示这一帧由追赶接管。
     */
    drainCatchUpQueue() {
      const now = Date.now();
      const time = this.video ? this.video.currentTime : 0;

      /* 正在补显的那一条：在它自己的停留时间内**继续推进逐字进度**。
       * 这一步不能省——停留的节流只决定"什么时候换下一条"，
       * 不能把"正在打这句话"也一起冻住。 */
      if (this.catchUpItem) {
        if (now < this.catchUpNextAt) {
          const slice = this.typewriterSlice(this.catchUpItem, time, this.catchUpItemSpan);
          this.show(slice.text, { partial: slice.partial });
          return true;
        }
        this.catchUpItem = null;
      }

      const backlog = this.catchUpQueue.length;
      if (!backlog) return false;

      /* 只剩一条 → **不算积压，本方不接管**，交回正常渲染路径。
       *
       * 这一条是实测踩出来的，非常关键：识别慢一两句是常态，于是
       * `enqueueLaggingSegments` 的判据（end <= 当前时间）**几乎对每一句都成立**，
       * 每一条字幕都会被判成"落后"。只要补显通道接管，逐字显示就等于没做——
       * （补显原本是整句直接上屏的，用户看到的仍然是"一句话整块蹦出来"）。
       *
       * 这个现象一开始很难理解：单测里是直接调 renderFrame 喂数据，走正常路径；
       * 真实运行里每一句都从补显通道过，两条路根本没交汇。
       * 判据是 tools/sim-timeline.mjs 推演出来的。 */
      if (backlog === 1) {
        this.catchUpQueue.length = 0;
        this.catchUpNextAt = 0;
        this.log('这一条只是回来得比画面晚，不算积压：交给正常路径逐字显示');
        return false;
      }

      const segment = this.catchUpQueue.shift();
      const dwell = this.catchUpDwellFor(segment);
      this.catchUpItem = segment;
      /** 补显时把放字压缩到 dwell 之内——积压越多打得越快，但**始终是逐字**，
       *  不会退化成整句直接上屏，也不会像按原速补显那样永远追不平（gotcha #30）。 */
      this.catchUpItemSpan = dwell / 1000;
      this.catchUpNextAt = now + dwell;
      this.currentSegment = segment;
      if (this.video) this.lastShownTime = time;

      const slice = this.typewriterSlice(segment, time, this.catchUpItemSpan);
      this.show(slice.text, { partial: slice.partial });
      return true;
    }

    /**
     * 一条字幕在补显时该停留多久（毫秒）。
     *
     * 基准是这条字幕**原本占用的时长**：这样字幕与音频保持一个固定的偏移，
     * 而不是越拖越远；只落后一小截时看起来就和正常同步字幕一样。
     * 另外按积压量加速——积压越多每条停留越短。必须加速的原因很实际：
     * 正常语速下一块大约只有一条字幕，如果补显速度低于识别产出速度，
     * 队列只会越积越多、永远追不上；而下限仍保证来得及扫一眼。
     */
    catchUpDwellFor(segment) {
      const natural = Math.max(0, (segment.end || 0) - (segment.start || 0)) * 1000;
      /* 关键：补显必须**快于实时**。
       *
       * 原来取下限是这条字幕的自然时长（4000ms 上限），等于按原速重播一遍：
       * 只要识别曾经慢过一次，那段落后就被永久保留下来——实测“字幕长期慢
       * 十几秒、怎么也追不上”就是这么来的。现在按自然时长的一半补显，
       * 队列才会真正被清空、屏幕才会往当前时间上靠。 */
      let dwell = Math.min(this.catchUpMaxDwellMs, Math.max(this.catchUpMinDwellMs, natural * 0.5));
      const backlog = this.catchUpQueue.length;
      if (backlog >= 8) dwell = Math.min(dwell, 1000);
      else if (backlog >= 4) dwell = Math.min(dwell, 1500);
      return dwell;
    }

    /** 清空追赶状态。拖动进度条、停止、清空字幕时都必须调用。 */
    resetCatchUp() {
      this.catchUpQueue = [];
      this.catchUpNextAt = 0;
      /** 正在补显的那一条（含它在补显期间被压缩后的放字时长） */
      this.catchUpItem = null;
      this.catchUpItemSpan = 0;
      /** 最近一次拖动进度的媒体时间；跳转点之前的内容不再显示 */
      this.lastJumpMediaTime = undefined;
      /* 逐字状态也要清：新位置的字幕必须从头重新"打"一遍，
       * 也不能被"上一位置的句子已经退休了"这个记忆挡住。 */
      this.reveal = null;
      this.retiredText = null;
    }

    /**
     * 逐字显示：按**这句话自己的音频时长**放字。
     *
     * 用户实测反馈（第二条）：「最好跟随音频中的时间逐个输出，而不是整句说完
     * 之后字幕才把上一句输出出来。」
     *
     * 所以节奏的来源必须换一个：
     *
     *  · 旧做法（错的）——按「这条字幕到手之后过了多久」放字，给一个固定时长
     *    （0.75~1.8 秒）。结果是一句话的音频早就说完了，字幕才回来，
     *    然后用一秒多把整句"突突"地补放出来，观感就是**事后的回放**。
     *
     *  · 现在——放字时长 = `end - start`，即**这句话本身说了多久**，
     *    逐字进度直接由媒体时间推进。于是 6 秒说完的句子就花 6 秒打完，
     *    字的出场节奏和话音一一对应；暂停打字就停，恢复接着打。
     *
     * 锚点（从哪一刻开始算进度）分两种情况，这是本方法的关键：
     *
     *  · `time <= end` —— 还没播完就拿到了文字（识别跟得上、或回看已识别过的
     *    片段）。锚在**句首** `start`，进度 = 已经说过的时长 / 总时长，
     *    字真的在它被念出来的那一刻出现。
     *  · `time > end` —— 迟到。文本到手之前根本显示不了，只能锚在**到手的那一刻**，
     *    按同样的语速自播一遍。整体后移，但**语速对得上话音**，
     *    不会出现"一下子涌出来"的感觉。
     *
     * 只增不减：同一句话内进度不会回退。拖动进度条后由 onTimelineJump 重置。
     *
     * @param {{start:number,end:number,text:string}} segment
     * @param {number} time 当前媒体时间（video.currentTime）
     * @param {number} [maxSpanSeconds] 放字时长上限（秒）。用于补显时压缩节奏——
     *   积压越多打得越快，但**始终是逐字**，不会退化成整句直接上屏。
     * @returns {{text: string, partial: boolean}} 本帧应当显示的文字
     */
    typewriterSlice(segment, time, maxSpanSeconds) {
      /** 太短的句子至少放这么久，否则一闪而过 */
      const MIN_SPAN = 0.8;
      /** 太长的句子最多放这么久，否则字幕会明显拖在话音后面 */
      const MAX_SPAN = 8;

      const text = String((segment && segment.text) || '');
      if (!text) {
        this.reveal = null;
        return { text: '', partial: false };
      }
      if (!this.typewriterEnabled) {
        this.reveal = null;
        return { text, partial: false };
      }

      const start = Number(segment.start) || 0;
      const end = Number(segment.end) || start;

      let reveal = this.reveal;
      if (!reveal || reveal.full !== text) {
        let span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, end - start));
        if (Number.isFinite(maxSpanSeconds) && maxSpanSeconds > 0) {
          span = Math.min(span, maxSpanSeconds);
        }
        reveal = {
          full: text,
          shown: 0,
          /** 进度从哪一刻开始算（媒体时间） */
          anchor: time <= end ? start : time,
          /** 这句话放完需要多久（媒体秒） */
          span,
          done: false,
          /** 放完的时刻（挂钟毫秒），用于"打完停留一会儿再消失" */
          doneAtMs: 0
        };
        this.reveal = reveal;
      }

      if (reveal.done) return { text, partial: false };

      const progress = reveal.span > 0 ? (time - reveal.anchor) / reveal.span : 1;
      const target = Math.min(text.length, Math.floor(progress * text.length));
      if (target > reveal.shown) reveal.shown = target;

      if (reveal.shown >= text.length) {
        reveal.done = true;
        reveal.doneAtMs = Date.now();
        return { text, partial: false };
      }
      return { text: text.slice(0, Math.max(1, reveal.shown)), partial: true };
    }

    /**
     * 这句话打完、并且停留够久了吗？（用于"组成一句话后再消失"）
     *
     * 用户明确要的节奏是「一句打完就消失、再出下一句」。稳态下这样做几乎不会
     * 留下空白：逐字按语速走，出字速度和识别产出速度本来就同频，下一条差不多
     * 正好在这一刻到手。真出现空白只说明识别这边卡住了——那种时候空着，
     * 比一直挂着一句很久以前说的话更诚实。
     *
     * 注意只对**逐字打完**的句子生效。追赶补显那种整句直接上屏的内容不参与，
     * 否则补显队列刚放完就会把屏幕清空。
     */
    revealFinishedLongAgo(lingerMs = this.captionLingerMs) {
      const reveal = this.reveal;
      if (!reveal || !reveal.done || !reveal.doneAtMs) return false;
      return Date.now() - reveal.doneAtMs >= lingerMs;
    }

    show(text, options) {
      const partial = Boolean(options && options.partial);
      if (text === this.lastShownText && partial === this.lastShownPartial) return;
      this.lastShownText = text;
      this.lastShownPartial = partial;
      if (!text) {
        this.reveal = null;
      } else if (!partial && this.typewriterEnabled) {
        /* 整句直接显示时（追赶补显、以及保留上一条的情形），把逐字进度也标记成
         * 「已放完」。否则下一帧 typewriterSlice 会把它当成新句子重新开始，
         * 屏幕上已经显示完整的一句话会缩回成头几个字——肉眼看着像在抽搐。
         *
         * doneAtMs 刻意留 0：这类内容不参与"打完就消失"，避免补显刚放完就清屏。
         *
         * **不能覆盖已有的 reveal**：逐字刚好打完那一帧，typewriterSlice 已经把
         * doneAtMs 记上了（那是"打完"的时刻）。这里若无脑重建，doneAtMs 会被清零，
         * "打完停留一会儿再消失"就永远不会触发。 */
        if (!this.reveal || this.reveal.full !== text) {
          this.reveal = { full: text, shown: text.length, anchor: 0, span: 1, done: true, doneAtMs: 0 };
        }
      }
      this.overlay?.showCaption(text, partial);
    }

    /** 视频拖动、切集、或页面换了另一个播放器。 */
    onTimelineJump() {
      if (!this.overlay) return;
      const key = this.computeVideoKey(this.video);

      /* 采集侧也要同步：正在录的那个窗口跨越了跳转点，音频和时间戳对不上，
       * 必须丢掉并从新位置重新开始（否则会拼出一条张冠李戴的字幕）。 */
      this.capturer?.handleTimelineJump();

      if (key !== this.videoKey) {
        if (this.running) {
          /* 识别过程中视频被换掉了（例如课程平台在同一页里切换下一节），
           * 必须停掉：继续录下去，新视频的语音会被拼进旧视频的字幕里，
           * 时间轴也会对不上。停下来并把控制权交回用户更安全。 */
          this.stop('切换视频');
          this.notify('检测到切换了视频，已停止上一节的字幕。点“开启字幕”可继续识别当前这一节。', 'warn');
        }
        this.videoKey = key;
        this.track?.reset();
        this.resetCatchUp();
        this.show('');
        return;
      }

      // 只是拖进度条：已识别的字幕仍然有效，新位置的内容会重新出。
      // 这里只记日志不动状态栏，避免用户频繁拖动时状态栏一直在闪。
      /* 追赶队列必须清掉：里面的内容属于拖动前的位置，继续补显只会
       * 让用户看到一段与画面完全无关的话。 */
      this.resetCatchUp();
      /* 流式会话也要换掉：服务端缓冲里存的还是旧位置的音频，
       * 继续往同一个会话里投喂新位置的音频，定稿出来的时间戳会整体错位。 */
      if (this.streamActive) this.streamSession = newSessionId();
      /* 记下跳转点。渲染时“跳转点之前的内容”一律不显示——那是别的位置说的话。
       * 这份职责原来被藏在 holdSeconds 里（靠“时间差太大就清空”间接实现），
       * 结果是识别一落后就把正常字幕也一起清掉了。 */
      if (this.video) this.lastJumpMediaTime = this.video.currentTime;
      if (this.video) this.log(`进度跳转到 ${this.video.currentTime.toFixed(1)}s`);
    }

    /** 暂停时不再切新块，避免上传一堆无声片段；恢复后自动继续。 */
    onPlaybackToggle() {
      if (!this.running) return;
      this.capturer?.handlePlaybackChange();
      if (this.video.paused) {
        this.overlay?.setStatus('视频已暂停。继续播放后会自动接着识别。');
      } else {
        this.overlay?.setStatus('继续识别中…');
      }
    }

    async stop(reason) {
      if (!this.running && !this.capturer) return;
      this.running = false;
      this.overlay?.setState('stopping');
      this.overlay?.setStatus(`正在收尾…（${reason || ''}）`);

      if (this.video) {
        this.video.removeEventListener('seeked', this.boundOnSeeked);
        this.video.removeEventListener('loadedmetadata', this.boundOnLoadedMeta);
        this.video.removeEventListener('ended', this.boundOnEnded);
        this.video.removeEventListener('play', this.boundOnPlay);
        this.video.removeEventListener('pause', this.boundOnPause);
      }

      if (this.capturer) {
        const capturer = this.capturer;
        this.capturer = null;
        await capturer.stop(reason);
      }

      // 标签页模式下要顺手告诉离屏文档停止回放，避免声音一直挂着
      if (this.usedTabCapture) {
        this.usedTabCapture = false;
        this.send({ type: 'zimu:release-tab-playback' }).catch(() => {});
      }

      const waitStart = Date.now();
      while (this.pending > 0 && Date.now() - waitStart < 8000) {
        await delay(120);
      }

      /* 流式模式必须收尾：服务端缓冲里还剩最后几秒没定稿的音频，
       * 不 flush 的话那几句永远不会出现在字幕里（导出的 SRT 会缺结尾）。
       * 放在等完在飞的切片之后再发，顺序才不会乱。 */
      if (this.streamSession) {
        const session = this.streamSession;
        this.streamSession = null;
        try {
          const tail = await this.send({ type: 'zimu:transcribe-stream', session, flush: true });
          if (tail && tail.ok && Array.isArray(tail.segments) && tail.segments.length) {
            const added = this.track ? this.track.addTimedSegments(tail.segments).added : [];
            if (added.length) this.info(`流式收尾补上 ${added.length} 条字幕`);
          }
        } catch (err) {
          this.log('流式收尾失败（已生成的字幕不受影响）', err);
        }
      }
      this.streamActive = false;

      this.overlay?.setState('idle');
      const count = this.track ? this.track.segments.length : 0;
      const s = this.stats;
      /* 停止时把分块统计一并报出来。用户看到“0 条字幕”时最需要知道的就是
       * 卡在哪一环：没采到音频 / 被静音判定跳过 / 服务返回空文本 / 请求失败。
       * 这几个数字能把问题直接定位到某一环，省掉一轮来回排查。 */
      const summary =
        `已停止。本次共生成 ${count} 条字幕。` +
        `分块统计：采到 ${s.captured} 块，上传 ${s.uploaded} 块，` +
        `空音频跳过 ${s.empty} 块，静音跳过 ${s.silent} 块，` +
        `服务返回空 ${s.emptyText} 块，文字偏少 ${s.sparse} 块，失败 ${s.failed} 块。`;
      this.overlay?.setStatus(summary, count === 0 ? 'warn' : '');
      this.info(summary);

      /* 采集空档单独报——它是“输不全”里最难自证的一种：
       * 那段时间的音频从没被录下来，日志里连一条“第 N 块”都不会出现。
       * 把时间点列出来，用户可以直接对着视频核。 */
      const holes = (this.capturer && this.capturer.coverageHoles) || [];
      if (holes.length) {
        const totalSec = holes.reduce((sum, h) => sum + (h.end - h.start), 0);
        const detail = holes.slice(0, 6).map((h) => `${h.start}s→${h.end}s`).join('，');
        this.info(
          `⚠ 本次采集有 ${holes.length} 处空档，共约 ${totalSec.toFixed(1)}s 音频没被录到：${detail}` +
            (holes.length > 6 ? ' …' : '') +
            '。这些时间段的字幕必然缺失，请对照视频确认'
        );
      }

      /* 延迟归因：把“等分块”和“等服务识别”拆开报出来。
       * 这是用户最关心的问题（字幕比语音慢多少），而两段的优化手段完全不同：
       * 前者调小分块秒数即可，后者只能换服务或改用流式识别。 */
      const streamedSlices = this.streamStats.slices;
      if (streamedSlices) {
        const ss = this.streamStats;
        this.info(
          `流式统计：投喂 ${streamedSlices} 片，定稿 ${ss.segments} 条，失败 ${ss.failed} 片，` +
            (ss.avgDecodeMs ? `服务端平均解码 ${ss.avgDecodeMs.toFixed(0)}ms` : '服务端未返回解码耗时')
        );
      }

      if (s.recognizeCount > 0) {
        const avgMs = s.recognizeMs / s.recognizeCount;
        const chunkSec = this.settings ? this.settings.chunkSeconds : 0;
        /* 流式模式下延迟的大头是「等这一片录完」，不再是「等整块」，
         * 报错了数字会让人照着错的杠杆去调参。 */
        const sliceSec = (this.settings && this.settings.streamSliceSeconds) || 1.6;
        const waitSec = streamedSlices
          ? sliceSec
          : Math.max(0, chunkSec - (this.settings ? this.settings.overlapSeconds : 0));
        const totalSec = waitSec + avgMs / 1000;
        const head = streamedSlices ? '流式延迟归因：等一片约' : '延迟归因：等分块约';
        const advice = streamedSlices
          ? '流式模式下这个数字的大头是「等这一片录完」，把「流式切片」调小还能再快一点。'
          : avgMs > 4000
            ? '识别服务偏慢，调小分块收益有限。'
            : `把分块秒数降到 ${Math.max(4, Math.round(chunkSec / 2))}s 可再快约 ${(waitSec / 2).toFixed(0)}s。`;
        const latency =
          `${head} ${waitSec.toFixed(0)}s + 服务识别平均 ${(avgMs / 1000).toFixed(1)}s ` +
          `≈ 共 ${totalSec.toFixed(0)}s。${advice}`;
        this.info(latency);
        this.overlay?.setStatus(`${summary}\n${latency}`, count === 0 ? 'warn' : '');
      }
      this.show('');
      this.currentSegment = null;
      this.resetCatchUp();
    }

    /**
     * 释放标签页采集：停掉自己的流，并让离屏文档断开回放。
     *
     * 为什么必须做：Chrome 同一时刻只允许一个标签页抓取存在。
     * 上一次抓取的流没释放就再次申请，会直接报
     * “Cannot capture a tab with an active stream”——用户看到的
     * 就是“开启字幕说无法获取音频”。所以重新申请之前必须先清理干净。
     */
    async releaseTabCapture() {
      if (!this.usedTabCapture) return;
      this.usedTabCapture = false;
      try {
        if (this.capturer && this.capturer.stream) {
          this.capturer.stream.getTracks().forEach((track) => track.stop());
        }
      } catch (err) {
        this.log('释放标签页音频流失败', err);
      }
      await this.send({ type: 'zimu:release-tab-playback' }).catch(() => {});
      // Chrome 释放抓取需要一点时间，稍等一下再申请，避免立刻撞上 still-capturing
      await delay(250);
    }

    /**
     * 把最近录到的一块音频存成文件。
     *
     * 为什么需要这个功能：当“上传成功但识别不出内容”这类问题出现时，
     * 光靠日志无法判断送上去的音频到底是不是有用的人声（可能是静音、
     * 可能是噪音、也可能内容正常但服务端有问题）。让用户能直接听一遍，
     * 一次就能分清是哪一类问题，省掉好几轮来回排查。
     */
    async saveLastChunk() {
      if (!this.lastChunk || !this.lastChunk.blob) {
        this.notify('还没有录到音频。先播放视频并开启字幕，等第一块录完再试。', 'warn');
        return;
      }
      const { blob, index, start, end } = this.lastChunk;
      try {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `字幕助手-第${index}块-${start.toFixed(0)}s到${end.toFixed(0)}s.webm`;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          anchor.remove();
        }, 3000);
        this.overlay?.setStatus(
          `已保存第 ${index} 块音频（${(blob.size / 1024).toFixed(0)}KB）。` +
            '请用播放器打开听一下：能听到讲课声音 = 音频没问题，问题在识别服务；听不到 = 采集到的确实是静音。'
        );
        this.info(`已导出第 ${index} 块音频，${blob.size} 字节`);
      } catch (err) {
        this.notify(`保存音频失败：${(err && err.message) || err}`, 'err');
      }
    }

    notify(message, level) {
      if (this.overlay) {
        this.overlay.setStatus(message, level);
        this.overlay.toast(message, 9000);
      } else {
        console.warn(LOG_PREFIX, message);
      }
    }

    async openSettings() {
      const response = await this.send({ type: 'zimu:open-options' });
      if (response && response.ok) return;
      const url = chrome.runtime.getURL('popup/popup.html?tab=settings');
      window.open(url, '_blank', 'width=460,height=620');
    }

    async exportSRT() {
      if (!this.track || !this.track.segments.length) {
        this.notify('还没有可导出的字幕。', 'warn');
        return;
      }
      const content = NS.toSRT(this.track.segments);
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const name = `${sanitizeFileName(document.title || '字幕')}.srt`;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        anchor.remove();
      }, 2000);
      this.overlay?.toast(`已导出 ${this.track.segments.length} 条字幕：${name}`);
    }

    async copyTranscript() {
      if (!this.track || !this.track.segments.length) {
        this.notify('还没有可复制的字幕。', 'warn');
        return;
      }
      const text = NS.toPlainText(this.track.segments);
      try {
        await navigator.clipboard.writeText(text);
        this.overlay?.toast(`已复制全文（${text.length} 字）`);
      } catch (err) {
        this.overlay?.toast('复制失败，浏览器拒绝了剪贴板访问。');
      }
    }

    clearTranscript() {
      this.track?.reset();
      this.resetCatchUp();
      this.show('');
      this.overlay?.setStatus('已清空当前字幕。');
    }

    /**
     * 用户点“诊断”时运行。
     *
     * 目的很实际：采集失败时浏览器只会给一句没头没尾的报错，
     * 用户在聊天里也很难把情况描述准确。这里直接把结论和原始数据一起打出来，
     * 用户复制一段文字，问题就能被准确定位。
     */
    async runDiagnose() {
      if (!this.overlay) return;
      const video = this.video && this.video.isConnected ? this.video : this.findVideo();
      this.video = video || this.video;
      if (!video) {
        this.overlay.setStatus('页面上没找到视频，无法诊断。', 'err');
        return;
      }

      /* 暂停的视频不产生音频数据，这时测出来的结果会误导人
       * （指定格式报 NotSupportedError、不带格式录出 0 字节，看着像格式问题）。
       * 所以先尝试自动播放再测；播放不了就如实说明结果不可信。 */
      let autoPlayed = false;
      if (video.paused) {
        this.overlay.setStatus('视频是暂停的，先帮你播放再诊断…');
        try {
          await video.play();
          autoPlayed = true;
          // 给解码器一点时间真正开始出音频
          await new Promise((resolve) => setTimeout(resolve, 600));
        } catch (err) {
          this.log('自动播放失败，诊断结果可能不准：', err && err.message);
        }
      }

      this.overlay.setStatus('正在诊断音频采集链路，约需 2 秒…');
      try {
        const report = await NS.diagnoseMedia(video);
        // 自动播放过就把“暂停”标记去掉，避免结论被误导向暂停
        if (autoPlayed && !video.paused) report.paused = false;
        const text = NS.explainDiagnosis(report);
        this.overlay.showDiagnosis(text);
        const conclusion = text.split('\n').find((line) => line.includes('【结论】')) || '诊断完成';
        this.overlay.setStatus(conclusion.replace('【结论】', ''), 'warn');
        this.log('诊断报告\n' + text);
      } catch (err) {
        this.overlay.setStatus(`诊断失败：${(err && err.message) || err}`, 'err');
      }
    }

    async destroy() {
      await this.stop('页面卸载');
      this.overlay?.destroy();
      this.overlay = null;
    }
  }

  /**
   * 生成一个流式识别的会话标识。
   *
   * 只要在同一台机器上不重名即可，不需要密码学强度——它只是服务端用来
   * 区分「哪一段连续音频的缓冲」的键。
   */
  function newSessionId() {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function formatClock(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function sanitizeFileName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '字幕';
  }

  const controller = new Controller();
  NS.controller = controller;

  /**
   * Console 诊断入口：在视频页面按 F12 输入 __ZIMU__.inspect()
   *
   * 用途很具体：当“识别成功、字幕条数在涨，但画面上看不到字幕”时，
   * 需要立刻分清是“字幕文本没有尺寸”“被隐藏了”还是“渲染到了视频外面”。
   * 这三种原因的修法完全不同，而这一条命令能直接给出答案。
   */
  NS.inspect = () => {
    const lines = [];
    lines.push('===== 字幕助手 · 显示诊断 =====');
    lines.push(`识别状态：${controller.running ? '进行中' : '已停止'}`);
    lines.push(`字幕条数：${controller.track ? controller.track.segments.length : 0}`);
    lines.push(`当前显示文本：${controller.lastShownText || '(空)'}`);
    /* 逐字显示时屏幕上是一句话的前半截，这里说明一下，
     * 免得用户看到"当前显示文本"比字幕条数里的内容短，以为又漏字了。 */
    lines.push(
      `逐字显示：${controller.typewriterEnabled ? '开' : '关'}` +
        (controller.reveal && controller.reveal.shown < (controller.reveal.full || '').length
          ? `（正在放字：${controller.reveal.shown}/${(controller.reveal.full || '').length}）`
          : '')
    );
    /* 这个数字直接反映“识别落后了多少”：持续不为 0 说明识别跟不上播放，
     * 字幕正在补显历史内容，此时调小分块秒数或降倍速才有用。 */
    lines.push(
      `待补显字幕：${controller.catchUpQueue.length} 条` +
        (controller.catchUpQueue.length > 0 ? '（识别落后于播放，正在按顺序补显）' : '')
    );
    /* 屏幕上这句到底比画面慢多少——用户最直观的疑问就是“为什么字幕对不上话音”。
     * 队列为空时这个数字同样有意义：此时显示的通常是“最新一条并按住”，
     * 落后量就是识别本身的延迟。 */
    const queue = controller.catchUpQueue;
    const newestSeg = queue.length ? queue[queue.length - 1] : controller.currentSegment;
    const screenLagSec =
      newestSeg && controller.video
        ? Math.max(0, controller.video.currentTime - (newestSeg.end || 0))
        : 0;
    lines.push(
      `屏幕字幕落后约：${screenLagSec.toFixed(1)}s` +
        `（上限 ${(controller.maxLagSeconds || 6).toFixed(0)}s，超过即跳过历史、直接对齐最新）`
    );
    /* 采集空档是“输不全”里最难自查的一种——日志里连“第 N 块”都不会出现。
     * 这里直接给出处数，有就一定是缺内容，不是识别质量问题。 */
    const holes = (controller.capturer && controller.capturer.coverageHoles) || [];
    lines.push(
      `采集空档：${holes.length} 处` +
        (holes.length
          ? `（${holes.map((h) => `${h.start}s→${h.end}s`).join('，')} 的音频没被录到，字幕里必然缺内容）`
          : '（未发现音频采集中断）')
    );
    lines.push('');
    if (controller.overlay) {
      lines.push(controller.overlay.inspect());
    } else {
      lines.push('叠加层尚未创建（可能页面上没找到视频）');
    }
    const text = lines.join('\n');
    console.log(text);
    if (controller.overlay) controller.overlay.showDiagnosis(text);
    return text;
  };

  // 供 background 或插件图标主动唤起
  NS.activate = () => controller.toggle();

  /* 主动唤起用的消息处理。
   *
   * 为什么需要它：自动探测依赖“页面上能找到一个像样的 video 元素”，
   * 而教学平台的播放器可能是异步插入的、在特殊 iframe 里、或尺寸异常。
   * 一旦探测失败，用户看到的就是“插件好像没生效”却毫无反馈。
   * 有了这个入口，用户可以随时从插件图标手动唤出面板，不再完全依赖自动探测。 */
  NS.commands = {
    activate: () => controller.toggle(),
    // tryAutoAttach 定义在文件后面，所以这里必须惰性调用，不能直接取引用
    retryAttach: () => NS.retryAttach(),
    inspect: () => NS.inspect(),
    status: () => ({
      hasOverlay: Boolean(controller.overlay),
      videoFound: Boolean(controller.findVideo()),
      running: controller.running,
      settingsLoaded: Boolean(controller.settings),
      extensionAlive: controller.isExtensionAlive()
    })
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'content') return false;
    const command = NS.commands[message.command];
    if (!command) return false;
    try {
      const result = command();
      sendResponse({ ok: true, result: typeof result === 'object' && result ? result : undefined });
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
    return false;
  });

  // 页面里的快捷键：Alt+Shift+Z 开关字幕
  window.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && (event.key === 'Z' || event.key === 'z')) {
      event.preventDefault();
      controller.toggle();
    }
  });

  /**
   * 自动探测视频并挂上悬浮按钮，并且**长期保持可用**。
   *
   * 这里先后踩过三个坑，现在的写法是它们的综合结果：
   *
   *  1. 原来等 window 的 load 事件才探测。教学平台资源多，load 可能几十秒
   *     才触发，甚至一直不触发，表现为“插件装了但页面上什么都没有”。
   *  2. 原来只探测一次，没找到就放弃。而视频常常是异步插进 DOM 的。
   *  3. 原来一旦 controller.overlay 有值就提前返回，于是悬浮球一旦被页面
   *     移除（或上下文失效后重建失败），就**再也不会恢复**。用户看到的现象
   *     就是“悬浮球消失了，没法继续测试”。
   *
   * 所以现在：立即探测 + 长期定时巡检 + 监听播放元数据 + 监听 DOM 变化，
   * 而且每次巡检检查的是“叠加层是否真的还挂在文档里”，不在就重建。
   */
  let attachAttempts = 0;
  let attachTimer = null;

  /** 用户是否明确关掉了悬浮按钮。关掉了就不该硬塞，也不该反复巡检。 */
  const shouldShowButton = () => {
    const settings = NS.controller.settings;
    if (!settings) return true; // 还没读到配置，先按默认显示
    return settings.showFloatingButton !== false;
  };

  const tryAutoAttach = async () => {
    if (!NS.controller.isExtensionAlive()) {
      // 上下文失效：不能凭空重建，但要保住已有节点并提示刷新
      NS.controller.handleContextLost();
      return Boolean(NS.controller.overlay);
    }

    /* 这里必须强制重新读取配置（force=true），不能吃缓存。
     *
     * 原因很实际：用户会切到设置页改配置再切回来（比如关掉悬浮按钮、
     * 调整字号）。ensureSettings() 平时带缓存是为了省事，但巡检如果也吃缓存，
     * 用户新改的设置就得等页面刷新才生效——表现就是“我明明改了，它还是老样子”。
     * 巡检频率很低（1.5~8 秒一次），每次读一下扩展存储的代价可以忽略。 */
    await NS.controller.ensureSettings(true);
    if (!shouldShowButton()) return true;

    const overlay = NS.controller.attachOverlay();
    if (!overlay) return false;

    // 首次安装时把面板展开一次，告诉用户下一步该做什么
    const stored = await chrome.storage.session.get('installHint').catch(() => ({}));
    if (stored && stored.installHint) {
      overlay.openCard();
      overlay.setStatus('已就绪。确认设置里的识别服务可用后，点“开启字幕”。');
      chrome.storage.session.remove('installHint').catch(() => {});
    }
    return true;
  };

  /** 长期巡检：1.5 秒一次起步，跑久了自动放缓，避免白耗电。 */
  let attachStopped = false;
  let diagnosticLogged = 0;

  const scheduleAttachRetry = () => {
    if (attachTimer) return;
    const tick = async () => {
      attachTimer = null;
      if (attachStopped) return;
      attachAttempts++;
      let ok = false;
      try {
        ok = await tryAutoAttach();
      } catch (err) {
        console.warn(LOG_PREFIX, '自动挂载出错', err);
      }

      /* 一直挂不上时，定期把“卡在哪一步”打到 Console。
       * 否则用户面对的现象只有“插件没反应”，既无法自查也无法反馈。
       * 只打前几次，避免刷屏。 */
      if (!ok && diagnosticLogged < 3 && attachAttempts % 4 === 0) {
        diagnosticLogged++;
        const alive = NS.controller.isExtensionAlive();
        const video = NS.controller.findVideo();
        console.warn(
          `${LOG_PREFIX} 面板尚未挂上（第 ${attachAttempts} 次尝试）：` +
            `扩展连接=${alive ? '正常' : '已失效'}，` +
            `页面上的 video 元素=${video ? '找到 1 个' : '没找到'}。` +
            (video
              ? ''
              : '请先把视频播放起来；若播放中仍找不到，说明该平台用的是特殊播放器。')
        );
      }

      if (attachStopped) return;
      /* 巡检节奏：
       *  - 还没找到视频：1.5 秒后重试，超过 40 次放宽到 5 秒（等平台慢慢加载播放器）
       *  - 已挂上：放宽到 8 秒做低频看护，只在节点真被删掉时才重建
       * 这样既能在播放器晚出现时快速接上，又不会长期高频打扰页面。 */
      const interval = ok ? 8000 : attachAttempts > 40 ? 5000 : 1500;
      attachTimer = setTimeout(tick, interval);
    };
    attachTimer = setTimeout(tick, 1500);
  };

  /** 供测试与页面卸载使用：彻底停掉巡检，避免留下悬挂的定时器。 */
  const stopAttachRetry = () => {
    attachStopped = true;
    if (attachTimer) {
      clearTimeout(attachTimer);
      attachTimer = null;
    }
  };
  NS.stopAttachRetry = stopAttachRetry;

  /** 手动重试一次挂载（供插件图标唤起时使用）。 */
  NS.retryAttach = async () => {
    try {
      const ok = await tryAutoAttach();
      return { attached: Boolean(ok), status: NS.commands.status() };
    } catch (err) {
      return { attached: false, error: (err && err.message) || String(err) };
    }
  };

  // 1) 立即试一次（document_idle 时 DOM 已就绪，多数页面这一步就够了）
  tryAutoAttach()
    .catch((err) => console.warn(LOG_PREFIX, '首次自动挂载出错', err))
    .finally(() => scheduleAttachRetry());

  // 2) 视频是异步插入的：DOM 一变就再试一次（低频，避免影响页面性能）
  try {
    let mutationPending = false;
    const observer = new MutationObserver(() => {
      if (mutationPending) return;
      mutationPending = true;
      setTimeout(() => {
        mutationPending = false;
        tryAutoAttach().catch(() => {});
      }, 300);
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (err) {
    console.warn(LOG_PREFIX, '无法监听 DOM 变化，将只依赖定时巡检', err);
  }

  // 3) 播放器拿到元数据时再试一次最稳
  document.addEventListener(
    'loadedmetadata',
    () => {
      tryAutoAttach().catch(() => {});
    },
    true
  );

  // 4) 从后台标签页切回来时立刻检查一次：用户很可能刚去改了扩展设置
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tryAutoAttach().catch(() => {});
  });

  // 5) 页面卸载时停掉巡检，不留悬挂定时器
  window.addEventListener('pagehide', stopAttachRetry);
})();
