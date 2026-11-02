/**
 * 全局配置：默认值、读写、以及几个预设供应商。
 *
 * 这里刻意做成“OpenAI 兼容协议”优先：只要是 POST {baseUrl}/audio/transcriptions
 * 且接受 multipart file + model 的服务，都能直接接进来。
 */

export const STORAGE_KEY = 'zimu.settings.v1';
export const CACHE_KEY = 'zimu.cache.v1';

/** 预设供应商。baseUrl 填写到 /v1 为止（不要带 /audio/transcriptions）。 */
export const PROVIDERS = {
  siliconflowQwenAsr: {
    label: '硅基流动 · Qwen3-ASR-1.7B（首推：中文最准，免费）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-ASR-1.7B',
    apiStyle: 'transcriptions',
    needsKey: true,
    note:
      '当前最强的开源中文识别模型之一：普通话基准 CER 约 1.6%，大致是 SenseVoiceSmall 的一半；' +
      '对会议/带口音/有背景音的课堂语音也明显更稳。硅基流动把这类语音模型标为免费。' +
      '走标准的 /audio/transcriptions 接口，换过来只需改这个下拉框。'
  },
  siliconflowXingchen: {
    label: '硅基流动 · 星辰 XingChenASR-V3.2-Ultra（方言强，免费）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'XingChenAGI/XingChenASR-V3.2-Ultra',
    apiStyle: 'transcriptions',
    needsKey: true,
    note:
      '中国电信的工业级模型，中英+60 种方言可混说，普通话朗读字准约 97%。' +
      '它会对口语做“可读性规整”（顺手补标点、删口头禅、理顺语序），念着更顺；' +
      '代价是**不逐字忠实原话**。做字幕优先选上面的 Qwen3-ASR，' +
      '只有讲方言或口音很重时才换这个。'
  },
  bailianQwenAsr: {
    label: '阿里云百炼 · qwen3-asr-flash（准，送 10 小时）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash',
    apiStyle: 'chat',
    needsKey: true,
    note:
      '与 Qwen3-ASR-1.7B 同源，跑在阿里云百炼上，新用户有 10 小时免费额度。' +
      '它走的是 /chat/completions（音频塞在 messages 里），不是 /audio/transcriptions——' +
      '本插件已按这个协议发请求，选它即可，不用自己改地址。'
  },
  bailianFunAsr: {
    label: '阿里云百炼 · Fun-ASR（实验性，见说明）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'fun-asr',
    apiStyle: 'chat',
    needsKey: true,
    note:
      '阿里自研的工业级模型，带智能标点与文本归一化（“三千五百”直接写成 3500）。' +
      '注意：百炼上 Fun-ASR 的官方接口是**异步文件转写**（提交任务再轮询），' +
      '与逐块实时识别不是一条路。这里先按 OpenAI 兼容的 chat 协议试，' +
      '若“测试连接”报 400/404，请改用上面的 qwen3-asr-flash。'
  },
  siliconflow: {
    label: '硅基流动 · SenseVoiceSmall（免费，但准确率一般）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    apiStyle: 'transcriptions',
    needsKey: true,
    note:
      '国内可直连、免费，但模型只有 234M 且**不利用上下文**，' +
      '课堂这种快语速、带术语的内容容易出“数据机/是越小越小”这类错字。' +
      '它也是本项目此前的默认值——如果你看到大量错字，换上面的 Qwen3-ASR。'
  },
  localWhisper: {
    label: '本地 Whisper（不联网，但吃本机 CPU/内存）',
    baseUrl: 'http://127.0.0.1:8788/v1',
    model: 'local-whisper',
    apiStyle: 'transcriptions',
    needsKey: false,
    note:
      '由本项目的 tools/local-asr/server.py 提供，模型跑在你自己电脑上，' +
      '不吃云端额度、也没有排队延迟。代价是占本机 CPU/内存（small 约 1GB，首次要下 460MB 模型）。' +
      '启动命令见 README。'
  },
  local: {
    label: '本地中继（转发到云端服务）',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'whisper-1',
    apiStyle: 'transcriptions',
    needsKey: false,
    note: '由本项目的 tools/server 提供。中继服务自己持有上游 API Key，扩展里可以留空。'
  },
  openai: {
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    apiStyle: 'transcriptions',
    needsKey: true,
    note: '需要能访问 api.openai.com。whisper-1 支持 verbose_json 返回分段时间戳。'
  },
  custom: {
    label: '自定义（任何 OpenAI 兼容服务）',
    baseUrl: '',
    model: 'whisper-1',
    apiStyle: 'transcriptions',
    needsKey: true,
    note:
      '自建网关、Azure OpenAI、Groq、通义/讯飞的兼容层等都可以。' +
      '若对方把音频收在 /chat/completions 的 messages 里（“生成式 ASR”类模型常见），' +
      '把下面“调用协议”改成 chat completions。'
  }
};

