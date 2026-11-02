/**
 * 字幕显示位置的测试。
 *
 * 来自一个真实故障：识别完全成功（面板显示"已生成 23 条字幕"、
 * 导出的音频也能听到声音），但**画面上一条字幕都看不到**。
 *
 * 根因是字幕用百分比定位（bottom: 8%），而它挂在 Shadow DOM 里的固定定位容器中，
 * 百分比会依赖“包含块”的解析；一旦解析异常，字幕就落到视频外面去了。
 * 现在改为按视频实际高度计算像素位置，这组测试锁住这个行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/** 造一个极简 DOM，只保留 Overlay 用到的布局能力。 */
function makeDom({ videoWidth = 900, videoHeight = 500 } = {}) {
  const bySelector = new Map();

  function makeElement(tag = 'div', id = '') {
    const element = {
      tagName: tag.toUpperCase(),
      id,
      children: [],
      style: { cssText: '' },
      // 组件对部分节点是用 className 赋值的（不在 innerHTML 里），桩件也要能识别
      set className(value) {
        this._className = value;
        const text = String(value);
        if (text.includes('panel') && !bySelector.has('.panel')) {
          bySelector.set('.panel', this);
        }
        if (text.includes('caption') && !bySelector.has('.caption')) {
          bySelector.set('.caption', this);
        }
        if (text.includes('toast') && !bySelector.has('.toast')) {
          bySelector.set('.toast', this);
        }
      },
      get className() {
        return this._className || '';
      },
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c);
        },
        remove(c) {
          this._set.delete(c);
        },
        toggle(c, on) {
          if (on) this._set.add(c);
          else this._set.delete(c);
        },
        contains(c) {
          return this._set.has(c);
        }
      },
      dataset: {},
      textContent: '',
      value: '',
      hidden: false,
      part: '',
      isConnected: true,
      parentNode: null,
      // 布局：由测试显式设定，模拟真实渲染结果
      offsetHeight: 0,
      offsetWidth: 0,
      _rect: { left: 10, top: 20, width: 400, height: 300 },
      getBoundingClientRect() {
        return { ...this._rect };
      },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((c) => c !== child);
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
        this.isConnected = false;
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      getAttribute() {
        return null;
      },
      querySelector(selector) {
        return bySelector.get(selector) || null;
      },
      querySelectorAll() {
        return [];
      },
      attachShadow() {
        const shadow = makeElement('shadow-root');
        shadow._isShadow = true;
        this.shadowRoot = shadow;
        return shadow;
      },
      click() {},
      focus() {},
      select() {}
    };
    // innerHTML：按选择器把内部节点注册到 map 里，供 querySelector 取用
    Object.defineProperty(element, 'innerHTML', {
      get() {
        return this._html || '';
      },
      set(html) {
        this._html = String(html);
        /* 对每个组件会查询的选择器，判断 html 里有没有对应标记，
         * 有就建一个替身节点。逻辑直白即可——这是测试桩件，
         * 要的是可靠而不是聪明（写复杂了反而会像早期那样漏掉 .panel）。 */
        const known = [
          ['.caption', 'class="caption"'],
          ['.toast', 'class="toast"'],
          ['.panel', 'class="panel"'],
          ['[data-card]', 'data-card'],
          ['[data-state]', 'data-state'],
          ['[data-status]', 'data-status'],
          ['[data-font]', 'data-font'],
          ['[data-bottom]', 'data-bottom'],
          ['[data-bottom-value]', 'data-bottom-value'],
          ['[data-opacity]', 'data-opacity'],
          ['[data-opacity-value]', 'data-opacity-value'],
          ['[data-typewriter]', 'data-typewriter'],
          ['[data-fab]', 'data-fab'],
          ['[data-fab-text]', 'data-fab-text'],
          ['[data-diag]', 'data-diag'],
          ['[data-act="toggle"]', 'data-act="toggle"'],
          ['[data-act="settings"]', 'data-act="settings"'],
          ['[data-act="export"]', 'data-act="export"'],
          ['[data-act="copy"]', 'data-act="copy"'],
          ['[data-act="clear"]', 'data-act="clear"'],
          ['[data-act="diagnose"]', 'data-act="diagnose"'],
          ['[data-act="save-audio"]', 'data-act="save-audio"'],
          ['[data-act="collapse"]', 'data-act="collapse"']
        ];
        for (const [selector, marker] of known) {
          if (this._html.includes(marker) && !bySelector.has(selector)) {
            bySelector.set(selector, makeElement('div'));
          }
        }
      }
    });
    return element;
  }

  const video = makeElement('video', 'v');
  video._rect = { left: 10, top: 20, width: videoWidth, height: videoHeight, right: 10 + videoWidth, bottom: 20 + videoHeight };
  video.isConnected = true;
  video.currentSrc = 'blob:https://example.com/abc';
  video.addEventListener = () => {};
  video.removeEventListener = () => {};

  const body = makeElement('body');
  const documentElement = makeElement('html');

  const document = {
    title: '测试页',
    readyState: 'complete',
    body,
    documentElement,
    fullscreenElement: null,
    createElement: (tag) => makeElement(tag),
    querySelector: (selector) => (selector === 'video' ? video : bySelector.get(selector) || null),
    querySelectorAll: (selector) => (selector === 'video' ? [video] : []),
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null
  };

  const window = {
    isSecureContext: true,
    addEventListener() {},
    removeEventListener() {}
  };

  return { document, window, video, body, makeElement };
}

