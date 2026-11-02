/**
 * 字幕文本处理：清洗、跨块去重、按标点断句、导出 SRT/VTT。
 * 这里全是纯函数，方便直接用 Node 跑测试。
 */

/** 全角/半角标点统一成一套，便于断句和比较。 */
const PUNCT_MAP = new Map([
  ['，', ','], ['。', '.'], ['？', '?'], ['！', '!'], ['；', ';'], ['：', ':'],
  ['、', ','], ['（', '('], ['）', ')'], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['　', ' ']
]);

/** 句末标点：断句时优先在这些字符后面切。 */
const HARD_BREAK = /[.?!;。？！；…]/;
/** 句中标点：句末标点找不到时退而求其次。 */
const SOFT_BREAK = /[,:、，：]/;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** 西文字母，用来判断方括号里到底是“转写标注”还是“正常语音内容”。 */
const LATIN = /[A-Za-z]/;

/** 常见的非语音标注关键词。只有命中这些词才会被当噪声删掉。 */
const ANNOTATION_WORDS =
  /^(?:blank_?audio|silence|silent|music|noise|inaudible|applause|laughter|background\s*music|音乐|掌声|噪声|噪音|背景音乐|无声|静音|笑声|掌声响起)$/i;

/**
 * 识别模型在静音/无人说话时会吐出的幻觉文本。
 *
 * 注意这里只删“明确是标注”的内容，不能见到括号就删——
 * “时间复杂度是 O(n log n)”这种带括号的正常内容被删掉，
 * 是这类字幕插件最讨厌的 bug（早期版本就踩过）。
 */
const HALLUCINATION = /(?:\[|\(|（|【)\s*([^\]\)）】]{0,24}?)\s*(?:\]|\)|）|】)/g;

/** 把一段 ASR 文本规整化：去多余空白、统一标点、去掉明显是标注的括号内容。 */
export function normalizeText(raw) {
  if (!raw) return '';
  let text = String(raw);

  text = text.replace(HALLUCINATION, (match, inner) => {
    const content = inner.trim();
    if (!content) return ' ';
    if (ANNOTATION_WORDS.test(content)) return ' ';
    // 括号里只有“(掌声)”这种纯中文短语、且很短时才删；
    // 一旦出现英文字母或数字，就认定是正常内容，原样保留。
    if (!LATIN.test(content) && !/\d/.test(content) && content.length <= 8) return ' ';
    return match;
  });

  text = text.replace(/\s+/g, ' ');
  // 去掉标点前面的空格，再把连续标点收敛成一个
  for (const [from, to] of PUNCT_MAP) text = text.split(from).join(to);
  text = text.replace(/\s+([,.:;?!])/g, '$1');
  text = text.replace(/([,.:;?!])\1+/g, '$1');
  return text.trim();
}

/**
 * 从字符串里移除若干个“非噪声字符”，返回其后一个下标。
 *
 * “噪声字符”= 空白 + 标点 + 符号。必须只遍历一次、边数边定位：
 * 先数总数再重新扫一遍的做法，只要两次对“哪些字符算数”的判断有一丝差别就会错位。
 */
function indexAfterComparableChars(text, count) {
  let seen = 0;
  let i = 0;
  for (; i < text.length && seen < count; i++) {
    if (!NOISE_CHAR.test(text[i])) seen++;
  }
  return i;
}

/** 只有标点/空白的内容视为“没有内容”。 */
export function isMeaningful(text) {
  return /[\p{L}\p{N}]/u.test(text || '');
}

/**
 * 比较用的“裸文本”：去掉所有空白与标点。
 *
 * 这里踩过一个坑：早先只过滤了半角标点，于是“讲完了。”和“讲完了.”
 * 会被当成两段不同内容，去重判定的字符数也对不上原字符串的下标。
 * 现在统一用它做唯一标准，标点差异不会影响任何比较。
 */
const NOISE_CHAR = /[\s\p{P}\p{S}]/u;
const NOISE_CHARS = /[\s\p{P}\p{S}]/gu;

function comparableChunk(text) {
  return normalizeText(text).replace(NOISE_CHARS, '');
}

/**
 * 找出去重时该丢掉多少字符。
 * 在上一块尾部和新块头部之间找最长公共串。
 *
 * 阈值按语言区分：中文两个字就可能是“动态规划”这种完整词，值得去重；
 * 英文两三个字母的重合多半是巧合，所以要求长一些，避免误删真内容。
 */
