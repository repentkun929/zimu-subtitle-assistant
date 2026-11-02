/**
 * 音频采集：把 <video> 的声音按“视频时间轴”切成一块块，交给上层去识别。
 *
 * 为什么用 captureStream() + 逐块 MediaRecorder，而不是 Web Audio 抓 PCM：
 *  - PCM 转 WAV 要自己接 AudioWorklet、做重采样，代码量和坑都多；
 *  - MediaRecorder 每个新实例会重新写容器头，所以“每块单独 start/stop”
 *    产出的就是能直接上传的独立音频文件，Opus 体积还小得多。
 *
 * 为什么时间戳不靠“累积秒数”而靠 video.currentTime：
 *  - 用户暂停时音频也停了，累积秒数会和视频对不上；
 *  - 用户拖进度条时，累积秒数会彻底错位。用 currentTime 则天然对齐，
 *    并且能识别出“这一块里发生了跳转”，直接丢弃这块脏音频。
 */
(function () {
  const NS = (globalThis.__ZIMU__ = globalThis.__ZIMU__ || {});

  const MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const type of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  /**
   * 构建一组“待尝试的录音参数”，按优先级从具体到宽松。
   *
   * 为什么不能只用 pickMimeType() 挑一个：
   * isTypeSupported() 只回答“理论上支持这个容器”，它**不保证**这台机器上
   * 真的能录。真实场景里 { mimeType, audioBitsPerSecond } 组合会让
   * MediaRecorder.start() 抛 NotSupportedError，而逐个去掉约束就能录成功
   * （用户实测遇到的就是这个）。所以这里给出一串备选，由会话逐个实测。
   */
  function buildRecorderOptions() {
    const options = [];
    const supported = MIME_CANDIDATES.filter(
      (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)
    );
    for (const mimeType of supported) {
      options.push({ mimeType, audioBitsPerSecond: 64000 });
      options.push({ mimeType });
    }
    // 最后无论如何都试一次“不带任何约束”：把选择权完全交给浏览器。
    // 很多 NotSupportedError 到这一步就消失了。
    options.push({});
    return options;
  }

  /** 给一组参数起个短名字，用于日志和诊断输出。 */
  function describeRecorderOptions(options) {
    if (!options) return '浏览器默认';
    const parts = [];
    if (options.mimeType) parts.push(options.mimeType);
    if (options.audioBitsPerSecond) parts.push(`${Math.round(options.audioBitsPerSecond / 1000)}kbps`);
    return parts.length ? parts.join(' @ ') : '浏览器默认';
  }

  class AudioChunkCapturer {
    /**
     * @param {HTMLMediaElement} media
     * @param {{
     *   chunkSeconds: number,
     *   overlapSeconds: number,
     *   onChunk: (chunk: {blob: Blob, start: number, end: number, index: number}) => void,
     *   onStatus: (status: {state: string, message?: string}) => void,
     *   log: (...args: any[]) => void
     * }} options
     */
    constructor(media, options) {
      this.media = media;
      /**
       * 每个窗口录多少秒音频。
       *
       * 下限放到 1 秒是为了流式模式：它要每 1~2 秒连续投喂，窗口必须能开得这么短。
       * 分段模式下的下限由设置侧保证（settings.js 把 chunkSeconds 钳在 ≥4），
       * 所以放宽这里不会让分段模式意外跑出小窗口。
       */
      this.chunkSeconds = Math.max(1, options.chunkSeconds || 12);
      this.overlapSeconds = Math.max(0, Math.min(5, options.overlapSeconds || 0));
      this.onChunk = options.onChunk || (() => {});
      this.onStatus = options.onStatus || (() => {});
      this.log = options.log || (() => {});

      this.mimeType = pickMimeType();
      this.stream = null;
      this.state = 'idle';
      this.chunkIndex = 0;
      this.sessions = [];
      this.stopRequested = false;
      /**
       * 下一个窗口应当开始录制的**媒体时刻**（video.currentTime，单位秒），
       * 不是墙钟毫秒。理由见 scheduleTick()：配置里 chunkSeconds 的语义是
       * “每块多少秒音频”，用墙钟计时会在倍速播放下彻底失真。
       */
      this.nextWindowMediaAt = 0;
      this.schedulerTimer = null;
      /** 待尝试的录音参数组合，按优先级排列 */
      this.candidateOptions = buildRecorderOptions();
      /** 已确认不可用的组合（用描述串标识），下次自动跳过 */
      this.blockedOptions = new Set();
      /** 当前正在使用的组合，用于日志 */
      this.activeOptions = null;
      /** 当前音频来源模式：element（视频元素）或 tab（整个标签页） */
      this.sourceMode = options.sourceMode || 'element';
      /** 连续出现“录了却 0 字节”的块数，用于判断流里是否根本没有音频数据 */
      this.emptyChunkCount = 0;
      /** 上一次巡检的墙钟时刻，用来发现“定时器被节流 / 主线程被占” */
      this.lastTickAt = 0;
      /** 巡检回调只绑定一次，避免反复 add/remove 造成监听泄漏 */
      this.boundOnMediaProgress = () => this.onMediaProgress();
      /**
       * 采集空档记录：`{start, end}` 的媒体时间区间。
       * 空档里的音频**从来没有被录下来**，是“字幕输不全”的硬伤，
       * 必须能被数量化地报出来，而不是让用户凭感觉说“少了几句”。
       */
      this.coverageHoles = [];
      /** 上一次确认“有窗口在录”时的媒体时刻，用来发现空档 */
      this.lastCoveredMedia = null;
    }

    /** 每次开会话前重算候选列表：跳过已确认不可用的组合。 */
    get usableOptions() {
      const usable = this.candidateOptions.filter(
        (options) => !this.blockedOptions.has(describeRecorderOptions(options))
      );
      // 兜底：全都失败过也要留一个，否则永远不会再尝试
      return usable.length ? usable : [{}];
    }

    /** 只检查浏览器能力；音轨是否存在要等真正拿到流才知道。 */
    get supported() {
      return typeof MediaRecorder !== 'undefined';
    }

    /**
     * 运行中调整分块长度。
     *
     * **为什么必须有这个方法**：流式切片（约 1.6s）和分段分块（默认 6s）
     * 共用同一个采集器，而「这台服务到底支不支持流式」要**发出第一片之后**
     * 才由后台判定。如果降级时只把 streamActive 置 false、却不改采集窗口，
     * 整个会话就会继续以 1.6 秒一块跑下去——每 1.6 秒把一句话从中间切断
     * 送去识别，错字、漏字会成倍增加（用户实测日志里就是这个现象）。
     *
     * 只影响**之后**的窗口：已经开着的那个会按新长度收尾，
     * 多出一块过渡块无妨，不会产生采集空档。
     *
     * @returns {boolean} 是否真的改了（没变则返回 false，便于调用方少打一行日志）
     */
    setChunking({ chunkSeconds, overlapSeconds } = {}) {
      const nextChunk =
        Number.isFinite(chunkSeconds) && chunkSeconds > 0 ? Math.max(1, chunkSeconds) : this.chunkSeconds;
      const nextOverlap = Number.isFinite(overlapSeconds)
        ? Math.max(0, Math.min(5, overlapSeconds))
        : this.overlapSeconds;

      if (nextChunk === this.chunkSeconds && nextOverlap === this.overlapSeconds) return false;

      this.log(
        `分块长度改为每块 ${nextChunk}s 音频（重叠 ${nextOverlap}s），` +
          `原来 ${this.chunkSeconds}s/${this.overlapSeconds}s`
      );
      this.chunkSeconds = nextChunk;
      this.overlapSeconds = nextOverlap;
      return true;
    }

    /**
     * 开始采集。
     *
     * 流从哪里来由上层决定（元素模式或标签页模式，见 audio-source.js），
     * 这里只负责“拿到流之后按时切块”。之所以不让采集器自己去取流：
     * 元素模式可能失败并需要降级，那个决策属于上层策略，不属于分块逻辑。
     *
     * @param {MediaStream} stream
     * @param {{mode?: string}} [info]
     */
    start(stream, info = {}) {
      if (this.state === 'recording') return;
      if (!this.supported) {
        this.setState('unsupported', '当前浏览器不支持 MediaRecorder，建议用 Chrome 或 Edge 116 以上版本。');
        return;
      }
      if (!window.isSecureContext) {
        this.log('当前页面不是安全上下文（https 或 localhost），浏览器可能限制音频采集');
      }

      this.stream = stream || null;
      this.sourceMode = info.mode || 'element';
      if (!this.stream) {
        this.setState('error', '没有拿到可用的音频流。');
        return;
      }

      const audioTracks = this.stream.getAudioTracks();
      if (!audioTracks.length) {
        this.setState('error', '这个音频流里没有音轨。');
        this.releaseStream();
        return;
      }

      this.stream.addEventListener('inactive', () => {
        this.log('音频流已失效');
        if (this.state === 'recording') this.stop('stream-inactive');
      });

      this.chunkIndex = 0;
      this.sessions = [];
      this.coverageHoles = [];
      this.lastCoveredMedia = null;
      this.setState('recording');
      this.nextWindowMediaAt = this.currentTime();

      /* 把播放倍速记下来。
       * 这一行是为了定位一类问题：倍速播放时，同样长的墙钟时间里流过的是
       * 成倍的音频，识别负载跟着翻倍。以前窗口按墙钟计时，日志里只看到
       * “一块覆盖了 12.9 秒”却不知道为什么，只能靠猜。 */
      const rate = Number(this.media && this.media.playbackRate);
      if (Number.isFinite(rate) && rate !== 1) {
        this.log(`当前播放倍速 ${rate}x：每块仍然是 ${this.chunkSeconds} 秒音频，但请求会更密集`);
      }

      /* 把生效的分块参数打出来。
       * 这一行是定位“字幕太慢”的第一手证据：日志里若写着 12 秒，而用户以为
       * 设的是 6 秒，那问题根本不在识别速度，而在设置本身。 */
      this.log(
        `分块设置：每块 ${this.chunkSeconds}s 音频，重叠 ${this.overlapSeconds}s` +
          `（每块的「音频 X.Xs」应稳定接近 ${this.chunkSeconds}s，明显超出即为异常）`
      );

      /* 额外挂一条“媒体推进”巡检。
       * 窗口开合原本只靠 setTimeout，而页面主线程一旦被占（重页面、长任务、
       * 浏览器节流），定时器会被推迟好几秒——一个 6 秒的窗口能录成 12 秒，
       * 识别负载凭空翻倍、字幕更迟。timeupdate 由媒体管线驱动，和 setTimeout
       * 是两条独立的触发路径，多一条就少一次被拖长。 */
      if (this.media && typeof this.media.addEventListener === 'function') {
        this.media.removeEventListener('timeupdate', this.boundOnMediaProgress);
        this.media.addEventListener('timeupdate', this.boundOnMediaProgress);
      }

      /* 关键：视频暂停时绝对不能开录音。
       *
       * 暂停的视频不产生任何音频数据，此时启动 MediaRecorder 会出现两种结果，
       * 而且都很难懂：
       *   · 显式指定 webm 格式时 start() 抛 NotSupportedError（看起来像格式不支持）
       *   · 不带格式时能启动，但录出来是 0 字节（后台报“音频数据无效或为空”）
       * 两种现象的根因都是“流里根本没有音频在流动”。用户实测撞上的就是这个。
       *
       * 所以暂停时先不开窗口，等 play 事件来了再开。 */
      if (this.media.paused) {
        this.log('视频处于暂停状态，先不录音；等播放开始后再开窗口');
        this.setState('recording'); // 状态仍是“进行中”，只是暂时没有数据
        this.onStatus({ state: 'waiting-play' });
        this.scheduleTick();
        return;
      }

      this.scheduleTick();
    }

    /** 视频开始播放：如果之前因为暂停而没开窗口，现在补上。 */
    resumeIfWaiting() {
      if (this.state !== 'recording') return;
      if (this.media.paused) return;
      if (this.sessions.length) return;
      this.nextWindowMediaAt = this.currentTime();
      this.log('视频开始播放，开始分块采集');
    }

    /**
     * 用定时器按时开新窗口。
     *
     * 计时基准是 **video.currentTime（媒体时间），不是墙钟**。
     *
     * 为什么必须这样：配置里 `chunkSeconds` 的语义是“每块包含多少秒音频”。
     * 按墙钟计时时，用户一开倍速就全乱了——实测日志里 4 秒的窗口装进了
     * 12.9 秒音频（约 2 倍速），于是每块的识别负载凭空翻倍、分块节奏与音频
     * 长度脱钩；更糟的是页面主线程一卡，`setTimeout` 被推迟，追赶逻辑
     * （`if (nextWindowAt <= t) nextWindowAt = t + chunkSeconds`）会直接
     * **跳过中间若干个窗口**，那几秒音频从来没有被录下来——字幕里就永久缺一段。
     *
     * 换成媒体时间之后：暂停不产生窗口、拖进度立刻生效、倍速下每块依旧是
     * chunkSeconds 秒音频，行为与配置的字面含义一致。
     */
    scheduleTick() {
      if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
      if (this.state !== 'recording') return;

      const run = () => {
        if (this.state !== 'recording') return;
        const tickAt = now();
        /* 节拍被拖长就把原因点出来。
         * 巡检本该 200ms 一次；超过 1.2s 说明主线程被占或定时器被浏览器
         * 节流——这正是“块被录长、识别变慢、字幕更迟”的根因，必须能看见，
         * 否则只能对着一个 12 秒的块猜。 */
        if (this.lastTickAt && !this.media.paused && tickAt - this.lastTickAt > 1200) {
          this.log(
            `⚠ 分块节拍被推迟 ${((tickAt - this.lastTickAt) / 1000).toFixed(1)}s` +
              '（页面主线程繁忙或定时器被节流），这一个块可能会被录长'
          );
        }
        this.lastTickAt = tickAt;
        this.onMediaProgress();
        /* 固定节拍巡检。不能用“距离下个窗口还有多久”来算等待时间：
         * 那个差值现在以媒体秒为单位，而 setTimeout 收的是毫秒。 */
        this.schedulerTimer = setTimeout(run, this.media.paused ? 500 : 200);
      };
      run();
    }

    /**
     * 检查一次“要不要开新窗口 / 要不要关掉到点的窗口”。
     *
     * 由两条路径调用，互为备份：
     *   · scheduleTick 的定时巡检（200ms 一次）
     *   · 视频的 timeupdate 事件（媒体管线驱动）
     * 任一条被推迟，另一条仍能按媒体时间把窗口收住。
     *
     * 重复调用是安全的：开窗后 nextWindowMediaAt 会前移，不会重复开；
     * 关窗有 closing 标志保护，不会重复关。
     */
    onMediaProgress() {
      if (this.state !== 'recording') return;
      if (this.media.paused) return;
      const mediaTime = this.currentTime();
      if (!Number.isFinite(this.nextWindowMediaAt)) this.nextWindowMediaAt = mediaTime;

      /* 覆盖不变式：视频在播的时候，任何一刻都必须有窗口在录。
       *
       * 为什么单独立一条：窗口只在“巡检跑起来”时才开。页面主线程一旦被占
       * （重页面、长任务）或定时器被节流，巡检就停了；正在录的窗口到点又被
       * 关掉，于是出现一段**没有任何人在录**的空档——那段音频从未被录下来，
       * 识别再准也补不回来。用户看到的正是“视频里的语言没有被完整表达出来”。
       * 实测日志里就能看到：第 0 块结束于 896.9s，下一块却从 908.2s 才开始，
       * 中间的 11.3 秒是空白。 */
      if (!this.sessions.length) {
        if (this.lastCoveredMedia !== null && mediaTime - this.lastCoveredMedia > 1.5) {
          this.recordCoverageHole(this.lastCoveredMedia, mediaTime);
        }
        this.openSession();
        this.nextWindowMediaAt = mediaTime + (this.chunkSeconds - this.overlapSeconds);
      } else if (mediaTime >= this.nextWindowMediaAt) {
        // 到点开下一块，提前 overlapSeconds 开始，跨块断句才有机会被完整识别
        this.openSession();
        this.nextWindowMediaAt = mediaTime + (this.chunkSeconds - this.overlapSeconds);
      }

      this.lastCoveredMedia = mediaTime;
      this.closeDueSessions(mediaTime);
    }

    /** 记下一次“没人录音”的空档，并如实报出来。 */
    recordCoverageHole(startMedia, endMedia) {
      const hole = { start: round2(startMedia), end: round2(endMedia) };
      this.coverageHoles.push(hole);
      this.log(
        `⚠ 采集空档 ${hole.start}s → ${hole.end}s（${(hole.end - hole.start).toFixed(1)}s 音频没被录到）。` +
          '这段内容不会出现在字幕里——通常是分块节拍被推迟，检查页面是否在跑耗时任务'
      );
      this.onStatus({ state: 'coverage-hole', message: '检测到音频采集空档', hole });
    }

    /**
     * 开一个录音窗口。
     *
     * 为什么用“每块各开一个 MediaRecorder”而不是一个大录音器切字节：
     * 每个 MediaRecorder 都会重新写容器头，所以每块都是能直接上传的完整文件；
     * 而从一个大录音器中间截出来的字节流不是合法容器，服务端会解不开。
     */
    openSession() {
      if (!this.stream) return;
      const session = {
        parts: [],
        startedAt: now(),
        mediaStart: this.currentTime(),
        recorder: null,
        /** 本会话的起止媒体时间；重试启动时要重新取值，否则时间会偏 */
        mediaEnd: undefined,
        closing: false,
        /** “到点必关”的保险定时器句柄，见 armSessionDeadline */
        deadlineTimer: null
      };

      /* 逐个试参数组合，选第一个能真正 start() 成功的。
       *
       * 关键点：失败要重试，而不是直接放弃整段字幕。
       * isTypeSupported() 说支持、start() 却抛 NotSupportedError 是真实存在的，
       * 而且用户实测就撞上了。每失败一次就换下一个组合，最差也会试到
       * “不带任何约束”，把选择权交回浏览器。 */
      const options = this.usableOptions;
      let lastError = null;

      for (let i = 0; i < options.length; i++) {
        const candidate = options[i];
        let recorder;
        try {
          recorder = new MediaRecorder(this.stream, candidate);
        } catch (err) {
          lastError = err;
          this.log(`录音参数 ${describeRecorderOptions(candidate)} 构造失败：${err && err.name}`);
          continue;
        }

        // 每换一次参数都要重新挂监听，避免上一次失败的监听影响计数
        session.parts = [];
        const onData = (event) => {
          if (event.data && event.data.size > 0) session.parts.push(event.data);
        };
        const onStop = () => this.finalizeSession(session);
        recorder.addEventListener('dataavailable', onData);
        recorder.addEventListener('stop', onStop);
        recorder.addEventListener('error', (event) => {
          // 异步失败：把该组合标记为不可用，下次不再尝试
          const failed = event.error || {};
          this.blockedOptions.add(describeRecorderOptions(candidate));
          this.log(`录音器异步报错（${failed.name || 'Error'}）：${failed.message || ''}`);
          this.setState('error', `录音出错：${failed.name || ''} ${failed.message || ''}`.trim());
        });

        try {
          recorder.start();
        } catch (err) {
          lastError = err;
          // 启动失败：摘掉监听，换下一个组合重试
          recorder.removeEventListener('dataavailable', onData);
          recorder.removeEventListener('stop', onStop);
          this.blockedOptions.add(describeRecorderOptions(candidate));
          this.log(
            `录音参数 ${describeRecorderOptions(candidate)} 启动失败：${(err && err.name) || 'Error'}，尝试下一个`
          );
          continue;
        }

        // 成功
        session.recorder = recorder;
        this.activeOptions = candidate;
        if (i > 0) {
          this.log(`录音参数自动切换为：${describeRecorderOptions(candidate)}`);
          this.setState('recording');
        }
        this.sessions.push(session);
        this.armSessionDeadline(session);
        return;
      }

      this.reportStartFailure(lastError);
    }

    /**
     * 给一个窗口上“到点必关”的保险。
     *
     * 正常关窗靠定时巡检（closeDueSessions），但巡检本身是 setTimeout，
     * 页面主线程一忙就会被推迟——实测能把 6 秒的窗口录成 12 秒，识别耗时
     * 跟着翻倍、字幕更迟。这里再排一个**独立的**定时器，按播放倍速把
     * “媒体秒”换算成墙钟毫秒；两条触发路径任一条生效，窗口就不会被拖长。
     */
    armSessionDeadline(session) {
      if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
      const rate = Math.max(0.25, Number(this.media && this.media.playbackRate) || 1);
      // 目标墙钟时长 = 音频秒数 ÷ 倍速；再留 500ms 余量，避免比巡检更早触发
      const budgetMs = (this.chunkSeconds / rate) * 1000 + 500;
      session.deadlineTimer = setTimeout(() => {
        session.deadlineTimer = null;
        // 走同一个“覆盖不变式”关口：绝不关掉最后一个窗口
        this.closeSessionIfCovered(session, this.currentTime());
      }, budgetMs);
    }

    /**
     * 所有参数组合都启动失败时才走这里。
     * 报错里必须带上音轨状态和安全上下文——否则用户拿到的只是一句
     * “There was an error starting the MediaRecorder”，完全没法定位。
     */
    reportStartFailure(err) {
      const tracks = this.stream ? this.stream.getAudioTracks() : [];
      const detail =
        tracks
          .map((track) => `${track.label || 'audio'}(muted=${track.muted}, state=${track.readyState})`)
          .join('; ') || '没有音轨';
      this.setState(
        'error',
        `启动录音失败：${(err && err.name) || 'Error'} ${(err && err.message) || err}。` +
          `已尝试全部参数组合（${this.candidateOptions.length} 种）均不可用。` +
          `音轨：${detail}。安全上下文：${window.isSecureContext ? '是' : '否'}。` +
          '点“诊断”按钮可查看具体原因。'
      );    }

    /**
     * 关掉已经录够时长的窗口。可能同时有多个窗口在录，这是重叠设计的必然结果。
     *
     * 关闭判据是**媒体时间**走了 chunkSeconds 秒，不是墙钟过了几秒——
     * 倍速播放和卡顿都会让两者脱钩（见 scheduleTick）。
     *
     * 另有一条墙钟兜底：视频卡住（缓冲、播放器内部停顿）时 currentTime 不推进，
     * 单靠媒体时间这个窗口会永远开着、永远不产出字幕。超过合理时长就强制关掉，
     * 由 finalizeSession 按“几乎没录到东西”处理掉。
     */
    closeDueSessions(mediaTime) {
      const t = typeof mediaTime === 'number' ? mediaTime : this.currentTime();
      const wallNow = now();
      const wallLimitMs = Math.max(this.chunkSeconds * 2.5, 10) * 1000;
      for (const session of this.sessions) {
        if (session.closing) continue;
        const startedAtMedia = Number.isFinite(session.mediaStart) ? session.mediaStart : t;
        const mediaElapsed = t - startedAtMedia;
        const stalled = wallNow - session.startedAt > wallLimitMs;
        if (mediaElapsed < this.chunkSeconds && !stalled) continue;
        if (this.closeSessionIfCovered(session, t)) {
          if (stalled && mediaElapsed < this.chunkSeconds) {
            this.log(
              `这一块录了 ${((wallNow - session.startedAt) / 1000).toFixed(1)}s 墙钟、` +
                `视频只走了 ${mediaElapsed.toFixed(1)}s，按卡顿处理`
            );
          }
        } else if (!this.media.paused) {
          /* 关不掉是因为它是最后一个窗口。宁可让这个块录长一点（识别慢些），
           * 也不能出现没人录的空档——空档里的声音永远补不回来。 */
          this.log(
            `这一块已录到 ${mediaElapsed.toFixed(1)}s，但当前没有其它窗口在录，先不关` +
              '（关了就会漏内容）'
          );
        }
      }
    }

    /**
     * 关掉一个窗口——但**绝不关掉最后一个**。
     *
     * 覆盖不变式：视频在播时必须有窗口在录。宁可让一个块录长一点（识别慢些），
     * 也不能出现没人录的空档，因为那段音频没有留下任何副本。下一次巡检会先补开
     * 新窗口，然后把老的这个关掉。
     *
     * @returns {boolean} 是否真的关掉了
     */
    closeSessionIfCovered(session, mediaTime) {
      if (session.closing || !session.recorder) return false;
      if (this.state !== 'recording') return false;
      if (this.media.paused) return false;
      if (this.sessions.length <= 1) return false;
      session.closing = true;
      session.mediaEnd = typeof mediaTime === 'number' ? mediaTime : this.currentTime();
      session.endedAt = now();
      try {
        session.recorder.stop();
      } catch (err) {
        this.log('stop 失败', err);
      }
      return true;
    }

    /**
     * 丢掉所有正在录的窗口。
     *
     * 用途有两个：视频暂停、以及用户拖动进度条。两种情况下正在录的这段音频
     * 都不再对应一段连续的画面——留着它，时间戳会横跨暂停区间或跳转点，
     * 拼出来的字幕会张冠李戴。
     */
    dropInFlightWindows(reason) {
      const had = this.sessions.length > 0;
      for (const session of this.sessions) {
        session.closing = true;
        try {
          session.recorder.stop();
        } catch (err) {
          /* 已经停了就忽略 */
        }
      }
      this.sessions = [];
      if (had && reason) this.log(`丢掉正在录的窗口（${reason}）`);
      return had;
    }

    finalizeSession(session) {
      /* 先撤掉“到点必关”的保险，否则它可能在会话已经结束后又触发一次 stop。 */
      if (session.deadlineTimer) {
        clearTimeout(session.deadlineTimer);
        session.deadlineTimer = null;
      }
      const index = this.sessions.indexOf(session);
      if (index >= 0) this.sessions.splice(index, 1);

      const end = typeof session.mediaEnd === 'number' ? session.mediaEnd : this.currentTime();
      const start = Number.isFinite(session.mediaStart) ? session.mediaStart : end - this.chunkSeconds;
      const played = end - start;
      const blob = session.parts.length ? new Blob(session.parts, { type: this.mimeType || 'audio/webm' }) : null;
      session.parts = [];

      if (!blob || blob.size === 0) {
        /* 录了足够久却一个字节都没有——这不是“暂停”能解释的（暂停时不会开窗口），
         * 而是**这条音频流根本没有可编码的数据**。
         *
         * 注意不能因为一块就下结论：用户常在“开启字幕后才点播放”，
         * 那一块正好录在暂停期间，属于正常的空块。只有**连续**多块都空，
         * 才说明流本身有问题，这时才值得切换采集方式。 */
        if (played >= 2) {
          this.emptyChunkCount = (this.emptyChunkCount || 0) + 1;
          this.log(
            `这一块录了 ${played.toFixed(1)}s 却是 0 字节（连续第 ${this.emptyChunkCount} 块）`
          );
          if (this.sourceMode === 'element' && this.emptyChunkCount >= 3) {
            this.onStatus({
              state: 'no-audio-data',
              message:
                '连续多块都读不到音频数据（音轨正常但录不出内容）。' +
                '将改用“抓取标签页声音”的方式继续。',
              mode: this.sourceMode
            });
          }
        } else {
          this.log('这一块没有数据（可能全程暂停），跳过');
        }
      } else if (played <= 1.5) {
        this.log(`这一块只有 ${played.toFixed(2)}s，跳过`);
      } else {
        // 成功录到数据：清掉空块计数，避免把偶发的空块累积成“流有问题”的误判
        this.emptyChunkCount = 0;

        /* 体积异常检查：只录音频时 12 秒的 Opus 约 96KB（64kbps）。
         * 如果远超这个量级，说明流里混进了视频轨，或者录音参数没生效。
         * 这不只是浪费流量——带视频轨的文件送到语音识别服务会被判为
         * “没有音频内容”而返回空文本，用户看到的就是“上传成功但始终没字幕”。
         * 这个坑真实踩过（12 秒的块高达 1.4~3.4MB），所以在这里主动预警。 */
        const kbPerSecond = blob.size / 1024 / Math.max(1, played);
        if (kbPerSecond > 40) {
          this.log(`警告：这一块体积异常，${kbPerSecond.toFixed(0)}KB/s，疑似把画面也录了进去`);
          this.onStatus({
            state: 'oversized',
            message:
              `采集到的音频体积异常（${kbPerSecond.toFixed(0)}KB/s，正常应低于 20KB/s），` +
              '可能把画面一起录了进去，这会让识别服务返回空文本。',
            kbPerSecond
          });
        }

        const chunk = {
          blob,
          start: Math.max(0, start),
          end,
          index: this.chunkIndex++,
          durationSec: played
        };
        this.log(
          `第 ${chunk.index} 块：${start.toFixed(2)}s → ${end.toFixed(2)}s，` +
            `时长 ${played.toFixed(1)}s，${(blob.size / 1024).toFixed(0)}KB`
        );
        /* 块长是延迟的第一乘数：块多长，识别就大约要多久。
         * 一旦明显超出目标，直接点名原因，省掉一轮来回排查。 */
        if (played > Math.max(this.chunkSeconds * 1.25, this.chunkSeconds + 1)) {
          this.log(
            `⚠ 第 ${chunk.index} 块超长：${played.toFixed(1)}s（目标 ${this.chunkSeconds}s）。` +
              '识别耗时会随之变长——通常是刚才分块节拍被推迟了'
          );
        }
        try {
          this.onChunk(chunk);
        } catch (err) {
          this.log('onChunk 回调异常', err);
        }
      }

      if (this.stopRequested && !this.sessions.length) this.finishStop();
    }

    currentTime() {
      const t = this.media && this.media.currentTime;
      return Number.isFinite(t) ? t : 0;
    }

    /**
     * 视频暂停/恢复播放时调整采集。
     *
     * 暂停时必须**把正在录的窗口直接丢掉**，不能让它继续跑：
     * 那段时间视频没有产生音频，录出来是 0 字节，而它的时间区间还会横跨
     * 暂停前后，取出来的时间戳是错的（会得到一段很长但没有内容的字幕）。
     */
    handlePlaybackChange() {
      if (this.state !== 'recording') return;

      if (this.media.paused) {
        this.log('视频暂停，暂停期间不再切新块');
        this.dropInFlightWindows('视频暂停');
        return;
      }

      /* 恢复播放：**立刻**开始采集，不能等。
       *
       * 这里原来故意等满一个分块周期（`now() + chunkSeconds * 1000`），
       * 想法是“用户刚看完一段又回来，重新计一个完整窗口比较自然”。
       * 但代价是：**每暂停一次，音频里就多一个 chunkSeconds 长的洞**，
       * 那段时间的声音从来没有被采集过，再怎么识别也补不回来。
       * 用户看到的正是“视频里的语言没有被字幕完整表达出来”。
       *
       * 实测日志里能直接看到这个洞：第 7 块结束在 565.6s，
       * 下一块却从 578.5s 才开始——中间的 12.9 秒是空白。
       *
       * 起始窗口偏短没有关系：finalizeSession 会把不足 1.5 秒的块丢掉，
       * 后面的窗口很快会回到正常长度。宁可少一块，也不能缺一段。 */
      this.nextWindowMediaAt = this.currentTime();
      this.lastCoveredMedia = null; // 暂停期间本来就没声音，恢复后重新计覆盖
      this.log('视频恢复播放，立刻继续分块');
    }

    /**
     * 用户拖动进度条 / 换集时调用。
     *
     * 必须丢掉正在录的窗口：它的 audio 是跳转点**之前**的内容，媒体时间却
     * 会横跨到跳转点之后，拼出来的字幕会张冠李戴。丢掉之后从新位置重新开始，
     * 用户主动跳过的内容本来也不需要字幕。
     */
    handleTimelineJump() {
      if (this.state !== 'recording') return;
      // 用户主动跳过的那段本来就不需要字幕，把它算成“空档”会误导排查
      this.lastCoveredMedia = null;
      if (this.dropInFlightWindows('拖动进度')) {
        this.nextWindowMediaAt = this.currentTime();
      } else {
        this.nextWindowMediaAt = Math.min(this.nextWindowMediaAt, this.currentTime());
      }
    }

    async stop(reason) {
      this.stopRequested = true;
      this.setState('stopping', reason);
      if (this.schedulerTimer) {
        clearTimeout(this.schedulerTimer);
        this.schedulerTimer = null;
      }
      if (!this.sessions.length) {
        this.finishStop();
        return;
      }
      for (const session of this.sessions) {
        if (session.closing) continue;
        session.closing = true;
        session.mediaEnd = this.currentTime();
        try {
          session.recorder.stop();
        } catch (err) {
          this.log('收尾 stop 失败', err);
        }
      }
      // 兜底：万一某个 stop 事件没回来，别让状态永远卡在 stopping
      setTimeout(() => {
        if (this.state === 'stopping') this.finishStop();
      }, 2500);
    }

    finishStop() {
      this.sessions = [];
      if (this.media && typeof this.media.removeEventListener === 'function') {
        this.media.removeEventListener('timeupdate', this.boundOnMediaProgress);
      }
      this.releaseStream();
      this.stopRequested = false;
      this.setState('idle');
    }

    releaseStream() {
      if (!this.stream) return;
      try {
        this.stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        this.log('释放音轨失败', err);
      }
      this.stream = null;
    }

    setState(state, message) {
      this.state = state;
      this.onStatus({ state, message });
    }
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  /** 时间戳保留两位小数，日志里读起来清爽。 */
  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  /**
   * 把视频元素的音频状态查清楚，用于诊断“为什么录不起来”。
   *
   * 为什么需要它：MediaRecorder.start() 失败只会给一句
   * “There was an error starting the MediaRecorder”，既不说原因也不说怎么办。
   * 而实际原因通常是三类完全不同的情况：
   *   A. 视频跨域且没开 CORS → 音频被浏览器标记为受污染，采不到也录不了；
   *   B. 音轨存在但处于 muted/ended 状态（加密媒体、播放器特殊实现）；
   *   C. 这个页面上根本还没有可用的视频。
   * 三种情况的处理办法完全不同，所以必须先把它们区分开。
   */
  async function diagnoseMedia(media) {
    const report = {
      hasMedia: Boolean(media),
      hasCaptureStream: Boolean(media && typeof media.captureStream === 'function'),
      hasMediaRecorder: typeof MediaRecorder !== 'undefined',
      /* 安全上下文也放进报告，而不是让生成结论的代码临时去读 window。
       * 这样报告是自包含的，结论可以离线复现，也便于测试。 */
      isSecureContext: typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false,
      pageUrl: typeof location !== 'undefined' ? location.href : '',
      currentSrc: '',
      crossOriginAttr: null,
      duration: 0,
      paused: null,
      audioTracks: [],
      /** 关键判断：drawImage 抛 SecurityError 说明跨域污染，音频同样取不到 */
      tainted: null,
      taintError: null,
      recorderStartOk: null,
      recorderError: null,
      measures: null
    };
    if (!media) return report;

    report.currentSrc = media.currentSrc || media.src || '';
    report.crossOriginAttr = media.crossOrigin;
    report.duration = media.duration;
    report.paused = media.paused;

    let stream = null;
    try {
      stream = media.captureStream();
      report.audioTracks = stream.getAudioTracks().map((track) => ({
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings: typeof track.getSettings === 'function' ? track.getSettings() : null
      }));
    } catch (err) {
      report.captureStreamError = String((err && err.message) || err);
    }

    // 用 canvas 试探跨域污染：这是判断“音频能不能读”最可靠的代理指标
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      canvas.getContext('2d').drawImage(media, 0, 0, 8, 8);
      report.tainted = false;
    } catch (err) {
      report.tainted = true;
      report.taintError = String((err && err.message) || err);
    }

    // 真正逐组试一次录音：把“哪些参数组合能用”一条条列出来。
    // 这一步能一次性区分“只是格式选错了”和“这个环境根本录不了”。
    if (stream && report.audioTracks.length) {
      report.optionResults = [];
      const candidates = buildRecorderOptions();
      let winnerBlob = null;

      for (const candidate of candidates) {
        const label = describeRecorderOptions(candidate);
        let recorder = null;
        let parts = [];
        try {
          recorder = new MediaRecorder(stream, candidate);
        } catch (err) {
          report.optionResults.push({ label, ok: false, error: `${err.name}: ${err.message}` });
          continue;
        }
        try {
          recorder.addEventListener('dataavailable', (e) => e.data.size && parts.push(e.data));
          const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve));
          recorder.start();
          await new Promise((r) => setTimeout(r, 1200));
          recorder.stop();
          await stopped;
          const blob = new Blob(parts, { type: candidate.mimeType || 'audio/webm' });
          report.optionResults.push({ label, ok: true, bytes: blob.size });
          if (!winnerBlob && blob.size > 0) winnerBlob = blob;
          // 第一组能用就够了，后面的不用再花时间
          break;
        } catch (err) {
          try {
            if (recorder.state !== 'inactive') recorder.stop();
          } catch (stopErr) {
            /* 忽略 */
          }
          report.optionResults.push({ label, ok: false, error: `${err.name}: ${err.message}` });
        }
      }

      const winner = report.optionResults.find((r) => r.ok);
      report.recorderStartOk = Boolean(winner);
      report.workingOptions = winner ? winner.label : null;
      if (!winner) {
        report.recorderError = report.optionResults[0] ? report.optionResults[0].error : '全部参数组合均失败';
      }
      if (winnerBlob) {
        report.measures = await measureLoudness(winnerBlob);
        report.recordedBytes = winnerBlob.size;
      }
    }

    try {
      stream && stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      /* 忽略清理失败 */
    }

    return report;
  }

  /**
   * 检查一段录音是不是“几乎没声音”。
   * 用于识别 cross-origin 视频导致的静音采集——这种情况下不报错，但全是无声，
   * 用户会以为是识别不准，所以要主动提示。
   */
  async function measureLoudness(blob) {
    try {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioCtx) return null;
      const arrayBuffer = await blob.arrayBuffer();
      const ctx = new AudioCtx();
      try {
        const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const data = buffer.getChannelData(0);
        let sum = 0;
        let peak = 0;
        const step = Math.max(1, Math.floor(data.length / 20000));
        let count = 0;
        for (let i = 0; i < data.length; i += step) {
          const v = data[i];
          sum += v * v;
          if (Math.abs(v) > peak) peak = Math.abs(v);
          count++;
        }
        return { rms: Math.sqrt(sum / Math.max(1, count)), peak, seconds: buffer.duration };
      } finally {
        ctx.close();
      }
    } catch (err) {
      return null;
    }
  }

  /**
   * 把诊断结果翻译成人能读的结论 + 处理建议。
   *
   * 这一层很关键：原始数据（tainted=true、muted=true）用户看不懂，
   * 但“视频来自别的域名且没开跨域，浏览器不允许读它的声音”他能看懂，
   * 而且知道该去找谁解决。
   */
  function explainDiagnosis(report) {
    const lines = [];
    const push = (text) => lines.push(text);
    const secure = report.isSecureContext !== undefined
      ? report.isSecureContext
      : typeof window !== 'undefined' && Boolean(window.isSecureContext);

    push(`页面：${report.pageUrl || (typeof location !== 'undefined' ? location.href : '(未知)')}`);
    push(`安全上下文：${secure ? '是' : '否（非 https/localhost）'}`);
    push(`MediaRecorder 可用：${report.hasMediaRecorder ? '是' : '否'}`);
    push(`找到视频元素：${report.hasMedia ? '是' : '否'}`);

    if (!report.hasMedia) {
      push('');
      push('【结论】这个页面里没找到可用的 <video> 元素。');
      push('【建议】确认视频是本页在播放，而不是在特殊 iframe 里；');
      push('        也可以先在页面上播放视频，再按 Alt+Shift+Z 重试。');
      return lines.join('\n');
    }

    push(`视频地址：${report.currentSrc || '(空)'}`);
    push(`crossorigin 属性：${report.crossOriginAttr === null ? '(未设置)' : report.crossOriginAttr}`);
    push(`视频时长：${report.duration}`);
    push(`是否暂停：${report.paused ? '是' : '否'}`);
    push(`音频音轨数：${report.audioTracks.length}`);
    for (const track of report.audioTracks) {
      push(`  · ${track.label || 'audio'} muted=${track.muted} state=${track.readyState}`);
    }
    push(`跨域污染检测：${report.tainted === null ? '未能检测' : report.tainted ? '被污染' : '正常'}`);

    // 诊断时视频是否暂停，直接决定结论可不可信，所以要醒目地标出来
    const pausedWhileTesting = report.paused === true;
    if (pausedWhileTesting) {
      push('⚠ 诊断时视频处于暂停状态，录音测试结果不可信（暂停的视频不产生音频数据）');
    }

    // 把每个录音参数组合的实测结果列出来：这是定位 NotSupportedError 的直接证据
    if (Array.isArray(report.optionResults) && report.optionResults.length) {
      push('录音参数实测：');
      for (const item of report.optionResults) {
        push(`  ${item.ok ? '✓' : '✗'} ${item.label}${item.ok ? `（${item.bytes} 字节）` : ` → ${item.error}`}`);
      }
    }
    if (report.workingOptions) push(`可用参数组合：${report.workingOptions}`);
    else if (report.recorderError) push(`录音测试：全部失败，首个错误 ${report.recorderError}`);
    if (report.measures) {
      push(
        `录到的音量：RMS=${report.measures.rms.toFixed(5)} 峰值=${report.measures.peak.toFixed(4)}` +
          `（${report.recordedBytes || 0} 字节）`
      );
    }

    push('');
    if (pausedWhileTesting && (report.recorderStartOk === false || report.recordedBytes === 0)) {
      /* 这是最容易误判的一种情况：视频暂停时音频流里没有数据流动，
       * 显式指定格式会抛 NotSupportedError、不带格式则录出 0 字节。
       * 看起来像“格式不支持”，其实只是没在播放。 */
      push('【结论】诊断时视频是暂停的，所以录音测试拿不到数据。');
      push('        暂停的视频不产生音频数据，此时指定格式会报 NotSupportedError，');
      push('        不带格式则录出 0 字节——两者都不是格式问题。');
      push('【建议】点播放让视频真正出声音，再点一次“诊断”；');
      push('        然后点“开启字幕”。插件现在也会等你播放后才开始采集。');
    } else if (!report.hasCaptureStream) {
      push('【结论】浏览器不支持 captureStream()，无法读取视频音频。');
      push('【建议】换成 Chrome 或 Edge 116 以上版本。');
    } else if (report.tainted === true) {
      push('【结论】视频与页面不同域，且视频服务器没有允许跨域（缺 Access-Control-Allow-Origin）。');
      push('        浏览器允许播放，但禁止任何脚本读取它的音频——这是同源策略，插件绕不过去。');
      push('【建议】如果这个平台由你所在单位维护，请运维给视频响应加上');
      push('        Access-Control-Allow-Origin 响应头，这是唯一干净的解法。');
      push('        否则只能改用系统级录音转文字工具（录制系统声音，不走浏览器）。');
    } else if (!report.audioTracks.length) {
      push('【结论】视频流里没有音轨：可能是静音视频，或播放器把音频放到了别处。');
      push('【建议】确认这个视频本身有声音；若播放器有独立音量控件，先取消静音。');
    } else if (report.audioTracks.some((t) => t.muted || t.readyState !== 'live')) {
      push('【结论】音轨处于 muted 或已结束状态，浏览器拒绝用它启动录音。');
      push('【建议】先让视频真正播放起来（有声音那种），再点“开启字幕”。');
    } else if (report.recorderStartOk === false) {
      push('【结论】音轨正常，但 MediaRecorder 在这个页面上无法启动任何一种录音格式。');
      push('        注意：报错是 NotSupportedError，属于“格式/环境不被接受”，不是音轨损坏。');
      if (Array.isArray(report.optionResults) && report.optionResults.some((r) => !r.ok)) {
        push('        上面每一组参数都实测过，全部被拒绝，说明这台机器/这个页面上');
        push('        页面侧的录音通道整体不可用。');
      }
      push('【建议】把这份诊断结果发给开发者。可行的兜底方案是改用扩展自身的');
      push('        标签页录音（chrome.tabCapture）绕过页面限制。');
    } else if (report.measures && report.measures.peak < 0.01) {
      push('【结论】录音能启动，但录到的是近乎静音的内容。');
      push('【建议】多半仍是跨域导致音频被静音采集，处理办法同上。');
    } else {
      push('【结论】音频采集链路看起来正常，可以正常识别。');
    }

    return lines.join('\n');
  }

  NS.AudioChunkCapturer = AudioChunkCapturer;
  NS.measureLoudness = measureLoudness;
  NS.pickMimeType = pickMimeType;
  NS.diagnoseMedia = diagnoseMedia;
  NS.explainDiagnosis = explainDiagnosis;
})();
