/**
 * 字幕叠加层 + 页面内控制面板。
 *
 * 用 Shadow DOM 把样式和宿主页面彻底隔离，避免和教学平台的 CSS 打架；
 * 用固定定位的容器跟着 <video> 的位置跑，这样全屏、滚动、缩放都不会掉队。
 */
(function () {
  const NS = (globalThis.__ZIMU__ = globalThis.__ZIMU__ || {});

  const HOST_ID = 'zimu-subtitle-root';

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif; }

    .layer {
      position: fixed;
      pointer-events: none;
      z-index: 2147483000;
      overflow: hidden;
    }

    .caption {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: max-content;
      max-width: 88%;
      padding: 0.35em 0.7em;
      border-radius: 8px;
      /* 底色的实际取值由 JS 按设置写成内联样式（见 applyCaptionStyle），
       * 这里只是没有设置时的兜底。 */
      background: rgba(0, 0, 0, 0.72);
      color: #fff;
      text-align: center;
      line-height: 1.45;
      font-weight: 600;
      letter-spacing: 0.01em;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
      white-space: pre-wrap;
      word-break: break-word;
      transition: opacity 0.15s ease;
      opacity: 0;
    }

    /*
     * 字幕位置由 JS 用像素设置（见 Overlay.applyCaptionPosition）。
     *
     * 这里刻意不用百分比：字幕层是挂在 Shadow DOM 里的固定定位元素，
     * 百分比会依赖“包含块”的解析结果，一旦解析异常，字幕就会跑到视频外面——
     * 表现正是“识别成功、面板显示条数在涨，但画面上什么也看不到”。
     * 用像素 + 视频实际高度计算，位置完全可控。
     */
    .caption.visible { opacity: 1; }
    /*
     * partial 这个类表示「这句话还没放完」（逐字显示正在打字）。
     *
     * 刻意**不给它任何样式**。早先这里写的是浅蓝 + 细体，看着像「临时预览」，
     * 但逐字显示下每一句都会经历 partial → 完整，于是整句放完的一瞬间
     * 颜色和字重会跳一下，肉眼看着像闪。这个类现在只作为语义标记保留，
     * 供测试与诊断使用（__ZIMU__.inspect() 会把 class 原样报出来）。
     */

    .toast {
      position: absolute;
      left: 50%;
      top: 12px;
      transform: translateX(-50%);
      max-width: 80%;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.4;
      background: rgba(20, 20, 24, 0.86);
      color: #ffd7d7;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .toast.visible { opacity: 1; }

    .panel {
      position: fixed;
      /*
       * 默认停在右下角（用户习惯的位置），具体四角由 JS 按设置设定内联样式。
       *
       * 位置的取舍（两个坑都踩过）：
       *  · 右下角 —— 符合习惯，但会压住视频底部居中的字幕；
       *  · 左上角 —— 不挡字幕，却盖住课程正文顶部。
       * 所以做成可配置：默认右下角，设置里可换成其他三角。
       */
      right: 16px;
      bottom: 16px;
      z-index: 2147483001;
      pointer-events: auto;
      font-size: 13px;
      color: #e9ecf1;
      /* 收起时整块面板要平滑地滑出去，而不是"啪"地消失 */
      transition: transform 0.22s ease, opacity 0.22s ease;
    }
    .panel * { pointer-events: auto; }

    /*
     * 收起态：面板滑向所在的那一侧边缘，只在边上留一条窄条。
     *
     * 为什么用 transform 而不是 display:none —— 收起来之后必须还能点回来，
     * display:none 就彻底够不着了。留的宽度（18px）加上面板本身距边缘的
     * 16px 内边距，屏幕上正好是一条 30 多像素的窄条，一眼能看出"这儿有东西"。
     */
    .panel.collapsed { opacity: 0.86; }
    .panel.collapsed:hover { opacity: 1; }
    .panel.collapsed-right { transform: translateX(calc(100% - 18px)); }
    .panel.collapsed-left { transform: translateX(calc(-100% + 18px)); }
    /* 收起时卡片一律关掉，否则滑出去的是一整张 300px 的卡片 */
    .panel.collapsed .card { display: none !important; }
    .panel.collapsed .fab { padding: 10px 12px; }
    .panel.collapsed [data-fab-text] { display: none; }

    .fab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 999px;
      background: rgba(24, 26, 32, 0.92);
      color: #e9ecf1;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      user-select: none;
      font-size: 13px;
    }
    .fab:hover { background: rgba(38, 41, 50, 0.96); }
    .fab .dot { width: 8px; height: 8px; border-radius: 50%; background: #7a8194; }
    .fab.on .dot { background: #43d17a; box-shadow: 0 0 8px #43d17a; }
    .fab.busy .dot { background: #ffc14d; }
    .fab.error .dot { background: #ff5f56; }

    .card {
      width: 300px;
      margin-bottom: 8px;
      padding: 12px;
      border-radius: 10px;
      background: rgba(24, 26, 32, 0.97);
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      display: none;
    }
    .card.open { display: block; }

    .card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: #fff; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 7px 0; }
    .row label { color: #aab2c0; }
    .row input[type="range"] { width: 130px; }
    .row .value { color: #8f98a8; min-width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
    .row select, .row input[type="number"] {
      background: #14161b; color: #e9ecf1; border: 1px solid #333844;
      border-radius: 6px; padding: 3px 6px; font-size: 12px; max-width: 150px;
    }
    .status { margin: 8px 0 4px; font-size: 12px; color: #8f98a8; line-height: 1.5; word-break: break-word; }
    .status.warn { color: #ffc14d; }
    .status.err { color: #ff7b72; }
    .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .actions button {
      flex: 1 1 auto;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid #3a4150;
      background: #262a33;
      color: #e9ecf1;
      cursor: pointer;
      font-size: 12px;
    }
    .actions button:hover { background: #313742; }
    .actions button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
    .actions button.primary:hover { background: #3d7cf5; }
    .hint { font-size: 11px; color: #79808f; margin-top: 6px; line-height: 1.5; }

    /* 诊断输出：等宽字体 + 可选择，方便用户整段复制发给开发者 */
    .diag {
      width: 100%;
      height: 150px;
      margin-top: 8px;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid #3a4150;
      background: #14161b;
      color: #cfd6e2;
      font: 11px/1.55 Consolas, "Courier New", monospace;
      resize: vertical;
      white-space: pre;
      overflow: auto;
    }
    .diag[hidden] { display: none; }
  `;

  class Overlay {
    constructor(options = {}) {
      this.video = null;
      this.host = null;
      this.shadow = null;
      this.visible = true;
      this.fontSize = options.fontSize || 22;
      this.bottomPercent = options.bottomPercent ?? 8;
      this.captionOpacity = options.captionOpacity == null ? 72 : options.captionOpacity;
      this.typewriterEnabled = options.typewriter !== false;
      this.showButton = options.showButton !== false;
      this.panelPosition = options.panelPosition || 'bottom-right';
      this.collapsed = options.panelCollapsed === true;
      this.onToggle = options.onToggle || (() => {});
      this.onOpenSettings = options.onOpenSettings || (() => {});
      this.onExport = options.onExport || (() => {});
      this.onCopy = options.onCopy || (() => {});
      this.onClear = options.onClear || (() => {});
      this.onDiagnose = options.onDiagnose || (() => {});
      this.onSaveAudio = options.onSaveAudio || (() => {});
      this.onFontSize = options.onFontSize || (() => {});
      this.onBottomPercent = options.onBottomPercent || (() => {});
      this.onCaptionOpacity = options.onCaptionOpacity || (() => {});
      this.onTypewriter = options.onTypewriter || (() => {});
      this.onCollapse = options.onCollapse || (() => {});
      this.rafHandle = null;
      this.toastTimer = null;
      this.built = false;
    }

    /** 按设置把面板摆到指定的角。 */
    positionPanel(position) {
      if (!this.panel) return;
      const value = position || this.panelPosition || 'bottom-right';
      this.panelPosition = value;

      const corners = {
        'bottom-right': { right: '16px', bottom: '16px' },
        'top-right': { right: '16px', top: '16px' },
        'top-left': { left: '16px', top: '16px' },
        'bottom-left': { left: '16px', bottom: '16px' }
      };
      const target = corners[value] || corners['bottom-right'];

      /* 先把四个方向的偏移全部清空，再设目标方向。
       * 否则从右下角切到右上角时，残留的 bottom 会和 top 冲突，
       * 面板会被拉成一条横贯屏幕的长条。 */
      for (const side of ['left', 'right', 'top', 'bottom']) {
        this.panel.style[side] = '';
      }
      for (const [side, offset] of Object.entries(target)) {
        this.panel.style[side] = offset;
      }
      /* 收起方向跟着位置走：面板在哪一侧，就往哪一侧滑出去。 */
      this.applyCollapsedSide();
    }

    /**
     * 按当前所在的一侧，决定收起时往左滑还是往右滑。
     *
     * 单独抽出来是因为「换角」和「收起/展开」这两件事都会用到它：
     * 从右下角切到左下角时，收起方向必须跟着从右变左，否则面板会横穿整个画面。
     */
    applyCollapsedSide() {
      if (!this.panel) return;
      const onRight = String(this.panelPosition || 'bottom-right').endsWith('right');
      this.panel.classList.toggle('collapsed', this.collapsed);
      this.panel.classList.toggle('collapsed-right', this.collapsed && onRight);
      this.panel.classList.toggle('collapsed-left', this.collapsed && !onRight);
    }

    /** 收起 / 展开悬浮窗（游戏助手式的贴边半隐藏）。 */
    setCollapsed(collapsed) {
      this.collapsed = Boolean(collapsed);
      if (!this.collapsed && this.panel) {
        // 展开时顺手把卡片也打开，省得用户再点一次悬浮球
        this.panel.querySelector('[data-card]')?.classList.add('open');
      }
      this.applyCollapsedSide();
      this.onCollapse(this.collapsed);
      return this.collapsed;
    }

    attachTo(video) {
      if (this.video === video && this.built) return;
      this.video = video;
      this.build();
      this.syncNow();
    }

    build() {
      if (this.host && this.host.isConnected) this.host.remove();

      const host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'all: initial;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      const layer = document.createElement('div');
      layer.className = 'layer';
      layer.innerHTML = `
        <div class="caption" part="caption"></div>
        <div class="toast" part="toast"></div>
      `;
      shadow.appendChild(layer);

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = `
        <div class="card" data-card>
          <h3>字幕助手</h3>
          <div class="row"><label>状态</label><span data-state>未启动</span></div>
          <div class="row"><label>字号</label><input type="range" min="14" max="40" step="1" data-font></div>
          <div class="row"><label>位置</label><input type="range" min="0" max="30" step="1" data-bottom><span class="value" data-bottom-value></span></div>
          <div class="row"><label>底色</label><input type="range" min="0" max="100" step="5" data-opacity><span class="value" data-opacity-value></span></div>
          <div class="row"><label>逐字</label><input type="checkbox" data-typewriter></div>
          <div class="status" data-status></div>
          <div class="actions">
            <button data-act="toggle" class="primary">开启字幕</button>
            <button data-act="settings">设置</button>
          </div>
          <div class="actions">
            <button data-act="copy">复制全文</button>
            <button data-act="export">导出 SRT</button>
            <button data-act="clear">清空</button>
          </div>
          <div class="actions">
            <button data-act="diagnose">诊断</button>
            <button data-act="save-audio">保存最近一段音频</button>
            <button data-act="collapse">收起</button>
          </div>
          <textarea class="diag" data-diag readonly hidden></textarea>
          <div class="hint">收起后面板会贴到视频侧边，只留一条窄边，点一下即可展开。</div>
        </div>
        <button class="fab" data-fab><span class="dot"></span><span data-fab-text>字幕助手</span></button>
      `;
      if (this.showButton) shadow.appendChild(panel);
      this.panel = panel;
      // 按设置摆好位置（默认右下角）
      this.positionPanel(this.panelPosition);

      // 挂到全屏元素里（如果在全屏状态），否则挂到 body。
      // 注意不能直接用 document.body：内容脚本可能在 body 出现之前就执行，
      // 这时 body 是 null，appendChild 会直接抛错，插件就彻底不显示了。
      const mountTarget = () => {
        const fs = document.fullscreenElement;
        const parent = (fs && fs !== host ? fs : null) || document.body || document.documentElement;
        if (parent && host.parentNode !== parent) parent.appendChild(host);
      };
      mountTarget();

      this.host = host;
      this.shadow = shadow;
      this.layer = layer;
      this.caption = layer.querySelector('.caption');
      this.toastEl = layer.querySelector('.toast');
      this.built = true;

      this.caption.style.fontSize = this.fontSize + 'px';
      this.applyCaptionStyle();
      this.applyCaptionPosition();

      const fontInput = panel.querySelector('[data-font]');
      fontInput.value = String(this.fontSize);
      fontInput.addEventListener('input', () => {
        this.setFontSize(Number(fontInput.value));
        this.onFontSize(this.fontSize);
      });

      const bottomInput = panel.querySelector('[data-bottom]');
      const bottomValue = panel.querySelector('[data-bottom-value]');
      bottomInput.value = String(this.bottomPercent);
      bottomValue.textContent = this.bottomPercent + '%';
      bottomInput.addEventListener('input', () => {
        this.setBottomPercent(Number(bottomInput.value));
        bottomValue.textContent = this.bottomPercent + '%';
        // 位置也要存下来：否则用户拖完一刷新就弹回默认值
        this.onBottomPercent(this.bottomPercent);
      });

      const opacityInput = panel.querySelector('[data-opacity]');
      const opacityValue = panel.querySelector('[data-opacity-value]');
      opacityInput.value = String(this.captionOpacity);
      opacityValue.textContent = this.captionOpacity + '%';
      opacityInput.addEventListener('input', () => {
        this.setCaptionOpacity(Number(opacityInput.value));
        opacityValue.textContent = this.captionOpacity + '%';
        this.onCaptionOpacity(this.captionOpacity);
      });

      const typewriterInput = panel.querySelector('[data-typewriter]');
      typewriterInput.checked = this.typewriterEnabled;
      typewriterInput.addEventListener('change', () => {
        this.setTypewriter(typewriterInput.checked);
        this.onTypewriter(this.typewriterEnabled);
      });

      panel.querySelector('[data-fab]').addEventListener('click', () => {
        const card = panel.querySelector('[data-card]');
        card.classList.toggle('open');
      });
      /* 收起状态下，整个面板就是那条窄边——点哪儿都应当展开。
       * 用捕获阶段拦截：否则这次点击会先落到悬浮球上、顺手把卡片也点开，
       * 变成一个"既展开又开卡片"的混乱状态。 */
      panel.addEventListener(
        'click',
        (event) => {
          if (!this.collapsed) return;
          event.preventDefault();
          event.stopPropagation();
          this.setCollapsed(false);
        },
        true
      );
      panel.querySelector('[data-act="toggle"]').addEventListener('click', () => this.onToggle());
      panel.querySelector('[data-act="settings"]').addEventListener('click', () => this.onOpenSettings());
      panel.querySelector('[data-act="export"]').addEventListener('click', () => this.onExport());
      panel.querySelector('[data-act="copy"]').addEventListener('click', () => this.onCopy());
      panel.querySelector('[data-act="clear"]').addEventListener('click', () => this.onClear());
      panel.querySelector('[data-act="diagnose"]').addEventListener('click', () => this.onDiagnose());
      panel.querySelector('[data-act="save-audio"]').addEventListener('click', () => this.onSaveAudio());
      panel
        .querySelector('[data-act="collapse"]')
        .addEventListener('click', () => this.setCollapsed(true));

      this.onFsChange = () => mountTarget();
      document.addEventListener('fullscreenchange', this.onFsChange);

      this.syncLoop();
    }

    /** 让字幕层始终对齐 <video> 的可视区域。 */
    syncLoop() {
      if (this.rafHandle) return;
      const tick = () => {
        this.rafHandle = requestAnimationFrame(tick);
        this.syncNow();
      };
      this.rafHandle = requestAnimationFrame(tick);
    }

    syncNow() {
      if (!this.video || !this.layer || !this.video.isConnected) return;
      const rect = this.video.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) {
        this.layer.style.display = 'none';
        return;
      }
      this.layer.style.display = 'block';
      this.layer.style.left = rect.left + 'px';
      this.layer.style.top = rect.top + 'px';
      this.layer.style.width = rect.width + 'px';
      this.layer.style.height = rect.height + 'px';
      this.videoHeight = rect.height;
      this.applyCaptionPosition();
    }

    /**
     * 用像素把字幕钉在视频底部。
     *
     * 必须用像素而不是百分比：字幕层挂在 Shadow DOM 里的固定定位容器中，
     * 百分比定位依赖“包含块”的解析，一旦解析异常字幕就会跑到视频外面，
     * 而用户看到的现象就是“识别明明成功了，画面上却没有字幕”。
     * 这里直接按视频实际高度算，位置绝对可控。
     *
     * 2026-10 按用户实测调整：**去掉了「至少留 12% 视频高度」这条硬下限**。
     * 那条下限的本意是避开页面自己的悬浮控件，但代价是 600px 高的播放器上
     * 字幕被钉死在离底 72px 处，用户看到的评价是“位置太高，都飘到画面中间了”。
     * 现在下限只保留「不小于字号 + 6」（大字不贴边），剩下的交给设置里的滑块，
     * 滑块拖到 0 就能贴到最下面。遮挡问题改由可收起的悬浮窗解决（见 setCollapsed）。
     */
    applyCaptionPosition() {
      if (!this.caption) return;
      const videoHeight = this.videoHeight || (this.video ? this.video.getBoundingClientRect().height : 0);
      if (!videoHeight) return;

      const minGap = this.fontSize + 6;
      const maxGap = Math.max(minGap, videoHeight / 3);
      const preferred = (videoHeight * this.bottomPercent) / 100;
      const gap = Math.min(maxGap, Math.max(minGap, preferred));
      this.caption.style.bottom = gap + 'px';
    }

    /**
     * 按设置刷新字幕底色的不透明度。
     *
     * 0% 时底色完全透明，只剩文字——这时文字完全靠 text-shadow 撑着，
     * 所以阴影不能一起去掉，否则浅色课件上会白字白底、彻底看不见。
     */
    applyCaptionStyle() {
      if (!this.caption) return;
      const alpha = Math.min(100, Math.max(0, Number(this.captionOpacity))) / 100;
      this.caption.style.background = alpha <= 0.001 ? 'transparent' : `rgba(0, 0, 0, ${alpha})`;
      this.caption.style.textShadow =
        alpha <= 0.35
          ? '0 0 3px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,0.95)'
          : '0 1px 2px rgba(0,0,0,0.9)';
    }

    setCaptionOpacity(percent) {
      const n = Number(percent);
      this.captionOpacity = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : this.captionOpacity;
      this.applyCaptionStyle();
    }

    setTypewriter(on) {
      this.typewriterEnabled = on !== false;
      return this.typewriterEnabled;
    }

    setFontSize(px) {
      this.fontSize = px;
      if (this.caption) this.caption.style.fontSize = px + 'px';
      // 字号变了，底部留白也要跟着重算，否则大字会贴到画面最下沿
      this.applyCaptionPosition();
    }

    setBottomPercent(percent) {
      const n = Number(percent);
      this.bottomPercent = Number.isFinite(n) ? Math.min(40, Math.max(0, n)) : this.bottomPercent;
      this.applyCaptionPosition();
      return this.bottomPercent;
    }

    showCaption(text, isPartial) {
      if (!this.caption) return;
      if (!text) {
        this.caption.classList.remove('visible');
        this.caption.textContent = '';
        return;
      }
      if (this.caption.textContent !== text) this.caption.textContent = text;
      this.caption.classList.add('visible');
      this.caption.classList.toggle('partial', Boolean(isPartial));
    }

    setState(state) {
      if (!this.panel) return;
      const stateEl = this.panel.querySelector('[data-state]');
      const fab = this.panel.querySelector('[data-fab]');
      const fabText = this.panel.querySelector('[data-fab-text]');
      const labels = {
        idle: '未启动',
        recording: '识别中',
        stopping: '停止中',
        error: '出错',
        unsupported: '不支持'
      };
      stateEl.textContent = labels[state] || state;
      fab.classList.toggle('on', state === 'recording');
      fab.classList.toggle('busy', state === 'stopping');
      fab.classList.toggle('error', state === 'error' || state === 'unsupported');
      fabText.textContent = state === 'recording' ? '字幕进行中' : '字幕助手';
      const toggleBtn = this.panel.querySelector('[data-act="toggle"]');
      toggleBtn.textContent = state === 'recording' || state === 'stopping' ? '停止字幕' : '开启字幕';
    }

    setStatus(message, level) {
      if (!this.panel) return;
      const el = this.panel.querySelector('[data-status]');
      el.textContent = message || '';
      el.className = 'status' + (level ? ' ' + level : '');
    }

    toast(message, duration = 6000) {
      if (!this.toastEl) return;
      this.toastEl.textContent = message;
      this.toastEl.classList.add('visible');
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.toastEl.classList.remove('visible'), duration);
    }

    openCard() {
      if (!this.panel) return;
      this.panel.querySelector('[data-card]').classList.add('open');
    }

    /** 把诊断报告显示在面板里，并自动选中方便用户 Ctrl+C 复制。 */
    showDiagnosis(text) {
      if (!this.panel) return;
      const box = this.panel.querySelector('[data-diag]');
      box.hidden = false;
      box.value = text;
      this.openCard();
      try {
        box.focus();
        box.select();
      } catch (err) {
        /* 选中失败不影响阅读 */
      }
    }

    /**
     * 字幕显示不出来时，用它在 Console 里一眼看清问题。
     *
     * 返回纯文本而不是对象，方便用户直接复制发出来。
     * 重点看三项：caption 有没有真实尺寸、opacity 是否为 0、
     * 以及它是否落在视频的可视矩形内。
     */
    inspect() {
      const lines = [];
      const push = (text) => lines.push(text);
      const round = (n) => Math.round(n);

      // 没有真实布局能力时（例如测试环境）退化成基本信息，避免整段报错
      const canMeasure = typeof getComputedStyle === 'function';

      const videoRect = this.video ? this.video.getBoundingClientRect() : null;
      push(`视频元素：${this.video ? (this.video.currentSrc || this.video.src || '(无地址)').slice(0, 80) : '无'}`);
      if (videoRect) {
        push(
          `视频矩形：${round(videoRect.left)},${round(videoRect.top)} ` +
            `${round(videoRect.width)}×${round(videoRect.height)}`
        );
      }

      if (!this.layer) {
        push('字幕层：未创建');
        return lines.join('\n');
      }
      const layerRect = this.layer.getBoundingClientRect();
      push(
        `字幕层：inline-display=${this.layer.style.display || '(未设)'} ` +
          `computed-display=${getComputedStyle(this.layer).display} ` +
          `${round(layerRect.left)},${round(layerRect.top)} ` +
          `${round(layerRect.width)}×${round(layerRect.height)}`
      );

      /* 这一条曾经漏掉，而它恰恰是“什么都看不到”的直接原因：
       * 视频元素尺寸小于阈值时字幕层会被设为 display:none，
       * 此时后面所有关于字幕文本的测量都正常，却永远不会显示。 */
      const layerHidden = getComputedStyle(this.layer).display === 'none';
      push(`〇 字幕层未被隐藏：${layerHidden ? '否 ← 问题在这里（视频区域太小或未找到）' : '是'}`);

      if (!this.caption) {
        push('字幕文本节点：未创建');
        return lines.join('\n');
      }
      const cs = getComputedStyle(this.caption);
      const capRect = this.caption.getBoundingClientRect();
      push(`字幕内容：${this.caption.textContent || '(空)'}`);
      push(`字幕 class：${this.caption.className}`);
      push(
        `字幕样式：position=${cs.position} bottom=${cs.bottom} opacity=${cs.opacity} ` +
          `display=${cs.display} fontSize=${cs.fontSize} visibility=${cs.visibility}`
      );
      push(
        `字幕矩形：${round(capRect.left)},${round(capRect.top)} ` +
          `${round(capRect.width)}×${round(capRect.height)}`
      );

      const hasSize = capRect.width > 0 && capRect.height > 0;
      push(`① 有可见尺寸：${hasSize ? '是' : '否 ← 问题在这里'}`);
      push(`② opacity 非 0：${cs.opacity !== '0' ? '是' : '否 ← 问题在这里'}`);

      if (videoRect && hasSize) {
        const inside =
          capRect.top >= videoRect.top - 2 &&
          capRect.bottom <= videoRect.bottom + 2 &&
          capRect.left >= videoRect.left - 2 &&
          capRect.right <= videoRect.right + 2;
        push(`③ 落在视频范围内：${inside ? '是' : '否 ← 问题在这里'}`);
        push(`   距视频底部：${round(videoRect.bottom - capRect.bottom)}px（字号 ${this.fontSize}px）`);

        /* 面板遮挡检查：面板若压在字幕上，用户同样“看不到字幕”，
         * 但此时①②③全部正常。早期诊断漏了这一项，导致一直定位不到原因。 */
        const panel = this.host && this.host.shadowRoot
          ? this.host.shadowRoot.querySelector('.panel')
          : null;
        if (panel) {
          const pRect = panel.getBoundingClientRect();
          const overlaps =
            pRect.width > 0 &&
            pRect.height > 0 &&
            capRect.left < pRect.right &&
            capRect.right > pRect.left &&
            capRect.top < pRect.bottom &&
            capRect.bottom > pRect.top;
          push(
            `④ 未被控制面板遮挡：${overlaps ? '否 ← 问题在这里' : '是'}` +
              `（面板 ${round(pRect.left)},${round(pRect.top)} ${round(pRect.width)}×${round(pRect.height)}）`
          );
        }
      }
      return lines.join('\n');
    }

    destroy() {
      if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
      if (this.onFsChange) document.removeEventListener('fullscreenchange', this.onFsChange);
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.built = false;
    }
  }

  NS.Overlay = Overlay;
})();