export const DEFAULT_SETTINGS = {
  provider: 'localWhisper',
  baseUrl: PROVIDERS.localWhisper.baseUrl,
  apiKey: '',
  model: PROVIDERS.localWhisper.model,
  /**
   * 调用协议。两种都是 OpenAI 系的接口形状，但端点不同：
   *
   *  transcriptions —— POST {baseUrl}/audio/transcriptions，用 multipart 上传文件。
   *                    OpenAI、硅基流动、Groq、绝大多数兼容层走这条。
   *  chat            —— POST {baseUrl}/chat/completions，音频作为 input_audio
   *                    塞进 messages。阿里云百炼的 qwen3-asr-flash、
   *                    以及“生成式 ASR”类模型（如 XingChenGSR）走这条。
   *
   * 选错协议的报错很干净（400/404），所以设置面板会把最终请求地址显示出来，
   * 让用户一眼看出到底发去了哪个端点。
   */
  apiStyle: 'transcriptions',
  /** 识别语言，zh 表示中文。留空让服务自动判断。 */
  language: 'zh',
  /**
   * 音频来源。
   *  auto    —— 先用视频元素（精准，只含这个视频的声音），读不到再自动改抓整个标签页
   *  element —— 只用视频元素；读不到就如实报错
   *  tab     —— 直接抓整个标签页的声音（兼容性最好，代价是包含页面里的其他声音）
   */
  captureMode: 'auto',
  /**
   * 每块音频秒数。太短会切碎句子，太长会明显延迟。
   *
   * 默认给 6 秒而不是更大值，是实测权衡的结果：延迟 ≈ 分块秒数 + 识别耗时。
   * 12 秒时用户感受到“字幕比语音落后十几二十秒”，严重影响观看；
   * 6 秒时延迟约 7~10 秒，已经可以接受。
   * 因为相邻块有 1 秒重叠，缩小分块带来的请求量增加约 17%，不是翻倍。
   */
  chunkSeconds: 6,
  /** 每块额外多录的重叠秒数，用于跨块断句纠错。 */
  overlapSeconds: 1,
  /**
   * 流式识别。
   *
   * 分段模式的延迟下限是「分块秒数 + 识别耗时」——必须等一块录满才发得出去。
   * 打开流式后改成**小切片连续投喂**：客户端每 1~2 秒发一次，服务端把还没定稿的
   * 音频反复解码，只把「相邻两次解码结果一致的前缀」定稿发回来。
   * 延迟因此降到 1~2 秒，代价是同一段音频被反复解码、CPU 占用明显上升。
   *
   * 只对**本机识别服务**生效（云端按次计费，反复解码等于反复收费）；
   * 服务端不支持或连续失败时会自动退回分段模式。
   */
  streaming: true,
  /** 流式模式每次投喂的音频秒数。 */
  streamSliceSeconds: 1.6,
  /** 流式模式相邻切片的重叠秒数。 */
  streamOverlapSeconds: 0.4,
  /** 是否在页面右下角显示悬浮控制按钮 */
  showFloatingButton: true,
  /**
   * 悬浮面板的位置：bottom-right（默认）、top-right、top-left、bottom-left。
   *
   * 为什么要可改：右下角是大家习惯的位置，但它**会压住视频底部的字幕**；
   * 换成左上角又会挡课程正文。所以给个选项，默认保持用户熟悉的位置。
   *
   * 2026-10 起有了更好的解法：`panelCollapsed` 让面板能贴边收起，
   * 遮挡时收起来即可，不必再为避开字幕而把面板挪到碍事的角度。
   */
  panelPosition: 'bottom-right',
  /**
   * 悬浮窗是否收起成一条窄边。
   *
   * 收起后整个面板滑到视频侧边，只在边缘留一条能点回来的窄条——
   * 和游戏助手一样的交互。这样做的好处很直接：字幕压在底部居中，
   * 而面板默认也在底部，两者必然互相遮盖；收起来就互不打扰了。
   * 点窄条即可展开，展开/收起的状态会被记住。
   */
  panelCollapsed: false,
  /** 字幕字号（px，相对视频宽度的基准值） */
  fontSize: 22,
  /**
   * 字幕距视频底部距离（%）。
   *
   * 默认从 8 降到 6：用户实测反馈“字幕位置偏高”，旧值还叠加了一条
   * “至少留 12% 视频高度”的硬下限，在 600px 高的播放器上等于强制留在
   * 72px 处——屏幕上看起来就是悬在半空。现在去掉那条下限，默认贴着底部走。
   */
  bottomPercent: 6,
  /**
   * 字幕底色的不透明度（0~100）。
   *
   * 0 = 完全透明，只剩文字本身（靠文字阴影保持可读）。
   * 全黑底在浅色课件上太抢眼，用户明确要求可调并且能调到全透明。
   */
  captionOpacity: 72,
  /**
   * 逐字显示（打字机效果）。
   *
   * 打开后一条字幕会**一个字一个字地冒出来**，而不是整句“啪”地一下出现。
   * 节奏跟着**这句话自己的音频时长**走（6 秒说完的句子就花 6 秒打完），
   * 所以字的出场顺序和话音是对得上的；早晚拿到的字幕都能赶上这个节奏，
   * 只是整体前后平移。详见 Controller.typewriterSlice()。
   */
  typewriter: true,
  /** 是否把识别结果按标点拆成更短的两行 */
  splitLongLines: true,
  /** 是否在本地缓存已生成的字幕（按视频地址） */
  enableCache: true,
  /** 调试日志 */
  debug: false
};

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.chunkSeconds = clampNumber(s.chunkSeconds, 4, 60, DEFAULT_SETTINGS.chunkSeconds);
  s.overlapSeconds = clampNumber(s.overlapSeconds, 0, 5, DEFAULT_SETTINGS.overlapSeconds);
  s.streamSliceSeconds = clampNumber(s.streamSliceSeconds, 1, 5, DEFAULT_SETTINGS.streamSliceSeconds);
  s.streamOverlapSeconds = clampNumber(s.streamOverlapSeconds, 0, 2, DEFAULT_SETTINGS.streamOverlapSeconds);
  s.streaming = s.streaming !== false;
  s.fontSize = clampNumber(s.fontSize, 12, 48, DEFAULT_SETTINGS.fontSize);
  s.bottomPercent = clampNumber(s.bottomPercent, 0, 40, DEFAULT_SETTINGS.bottomPercent);
  s.captionOpacity = clampNumber(s.captionOpacity, 0, 100, DEFAULT_SETTINGS.captionOpacity);
  s.typewriter = s.typewriter !== false;
  s.panelCollapsed = s.panelCollapsed === true;
  if (typeof s.baseUrl === 'string') s.baseUrl = s.baseUrl.trim().replace(/\/+$/, '');
  if (!['auto', 'element', 'tab'].includes(s.captureMode)) s.captureMode = DEFAULT_SETTINGS.captureMode;
  /** 调用协议只接受这两个预设值；非法值退回默认，避免把请求发到不存在的端点。 */
  if (!['transcriptions', 'chat'].includes(s.apiStyle)) s.apiStyle = DEFAULT_SETTINGS.apiStyle;

  /** 面板位置只接受预设值；非法值一律退回默认，避免把面板甩出可视区域。 */
  const PANEL_POSITIONS = ['bottom-right', 'top-right', 'top-left', 'bottom-left'];
  if (!PANEL_POSITIONS.includes(s.panelPosition)) s.panelPosition = DEFAULT_SETTINGS.panelPosition;
  if (typeof s.apiKey === 'string') s.apiKey = s.apiKey.trim();
  if (typeof s.model === 'string') s.model = s.model.trim();
  if (s.language === 'auto') s.language = '';
  return s;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** 只把可以给页面脚本看的部分发给 content script（不含 apiKey）。 */
