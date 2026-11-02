/**
 * 字幕处理逻辑的单元测试。用 Node 自带 test runner，无需安装任何依赖：
 *   node --test test/
 *
 * 重点验证三件容易出错的事：
 *  1. 跨块去重（视频分块识别时相邻块会重复同一句话）；
 *  2. 时间戳分配（每块用视频真实时间轴，成败直接影响字幕对齐）；
 *  3. 拖动进度条后不出现时间重叠的字幕。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeText,
  isMeaningful,
  dedupeAgainstPrevious,
  dedupePrefixRatio,
  splitIntoSegments,
  SubtitleTrack,
  toSRT,
  toVTT,
  toPlainText
} from '../src/common/transcript.js';

test('normalizeText 清理空白与全角标点', () => {
  assert.equal(normalizeText('  你好   世界  '), '你好 世界');
  assert.equal(normalizeText('你好，世界。'), '你好,世界.');
  assert.equal(normalizeText('测试 ；标点 ！'), '测试;标点!');
});

test('normalizeText 去掉识别模型在静音处的幻觉输出', () => {
  assert.equal(normalizeText('[BLANK_AUDIO]'), '');
  assert.equal(normalizeText('前面的话 [BLANK_AUDIO] 后面的话'), '前面的话 后面的话');
  assert.equal(normalizeText('(silence)'), '');
  assert.equal(normalizeText('（掌声）'), '');
});

test('isMeaningful 只认真正有内容的文本', () => {
  assert.equal(isMeaningful('你好'), true);
  assert.equal(isMeaningful('abc123'), true);
  assert.equal(isMeaningful('   ,.  '), false);
  assert.equal(isMeaningful(''), false);
  assert.equal(isMeaningful(null), false);
});

test('dedupeAgainstPrevious 去掉与上一块重复的开头', () => {
  const prev = '今天我们讲的是快速排序算法';
  const next = '快速排序算法的时间复杂度是 O(n log n)';
  const { text, dropped } = dedupeAgainstPrevious(prev, next);
  // 两块的真实重叠只有“快速排序算法”6 个字，前面的“今天我们讲的是”不重复
  assert.equal(dropped, 6);
  assert.equal(text, '的时间复杂度是 O(n log n)');
});

test('dedupeAgainstPrevious 不会把括号里的内容当成标点丢掉', () => {
  // 回归测试：早期版本把括号也当噪声字符，导致 “O(n log n)” 被截成 “O”
  const { text } = dedupeAgainstPrevious('前面的话', '前面的话 O(n log n) 的复杂度');
  assert.ok(text.includes('O(n log n)'), `括号内容应完整保留，实际：${text}`);
});

test('dedupeAgainstPrevious 完全不重叠时原样保留', () => {
  const { text, dropped } = dedupeAgainstPrevious('第一句话', '完全不同的另一句话');
  assert.equal(dropped, 0);
  assert.equal(text, '完全不同的另一句话');
});

test('dedupeAgainstPrevious 忽略标点差异', () => {
  const { text } = dedupeAgainstPrevious('这一节我们讲动态规划。', '这一节我们讲动态规划, 首先看定义');
  assert.equal(text, '首先看定义');
});

test('dedupeAgainstPrevious 不会把整块内容吃光', () => {
  // 新块和上一块完全一样时（极短的重复块），允许被判定为纯重复
  const { text } = dedupeAgainstPrevious('你好', '你好');
  assert.equal(text, '');
});

test('splitIntoSegments 按标点切成多条并保持时间递增', () => {
  const text = '第一句话讲完了。第二句话稍微长一点。第三句话收尾。';
  const segments = splitIntoSegments(text, 10, 22, { maxChars: 12 });
  assert.ok(segments.length >= 2, `应切成多条，实际 ${segments.length}`);
  assert.equal(segments[0].start, 10);
  assert.equal(segments[segments.length - 1].end, 22);
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].start >= segments[i - 1].end - 1e-9, '时间不得重叠');
  }
  // 内容不能丢：拆出来的句子拼起来应当等于原始文本（标点已统一成半角）
  const strip = (s) => s.replace(/[\s\p{P}\p{S}]/gu, '');
  assert.equal(strip(segments.map((s) => s.text).join('')), strip(text));
});

test('全角句号和半角句号被视为同一标点（回归测试）', () => {
  // 早先只过滤半角标点，导致“讲完了。”与“讲完了.”被当成不同内容，
  // 去重时下标也会错位。这里锁死行为，防止再退化。
  const { text } = dedupeAgainstPrevious('我们讲完了。', '我们讲完了. 下面是下一节。');
  assert.equal(text, '下面是下一节.');
  assert.equal(normalizeText('我们讲完了。'), '我们讲完了.');
});

test('splitIntoSegments 对无标点的长英文硬切', () => {
  const text = 'a'.repeat(90);
  const segments = splitIntoSegments(text, 0, 30, { maxChars: 30 });
  assert.ok(segments.length >= 3);
  assert.equal(segments.map((s) => s.text).join(''), text);
});

test('splitIntoSegments 空内容返回空数组', () => {
  assert.deepEqual(splitIntoSegments('', 0, 5), []);
  assert.deepEqual(splitIntoSegments('[BLANK_AUDIO]', 0, 5), []);
  assert.deepEqual(splitIntoSegments('有内容', 5, 5), []);
});

test('SubtitleTrack 用视频时间轴定位，不受暂停影响', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 0, end: 8, text: '同学们好,今天我们学习二叉树。' });
  track.addChunk({ start: 20, end: 28, text: '刚才暂停了一下,现在继续。' });

  assert.ok(track.segments.length >= 2);
  const atStart = track.segmentAt(1);
  assert.ok(atStart, '第 1 秒应有字幕');
  const atResume = track.segmentAt(21);
  assert.ok(atResume, '第 21 秒应有字幕（暂停期间时间轴没走）');
  assert.equal(track.segmentAt(12), null, '空白区间不应有字幕');
});

test('SubtitleTrack 跨块去重后不会重复显示同一句', () => {
  const track = new SubtitleTrack({ splitLongLines: false });
  track.addChunk({ start: 0, end: 10, text: '这一节我们讲动态规划' });
  track.addChunk({ start: 10, end: 20, text: '这一节我们讲动态规划的基本思想' });
  const all = track.segments.map((s) => s.text).join(' ');
  const occurrences = all.split('这一节我们讲动态规划').length - 1;
  assert.equal(occurrences, 1, `重复内容应只出现一次，实际：${all}`);
});

test('SubtitleTrack 跳过静音块与无意义块', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 0, end: 5, text: '[BLANK_AUDIO]' });
  track.addChunk({ start: 5, end: 10, text: '  ' });
  assert.equal(track.segments.length, 0);
});

test('SubtitleTrack 修改后的时间序列严格不倒退', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 0, end: 6, text: '第一段内容比较长,需要拆开看看。' });
  track.addChunk({ start: 4, end: 9, text: '第二段故意与上一段时间重叠。' });
  for (let i = 1; i < track.segments.length; i++) {
    assert.ok(
      track.segments[i].start >= track.segments[i - 1].end - 1e-9,
      `第 ${i} 条与上一条时间重叠：${JSON.stringify(track.segments)}`
    );
  }
});

test('SubtitleTrack reset 后清空', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 0, end: 5, text: '一些内容。' });
  assert.ok(track.segments.length > 0);
  track.reset();
  assert.equal(track.segments.length, 0);
  assert.equal(track.segmentAt(1), null);
});

test('dedupePrefixRatio 反映被去掉的开头占比', () => {
  // 新块里前 6 个字（快速排序算法）是重复的，去掉标点后共 19 个有效字 → 约 0.32
  const ratio = dedupePrefixRatio('今天我们讲的是快速排序算法', '快速排序算法的时间复杂度是 O(n log n)');
  assert.ok(ratio > 0.3 && ratio < 0.35, `比例应在 0.30~0.35 之间，实际 ${ratio}`);
  assert.equal(dedupePrefixRatio('完全不相关', '另一段内容'), 0);
});

test('短片段会被补足最短显示时长（字幕不再一闪而过）', () => {
  /* 真实故障：识别成功后用户几乎看不到字幕，因为文字是按字数比例摊到整块时长上的，
   * 短句只分到零点几秒。这里锁住“补足最短显示时长”的行为。 */
  const track = new SubtitleTrack({ minDisplaySeconds: 1.2 });
  // 一整块 12 秒，但只有很短的一句 → 按比例它只占不到 1 秒
  track.addChunk({ start: 0, end: 12, text: '好。' });

  assert.equal(track.segments.length, 1);
  const seg = track.segments[0];
  const duration = seg.end - seg.start;
  assert.ok(duration >= 1.2 - 1e-9, `短句显示时长应补足到 1.2 秒，实际 ${duration.toFixed(2)} 秒`);
});