/** 加载真实的 overlay.js，并注入 DOM 桩。 */
async function loadOverlay(options) {
  const dom = makeDom(options);
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    document: dom.document,
    window: dom.window,
    getComputedStyle: (el) => ({
      opacity: el.classList.contains('visible') ? '1' : '0',
      display: el.style.display || 'block',
      visibility: 'visible',
      position: 'absolute',
      bottom: el.style.bottom || '',
      fontSize: el.style.fontSize || '',
      left: '',
      top: ''
    }),
    Blob,
    URL
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const code = await readFile(path.join(distDir, 'content', 'overlay.js'), 'utf8');
  new vm.Script(code, { filename: 'content/overlay.js' }).runInContext(sandbox);

  return { NS: sandbox.__ZIMU__, dom };
}

test('字幕位置用像素计算，钉在视频底部而不是依赖百分比', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 8, showButton: true });
  overlay.attachTo(dom.video);

  // 触发一次同步，让它按视频尺寸计算位置
  overlay.syncNow();

  const bottom = overlay.caption.style.bottom;
  assert.match(bottom, /px$/, `字幕底部定位必须是像素值，实际：${bottom}`);

  const px = parseFloat(bottom);
  // 视频高 500、bottomPercent 8 → 40px，且不小于字号 + 6
  assert.ok(px >= 28, `底部留白不该小于字号，实际 ${px}px`);
  assert.ok(px <= 500 / 3, `底部留白不该大过视频高度的三分之一，实际 ${px}px`);

  // 模拟真实布局：caption 高度 40px，底部距视频底 40px
  overlay.caption._rect = {
    left: 100,
    top: 20 + 500 - 40 - 40,
    width: 400,
    height: 40,
    right: 500,
    bottom: 20 + 500 - 40
  };
  const videoRect = dom.video.getBoundingClientRect();
  const capRect = overlay.caption.getBoundingClientRect();
  assert.ok(capRect.bottom <= videoRect.bottom, '字幕必须落在视频范围内');
  assert.ok(capRect.top >= videoRect.top, '字幕不能跑到视频上方');
});

test('底部留白下限是“字号 + 6”，且不再有 12% 的硬下限', async (t) => {
  /* 2026-10 按用户实测调整：原来还有一条“至少留 12% 视频高度”的下限，
   * 6 号字号在 500px 高的播放器上会被强行顶到 60px 处，用户看到的评价是
   * “字幕位置太高”。现在只保留“不小于字号 + 6”，剩下的交给滑块。 */
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({ fontSize: 16, bottomPercent: 2, showButton: true });
  overlay.attachTo(dom.video);
  overlay.syncNow();

  // 字号很大时，留白必须跟上去，避免大字贴到画面最下沿
  overlay.setFontSize(80);
  const large = parseFloat(overlay.caption.style.bottom);
  assert.ok(large >= 80 + 6, `留白至少要不小于字号 + 6，实际 ${large}px`);

  // 小字号 + 滑块拉到底：必须允许贴近底部，不能被 12% 的硬下限顶起来
  overlay.setFontSize(22);
  overlay.setBottomPercent(0);
  const small = parseFloat(overlay.caption.style.bottom);
  assert.ok(small <= 500 * 0.12, `滑块拉到底时应能贴到 12% 以下，实际 ${small}px`);
  assert.ok(small >= 22 + 6 - 1, `但仍不该小于字号 + 6，实际 ${small}px`);
});