export function publicSettings(settings) {
  const { apiKey, ...rest } = settings;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

/**
 * 算出某个接口地址需要申请的 host permission 匹配串。
 *
 * baseUrl 可能带路径（自建网关常见：https://gw.example.com/tenant-a/v1），
 * 只申请域名根路径会匹配不上，请求会被浏览器拦掉，所以路径要一起带上。
 */
export function permissionPatternFor(url) {
  const parsed = new URL(url);
  const dir = parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname + '/';
  return `${parsed.origin}${dir}*`;
}

/** 该地址是否指向本机中继（本机中继自己持有上游 Key，扩展这边可以留空）。 */
export function isLocalRelayUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch (err) {
    return false;
  }
}

/**
 * 算出这次请求实际会打到哪个端点。
 *
 * 单独抽出来是为了两件事：
 *  1. 设置面板能**原样显示**它——用户填的地址和真实请求地址常常不是一回事
 *     （少一个 /v1、或协议选错导致端点名不对），显示出来能省掉一整轮排查；
 *  2. 客户端与显示端共用同一条拼接规则，不会出现“面板说发去 A、实际发去 B”。
 */
export function resolveEndpointUrl(baseUrl, apiStyle) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  const suffix = apiStyle === 'chat' ? '/chat/completions' : '/audio/transcriptions';
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}