test('补足显示时长不会让两条字幕重叠', () => {
  const track = new SubtitleTrack({ minDisplaySeconds: 1.2, splitLongLines: true });
  track.addChunk({
    start: 0,
    end: 6,
    text: '第一句很短。第二句也很短。第三句同样短。'
  });

  assert.ok(track.segments.length >= 2, `应拆成多条，实际 ${track.segments.length}`);
  for (let i = 1; i < track.segments.length; i++) {
    assert.ok(
      track.segments[i].start >= track.segments[i - 1].end - 1e-9,
      `第 ${i} 条与上一条重叠：${JSON.stringify(track.segments)}`
    );
  }
});

test('补足时长后，整个显示窗口内都能查到这个片段', () => {
  /* 这条覆盖渲染层的连贯性：renderLoop 靠 segmentAt 找当前该显示哪条，
   * 时间窗口被补足后，窗口内任意时刻都应能查到它，字幕才不会闪断。 */
  const track = new SubtitleTrack({ minDisplaySeconds: 1.5 });
  track.addChunk({ start: 0, end: 12, text: '好。' });
  const seg = track.segments[0];

  for (const t of [seg.start, seg.start + 0.5, seg.start + 1.0, seg.start + 1.4]) {
    assert.equal(track.segmentAt(t), seg, `在 ${t.toFixed(2)}s 应能查到该字幕`);
  }
});