test('底色浓度可调，拖到 0 时底色完全透明', async (t) => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({
    fontSize: 22,
    bottomPercent: 6,
    captionOpacity: 72,
    showButton: true
  });
  overlay.attachTo(dom.video);

  assert.match(overlay.caption.style.background, /rgba\(0, 0, 0, 0\.72\)/);

  overlay.setCaptionOpacity(0);
  assert.equal(overlay.caption.style.background, 'transparent', '0 必须是完全透明');
  /* 底色透明之后文字全靠阴影撑着，所以阴影不能一起去掉，
   * 否则浅色课件上就是白字白底、什么都看不见。 */
  assert.match(overlay.caption.style.textShadow, /rgba\(0,0,0/);

  // 越界值要被夹住，不能把 background 写成非法值
  overlay.setCaptionOpacity(999);
  assert.match(overlay.caption.style.background, /rgba\(0, 0, 0, 1\)/);
  overlay.setCaptionOpacity(-5);
  assert.equal(overlay.caption.style.background, 'transparent');
});

test('收起时面板贴到所在的一侧，展开时复原，换边也会跟着换方向', async (t) => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({
    fontSize: 22,
    bottomPercent: 6,
    showButton: true,
    panelPosition: 'bottom-right'
  });
  overlay.attachTo(dom.video);

  assert.equal(overlay.panel.classList.contains('collapsed'), false, '默认不该是收起的');

  overlay.setCollapsed(true);
  assert.equal(overlay.panel.classList.contains('collapsed'), true);
  assert.equal(
    overlay.panel.classList.contains('collapsed-right'),
    true,
    '右下角的面板应当往右滑出去'
  );

  overlay.setCollapsed(false);
  assert.equal(overlay.panel.classList.contains('collapsed'), false);
  assert.equal(overlay.panel.classList.contains('collapsed-right'), false, '展开后不该残留滑出方向');

  // 换到左下角再收起：必须改成往左滑，否则面板会横穿整个画面
  overlay.positionPanel('bottom-left');
  overlay.setCollapsed(true);
  assert.equal(overlay.panel.classList.contains('collapsed-left'), true);
  assert.equal(overlay.panel.classList.contains('collapsed-right'), false);
});

test('收起/展开状态会写回设置（下次打开还保持）', async (t) => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const seen = [];
  const overlay = new NS.Overlay({
    fontSize: 22,
    showButton: true,
    onCollapse: (collapsed) => seen.push(collapsed)
  });
  overlay.attachTo(dom.video);

  overlay.setCollapsed(true);
  overlay.setCollapsed(false);
  assert.deepEqual(seen, [true, false]);
});

test('构造时可以指定“默认收起”（设置项生效）', async (t) => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({
    fontSize: 22,
    showButton: true,
    panelPosition: 'top-right',
    panelCollapsed: true
  });
  overlay.attachTo(dom.video);
  assert.equal(overlay.panel.classList.contains('collapsed'), true);
  assert.equal(overlay.panel.classList.contains('collapsed-right'), true);
});

test('底部留白不会越过视频高度的三分之一', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 600 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 30, showButton: true });
  overlay.attachTo(dom.video);
  overlay.syncNow();

  const gap = parseFloat(overlay.caption.style.bottom);
  assert.ok(gap <= 600 / 3 + 1, `留白不该超过视频高度的三分之一，实际 ${gap}px`);
});

test('位置滑块变化会立即影响字幕位置', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 600 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 5, showButton: true });
  overlay.attachTo(dom.video);
  overlay.syncNow();

  const low = parseFloat(overlay.caption.style.bottom);
  overlay.setBottomPercent(20);
  const high = parseFloat(overlay.caption.style.bottom);

  assert.ok(high > low, `调大位置值应让字幕上移（${low} → ${high}）`);
  assert.ok(high <= 600 / 3, '但不应超过视频高度的三分之一');
});

test('视频尺寸太小时字幕层会隐藏，避免在半透明小元素上乱显示', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 20, videoHeight: 20 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 8, showButton: true });
  overlay.attachTo(dom.video);
  overlay.syncNow();

  assert.equal(overlay.layer.style.display, 'none');
});

test('inspect() 能指出“字幕层被隐藏”这一条（曾经漏掉的诊断项）', async () => {
  /* 视频区域太小时字幕层会被设为 display:none，此时字幕文本的测量一切正常，
   * 却永远不会显示。早期诊断只检查了尺寸/透明度/范围，漏掉了这一条，
   * 于是“明明都有值却看不到字幕”一直定位不到原因。 */
  const { NS, dom } = await loadOverlay({ videoWidth: 20, videoHeight: 20 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 8, showButton: true });
  overlay.attachTo(dom.video);
  overlay.syncNow(); // 小区域 → 隐藏字幕层

  const report = overlay.inspect();
  assert.match(report, /〇 字幕层未被隐藏：否/);
  assert.match(report, /问题在这里/);
});