function overlapCutLength(prevText, nextText) {
  const a = comparableChunk(prevText);
  const b = comparableChunk(nextText);
  if (!a || !b) return 0;

  // 整块都是重复的（例如极短的重复块）：直接全部去掉
  if (a.endsWith(b)) return b.length;

  const minLen = CJK.test(b) ? 2 : 5;
  const limit = Math.min(60, a.length, b.length);
  for (let len = limit; len >= minLen; len--) {
    if (a.slice(-len) === b.slice(0, len)) return len;
  }
  return 0;
}

/**
 * 把新块文本里与上一块重复的开头去掉。
 * 返回 { text, dropped }，dropped 是实际丢弃的“可比较字符”数，便于调试。
 */
export function dedupeAgainstPrevious(prevText, nextText) {
  const cleaned = normalizeText(nextText);
  if (!prevText || !cleaned) return { text: cleaned, dropped: 0 };
  const cut = overlapCutLength(prevText, cleaned);
  if (!cut) return { text: cleaned, dropped: 0 };

  // cut 是按“去掉标点空白”后的长度算的，换算回原字符串下标后切掉，
  // 再把切点残留的标点/空格清掉，否则会出现“，首先看定义”这种开头
  const idx = indexAfterComparableChars(cleaned, cut);
  const tail = cleaned.slice(idx);
  return { text: tail.replace(/^[\s\p{P}\p{S}]+/u, '').trim(), dropped: cut };
}

/**
 * 被去掉的开头占整块文本的比例。
 *
 * 这个比例必须回传给时间轴计算：相邻音频块重叠 1 秒，如果新块开头那 1 秒的
 * 内容因为重复被删掉了，那么“剩下的文字”对应的时间也已经往后推了 1 秒。
 * 不做这个修正，字幕会比实际说话早约 1 秒出现。
 */
export function dedupePrefixRatio(prevText, nextText) {
  const cleaned = normalizeText(nextText);
  const total = comparableChunk(cleaned).length;
  if (!total) return 0;
  const { dropped } = dedupeAgainstPrevious(prevText, cleaned);
  return Math.min(1, dropped / total);
}

/** 中英混排时，两个片段拼接要不要加空格。 */
function joinWithSpace(a, b) {
  if (!a) return b;
  if (!b) return a;
  const lastChar = a.slice(-1);
  const firstChar = b.slice(0, 1);
  if (CJK.test(lastChar) || CJK.test(firstChar)) return a + b;
  return a + ' ' + b;
}

/**
 * 把一个时间区间内的长文本切成若干条字幕。
 * 按标点优先切；切不出来就按最大字数硬切。
 */