test('最短显示时长参数有合理边界', () => {
  assert.ok(new SubtitleTrack({ minDisplaySeconds: 999 }).minDisplaySeconds <= 3, '不应超过 3 秒');
  assert.ok(new SubtitleTrack({ minDisplaySeconds: 0.01 }).minDisplaySeconds >= 0.3, '不应小于 0.3 秒');
});

test('重叠块的字幕时间会随去重比例往后修正，且不超过真实重叠时长', () => {
  // 场景：相邻音频块重叠 2 秒（0→10 与 8→20）。
  // 第二块开头那部分内容在上一块里已经识别过，被去重删掉，
  // 那么剩下的文字实际是这一块的后段才说的，不能标成块起点 8 秒。
  const track = new SubtitleTrack({ splitLongLines: false });
  track.addChunk({ start: 0, end: 10, text: '这一节我们讲动态规划,它的定义很重要。' });
  const before = track.segments.length;
  track.addChunk({ start: 8, end: 20, text: '它的定义很重要,核心是状态转移方程。' });

  assert.ok(track.segments.length > before, '第二块应产生新字幕');
  const added = track.segments[track.segments.length - 1];
  assert.ok(added.start > 8, `修正后开始时间应晚于块起点 8s，实际 ${added.start}`);
  // 音频重叠只有 2 秒，修正幅度不该超过它，否则字幕会迟到
  assert.ok(added.start <= 10.001, `修正幅度不应超过真实重叠时长 2s，实际 ${added.start}`);
});