test('inspect() 能指出“控制面板遮挡字幕”这一条', async () => {
  /* 面板若压在字幕上，用户同样看不到字幕，而此时尺寸/透明度/范围三项全正常。
   * 早期诊断漏了这条，是这次排查绕远路的原因之一。 */
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 8, showButton: true });
  overlay.attachTo(dom.video);
  overlay.syncNow();

  // 让字幕正常显示
  overlay.showCaption('测试字幕', false);
  overlay.caption._rect = { left: 100, top: 400, width: 400, height: 40, right: 500, bottom: 440 };

  // 面板正好压在这条字幕上
  const panel = overlay.host.shadowRoot.querySelector('.panel');
  assert.ok(panel, '面板节点应存在');
  panel._rect = { left: 80, top: 380, width: 500, height: 200, right: 580, bottom: 580 };

  const report = overlay.inspect();
  assert.match(report, /④ 未被控制面板遮挡：否/, '应报告面板遮挡了字幕');
  assert.match(report, /问题在这里/);
});

test('面板默认停在右下角（用户习惯的位置）', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 8, showButton: true });
  overlay.attachTo(dom.video);

  assert.equal(overlay.panel.style.right, '16px');
  assert.equal(overlay.panel.style.bottom, '16px');
  assert.equal(overlay.panel.style.left, '', '不该残留 left，否则面板会被拉宽');
  assert.equal(overlay.panel.style.top, '', '不该残留 top');
});

test('切换面板位置时清掉其他方向的偏移，避免被拉成长条', async () => {
  /* 这是真会出问题的地方：从右下角切到右上角时，如果只是加 top 而不清 bottom，
   * 面板会同时有 top 和 bottom，被拉成一条纵贯屏幕的长条。 */
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({
    fontSize: 22,
    bottomPercent: 8,
    showButton: true,
    panelPosition: 'bottom-right'
  });
  overlay.attachTo(dom.video);
  assert.equal(overlay.panel.style.bottom, '16px');

  overlay.positionPanel('top-right');
  assert.equal(overlay.panel.style.top, '16px');
  assert.equal(overlay.panel.style.right, '16px');
  assert.equal(overlay.panel.style.bottom, '', '切到顶部后必须清掉 bottom');
  assert.equal(overlay.panel.style.left, '');

  overlay.positionPanel('bottom-left');
  assert.equal(overlay.panel.style.left, '16px');
  assert.equal(overlay.panel.style.bottom, '16px');
  assert.equal(overlay.panel.style.right, '', '切到左侧后必须清掉 right');
  assert.equal(overlay.panel.style.top, '');

  overlay.positionPanel('top-left');
  assert.equal(overlay.panel.style.left, '16px');
  assert.equal(overlay.panel.style.top, '16px');
  assert.equal(overlay.panel.style.right, '');
  assert.equal(overlay.panel.style.bottom, '');
});

test('面板位置可以在构造时指定（设置项生效）', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({
    fontSize: 22,
    bottomPercent: 8,
    showButton: true,
    panelPosition: 'top-right'
  });
  overlay.attachTo(dom.video);
  assert.equal(overlay.panel.style.top, '16px');
  assert.equal(overlay.panel.style.right, '16px');
  assert.equal(overlay.panel.style.bottom, '');
});

test('非法位置值退回右下角，不会把面板甩出可视区域', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({
    fontSize: 22,
    bottomPercent: 8,
    showButton: true,
    panelPosition: 'somewhere-weird'
  });
  overlay.attachTo(dom.video);
  assert.equal(overlay.panel.style.right, '16px');
  assert.equal(overlay.panel.style.bottom, '16px');
});

test('inspect() 能指出字幕不可见的原因', async () => {
  const { NS, dom } = await loadOverlay({ videoWidth: 900, videoHeight: 500 });
  const overlay = new NS.Overlay({ fontSize: 22, bottomPercent: 8, showButton: true });
  overlay.attachTo(dom.video);
  overlay.syncNow();

  // 情况一：字幕为空 → 应显示"(空)"
  let report = overlay.inspect();
  assert.match(report, /字幕内容：\(空\)/);
  assert.match(report, /① 有可见尺寸/);

  // 情况二：显示一条字幕，并模拟它被渲染到视频外面
  overlay.showCaption('测试字幕', false);
  overlay.caption._rect = { left: 100, top: 900, width: 400, height: 40, right: 500, bottom: 940 };
  report = overlay.inspect();
  assert.match(report, /字幕内容：测试字幕/);
  assert.match(report, /③ 落在视频范围内：否/, '应明确指出字幕跑到了视频外面');
  assert.match(report, /问题在这里/);
});