export function splitIntoSegments(text, start, end, options = {}) {
  const maxChars = options.maxChars || 34;
  const cleaned = normalizeText(text);
  if (!isMeaningful(cleaned) || end <= start) return [];

  const pieces = [];
  let buffer = '';
  const chars = Array.from(cleaned);

  const flush = () => {
    const t = buffer.trim();
    if (t) pieces.push(t);
    buffer = '';
  };

  for (const ch of chars) {
    buffer += ch;
    const length = Array.from(buffer).length;
    if (HARD_BREAK.test(ch) && length >= 8) flush();
    else if (length >= maxChars) {
      if (SOFT_BREAK.test(ch)) flush();
      else if (length >= maxChars + 12) flush();
    }
  }
  flush();

  if (pieces.length <= 1) {
    return [{ start, end, text: pieces[0] || cleaned }];
  }

  // 按字数比例分配时间，长的分到更多时间
  const total = pieces.reduce((sum, p) => sum + Array.from(p).length, 0) || 1;
  const span = end - start;
  let cursor = start;
  return pieces.map((piece, i) => {
    const ratio = Array.from(piece).length / total;
    const segStart = cursor;
    const segEnd = i === pieces.length - 1 ? end : Math.min(end, segStart + span * ratio);
    cursor = segEnd;
    return { start: round3(segStart), end: round3(segEnd), text: piece };
  });
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * 去重造成的“时间偏移比例”上限。
 *
 * 已被字幕覆盖到 t 秒，而新块从 start 秒就开始录音了，
 * 那么新块开头这段被去重的内容，最多只可能占了 (t - start) 秒的音频。
 * 把这段时间换算成占整块的比例，就是偏移比例不能超过的值。
 */
function maxShiftRatio(track, chunkStart, span) {
  const last = track.segments[track.segments.length - 1];
  if (!last || span <= 0) return 0;
  const overlapSeconds = Math.max(0, Math.min(span, last.end - chunkStart));
  return overlapSeconds / span;
}

/**
 * 累积器：把一块块识别结果合并成一条连续字幕轨。
 * 关键点——每块都知道自己在视频时间轴上的真实起止时间，
 * 因此暂停、拖动进度条、切集都不会让字幕错位。
 */
export class SubtitleTrack {
  constructor(options = {}) {
    /**
     * 字幕段。**必须始终保持按 start 递增**。
     *
     * 为什么这是个硬性前提：`segmentAt()` 用二分查找、`lastSegmentBefore()`
     * 一旦遇到没结束的段就 break，两者的正确性都建立在“数组有序”之上。
     *
     * 而块是**异步**识别、按**完成顺序**回来的——单块识别耗时实测从 1 秒
     * 到 70 秒都出现过，所以后发的块完全可能先回来。原来这里是无脑 push，
     * 一旦乱序，二分查找会查到错误的区间，该显示的字幕被整条跳过，
     * 表现就是“中间那段字幕压根不显示”。插入时保证有序即可根治。
     */
    this.segments = [];
    this.maxChars = options.maxChars || 34;
    this.splitLongLines = options.splitLongLines !== false;
    /** 每条字幕的最短显示秒数，避免短句一闪而过 */
    this.minDisplaySeconds = Number.isFinite(options.minDisplaySeconds)
      ? Math.max(0.3, Math.min(3, options.minDisplaySeconds))
      : 1.2;
    this.contextText = '';
  }

  /** @param {{start:number,end:number,text:string}} chunk */
  addChunk(chunk) {
    const text = normalizeText(chunk.text);
    if (!isMeaningful(text) || chunk.end <= chunk.start) {
      return { added: [], skipped: true };
    }

    const { text: fresh } = dedupeAgainstPrevious(this.contextText, text);
    if (!isMeaningful(fresh)) {
      this.contextText = joinWithSpace(this.contextText, text).slice(-400);
      return { added: [], skipped: true };
    }

    /* 开头被去掉了，说明剩下的文字是这一块的后段才说的，时间要往后挪。
     *
     * 挪多少由两个量共同决定，取较小者：
     *  1. 按字数比例推算（去掉了 44% 的字，就往后推 44% 的时长）；
     *  2. 物理上界——上一块覆盖到 lastCovered 秒，而这一块从 start 秒就开始录了，
     *     所以被去重的那段音频最多只有 (lastCovered - start) 秒，
     *     时间偏移不可能超过它。
     *
     * 只按比例推算会在短块上翻车：一块只有 12 秒、说话很快时，
     * 去重掉 7 个字可能占全文 44%，按比例就要推 5 秒多，
     * 而两块之间其实只重叠了 2 秒，字幕会明显迟到。
     */
    const span = chunk.end - chunk.start;
    const ratioCeiling = maxShiftRatio(this, chunk.start, span);
    const ratio = Math.min(dedupePrefixRatio(this.contextText, text), ratioCeiling);
    const effectiveStart = chunk.start + span * ratio;

    const segments = this.splitLongLines
      ? splitIntoSegments(fresh, effectiveStart, chunk.end, { maxChars: this.maxChars })
      : [{ start: effectiveStart, end: chunk.end, text: fresh }];

    /* 给过短的片段补足最短显示时长。
     *
     * 为什么必须做：文字是按字数比例摊到整块时长上的，短句（如“好，我们继续。”）
     * 只分到零点几秒，字幕一闪而过，用户感觉“几乎看不到、很不连贯”。
     *
     * 规则很简单：结束时间至少推到 start + minDisplaySeconds；
     * 但除了最后一条之外，都不能越过下一条的开始时间（否则两条会叠在一起）。
     * 最后一条允许稍微超出本块末尾——反正下一块回来还要一会儿，
     * 让字幕多停留一下反而更自然。
     */
    const minDisplay = this.minDisplaySeconds;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const wanted = segment.start + minDisplay;
      if (segment.end >= wanted) continue;
      const isLast = i === segments.length - 1;
      const ceiling = isLast ? wanted : segments[i + 1].start;
      segment.end = Math.min(wanted, Math.max(segment.end, ceiling));
    }

    const added = [];
    for (const segment of segments) {
      /* 插入前先看“时间上紧邻的前一条”，而不是数组里的最后一条。
       *
       * 这条区别在乱序到达时是致命的：迟到 30 秒的旧块如果拿数组最后一条
       * （30 秒后的内容）去比重叠，整段文字会被挪到三十秒之后，内容就废了。
       * 对照插入位置前面的那一条才是语义正确的。 */
      const at = this.insertIndex(segment.start);
      const prev = at > 0 ? this.segments[at - 1] : null;
      if (prev && segment.start < prev.end) {
        // 与上一条重叠：把上一条的结束时间提前收住，而不是丢掉这段文字。
        // 丢掉文字会让用户觉得“漏了一句”，把结束时间提前则完全看不出来。
        const midpoint = (prev.start + segment.end) / 2;
        segment.start = Math.max(segment.start, midpoint);
        if (prev.end > segment.start) prev.end = segment.start;
      }
      if (segment.end <= segment.start) continue;
      // 起点可能被上面的调整推后了，插入位置要重算，保证数组始终有序
      this.segments.splice(this.insertIndex(segment.start), 0, segment);
      added.push(segment);
    }

    this.contextText = joinWithSpace(this.contextText, fresh).slice(-400);
    return { added, skipped: false };
  }

  /**
   * 直接插入一批**自带时间戳**的字幕段（流式识别用）。
   *
   * 与 addChunk 的区别在时间怎么来：
   *   addChunk 拿到的是「一整块文本 + 这一块的时间区间」，只能按标点断句、
   *   再按字数把区间摊开——那是估的；
   *   流式识别返回的每一段都带服务端算出的真实起止时间，不需要也不该再估一次。
   *
   * 之所以还要在这里插一遍，而不是直接 push：字幕段必须让数组保持按 start
   * 递增（segmentAt 的二分查找依赖这个前提），而且相邻两段在音频上有重叠时
   * 要把前一段的结束时间收住，否则同一条字幕会横跨到下一句上。
   */
  addTimedSegments(list) {
    const added = [];
    if (!Array.isArray(list)) return { added };

    for (const item of list) {
      const text = normalizeText(item && item.text);
      if (!isMeaningful(text)) continue;

      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

      const segment = { start, end, text };
      const at = this.insertIndex(segment.start);
      const prev = at > 0 ? this.segments[at - 1] : null;
      if (prev && segment.start < prev.end) {
        // 与上一条重叠：把上一条的结束时间提前收住，而不是丢掉这段文字。
        // 丢掉文字会让用户觉得“漏了一句”，收住结束时间则完全看不出来。
        const midpoint = (prev.start + segment.end) / 2;
        segment.start = Math.max(segment.start, midpoint);
        if (prev.end > segment.start) prev.end = segment.start;
      }
      if (segment.end <= segment.start) continue;
      // 起点可能被上面调整过，插入位置要重算，保证数组始终有序
      this.segments.splice(this.insertIndex(segment.start), 0, segment);
      added.push(segment);
    }

    if (added.length) {
      const appended = added.map((s) => s.text).join('');
      this.contextText = joinWithSpace(this.contextText, appended).slice(-400);
    }
    return { added };
  }

  /** 二分找出第一个 start >= 给定值的下标，用于把新段插到正确位置上。 */
  insertIndex(start) {
    let lo = 0;
    let hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.segments[mid].start < start) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 视频拖动/切集时清空。 */
  reset() {
    this.segments = [];
    this.contextText = '';
  }

  /** 按当前播放时间找字幕，二分查找。 */
  segmentAt(time) {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = this.segments[mid];
      if (time < seg.start) hi = mid - 1;
      else if (time >= seg.end) lo = mid + 1;
      else return seg;
    }
    return null;
  }

  /** 最近的一条已结束字幕，用于“刚说完还没生成下一条”时保持显示。 */
  lastSegmentBefore(time) {
    let result = null;
    for (const seg of this.segments) {
      if (seg.end <= time) result = seg;
      else break;
    }
    return result;
  }

  toJSON() {
    return { segments: this.segments, contextText: this.contextText };
  }

  static fromJSON(data, options = {}) {
    const track = new SubtitleTrack(options);
    if (data && Array.isArray(data.segments)) {
      track.segments = data.segments.map((s) => ({ ...s }));
      track.contextText = data.contextText || '';
    }
    return track;
  }
}

function formatTimestamp(seconds, comma) {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${comma ? ',' : '.'}${pad(millis, 3)}`;
}

export function toSRT(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${formatTimestamp(seg.start, true)} --> ${formatTimestamp(seg.end, true)}\n${seg.text}\n`)
    .join('\n');
}

export function toVTT(segments) {
  const body = segments
    .map((seg) => `${formatTimestamp(seg.start, false)} --> ${formatTimestamp(seg.end, false)}\n${seg.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** 把整条轨拼成纯文本，用于复制。 */
export function toPlainText(segments) {
  let out = '';
  for (const seg of segments) out = joinWithSpace(out, seg.text);
  return out;
}