test('重叠修正不会把文字丢掉', () => {
  const track = new SubtitleTrack({ splitLongLines: false });
  track.addChunk({ start: 0, end: 12, text: '前面这句话会和新块开头重复。' });
  track.addChunk({ start: 10, end: 22, text: '前面这句话会和新块开头重复,后面还有新内容。' });
  const all = track.segments.map((s) => s.text).join('');
  assert.ok(all.includes('后面还有新内容'), `新内容不能丢，实际：${all}`);
});

test('SubtitleTrack 可序列化并还原（用于缓存）', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 0, end: 5, text: '缓存测试内容。' });
  const restored = SubtitleTrack.fromJSON(JSON.parse(JSON.stringify(track.toJSON())));
  assert.deepEqual(restored.segments, track.segments);
});

test('lastSegmentBefore 返回已结束的最近一条', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 0, end: 4, text: '第一句话。' });
  track.addChunk({ start: 8, end: 12, text: '第二句话。' });
  const first = track.segments[0];
  assert.deepEqual(track.lastSegmentBefore(5), first);
  assert.equal(track.lastSegmentBefore(-1), null);
});

test('导出 SRT 格式正确', () => {
  const segments = [
    { start: 0, end: 2.5, text: '第一条字幕' },
    { start: 65.25, end: 70, text: '第二条字幕' }
  ];
  const srt = toSRT(segments);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:02,500\n第一条字幕/);
  assert.match(srt, /2\n00:01:05,250 --> 00:01:10,000\n第二条字幕/);
});

test('导出 VTT 带 WEBVTT 头且用点号分隔毫秒', () => {
  const vtt = toVTT([{ start: 1.5, end: 3, text: '内容' }]);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.match(vtt, /00:00:01\.500 --> 00:00:03\.000/);
});

test('导出纯文本：中英混排只在两侧都是西文时才补空格', () => {
  const segments = [
    { start: 0, end: 1, text: '中文句子' },
    { start: 1, end: 2, text: '继续中文' },
    { start: 2, end: 3, text: 'english words' },
    { start: 3, end: 4, text: 'more english' }
  ];
  // 中文直接连接（中文排版不加空格），中文与英文之间也不加，
  // 只有英文单词之间保留原有空格，避免出现 "中文english" 之外的怪异拼接
  assert.equal(toPlainText(segments), '中文句子继续中文english words more english');
});

test('时间戳为负数或出现小数毫秒时也能生成合法时间', () => {
  const srt = toSRT([{ start: -3, end: 0.0004, text: '边界' }]);
  assert.match(srt, /00:00:00,000 --> 00:00:00,000/);
});

/* ===========================================================================
 * 块乱序到达
 *
 * 背景是用户报的“中间那段字幕直接不显示”。块是异步识别的，单块耗时实测
 * 从 1.3 秒到 73.7 秒都出现过，所以**后发的块完全可能先回来**。
 * segments 一旦不是按时间有序，`segmentAt()` 的二分查找就会查到错误的区间、
 * `lastSegmentBefore()` 会提前 break —— 该显示的字幕被整条跳过。
 * 下面几条把这个不变式钉住。
 * ======================================================================== */

test('后发的块先回来时，字幕轨仍然按时间有序', () => {
  const track = new SubtitleTrack();
  // 时间上靠后的这一块先返回
  track.addChunk({ start: 578.5, end: 590.5, text: '后面才讲到的内容。' });
  // 时间上靠前的那一块后返回
  track.addChunk({ start: 552.7, end: 565.6, text: '前面讲过的内容。' });

  const starts = track.segments.map((s) => s.start);
  assert.deepEqual(
    starts,
    [...starts].sort((a, b) => a - b),
    `segments 必须按 start 递增，否则二分查找会失效。实际 ${starts.join(', ')}`
  );
});

test('乱序到达时，先到的那一块依然能被 segmentAt 查到', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 100, end: 112, text: '后面的内容。' });
  track.addChunk({ start: 60, end: 72, text: '前面的内容。' });

  const early = track.segmentAt(66);
  assert.ok(early, '早到的那块（60→72）在 66 秒处必须查得到');
  assert.equal(early.text, normalizeText('前面的内容。'));
  assert.ok(track.segmentAt(106), '后到的那块在 106 秒处也必须查得到');
});

test('迟到的旧块不会被“数组最后一条”推到未来', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 200, end: 212, text: '很靠后的内容。' });
  track.addChunk({ start: 100, end: 112, text: '迟到的早期内容。' });

  const late = track.segments.find((s) => s.text.includes('迟到'));
  assert.ok(late, '迟到的块必须被保留');
  assert.ok(late.start < 130, `迟到块的起点不该被挪到未来，实际 ${late.start}`);
  assert.ok(late.end <= 130, `迟到块的终点不该被挪到未来，实际 ${late.end}`);
});

test('乱序到达时 lastSegmentBefore 返回时间上真正最近的一条', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 100, end: 110, text: '后到的内容。' });
  track.addChunk({ start: 60, end: 70, text: '先说的内容。' });

  const at = track.lastSegmentBefore(80);
  assert.ok(at, '80 秒处应该能查到已经说完的“先说的内容”');
  assert.equal(at.text, normalizeText('先说的内容。'));
});

test('乱序到达时导出的 SRT 仍按时间升序', () => {
  const track = new SubtitleTrack();
  track.addChunk({ start: 100, end: 112, text: '第二段。' });
  track.addChunk({ start: 60, end: 72, text: '第一段。' });

  const srt = toSRT(track.segments);
  assert.ok(srt.indexOf('第一段') < srt.indexOf('第二段'), 'SRT 里早的内容必须排在前面');
});

/* ---------------------------------------------------------------------------
 * 流式识别：时间戳来自服务端，不做任何“按字数摊时间”的估算
 * ------------------------------------------------------------------------- */

test('流式返回的段按服务端时间戳原样落盘，不再按字数摊时间', () => {
  const track = new SubtitleTrack();
  const { added } = track.addTimedSegments([
    { start: 12.5, end: 14.25, text: '服务端给的起止时间。' }
  ]);

  assert.equal(added.length, 1);
  assert.equal(added[0].start, 12.5, '开始时间必须原样保留');
  assert.equal(added[0].end, 14.25, '结束时间必须原样保留');
  assert.equal(added[0].text, normalizeText('服务端给的起止时间。'));
});

test('流式的段乱序到达时，字幕轨仍保持按时间有序', () => {
  const track = new SubtitleTrack();
  track.addTimedSegments([{ start: 100, end: 102, text: '后到的内容。' }]);
  track.addTimedSegments([{ start: 60, end: 62, text: '先到的内容。' }]);

  const starts = track.segments.map((s) => s.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), '内部数组必须始终按 start 递增');
  assert.ok(track.segmentAt(61), '60s 处应该查得到');
  assert.ok(track.segmentAt(101), '100s 处应该查得到');
});

test('流式的段与已有字幕重叠时，收住前一条的结束时间而不是丢掉新文字', () => {
  const track = new SubtitleTrack();
  track.addTimedSegments([{ start: 10, end: 14, text: '前一句。' }]);
  track.addTimedSegments([{ start: 13, end: 16, text: '后一句。' }]);

  assert.equal(track.segments.length, 2, '两条都要保留，重叠不能把新文字吃掉');
  const [first, second] = track.segments;
  assert.ok(first.end <= second.start, `前一条必须在下一条开始前收住（${first.end} vs ${second.start}）`);
  assert.equal(second.text, normalizeText('后一句。'));
});

test('流式返回的坏数据被跳过：空文本、时间为负、起止颠倒', () => {
  const track = new SubtitleTrack();
  const { added } = track.addTimedSegments([
    { start: 1, end: 2, text: '   ' },
    { start: 3, end: 3, text: '零长度。' },
    { start: 5, end: 4, text: '起止颠倒。' },
    { start: Number.NaN, end: 9, text: '时间不是数字。' },
    { start: 10, end: 12, text: '这一条是好的。' }
  ]);

  assert.equal(added.length, 1, '只有合法的那一条该被收下');
  assert.equal(added[0].text, normalizeText('这一条是好的。'));
});
