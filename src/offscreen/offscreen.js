/**
 * 离屏文档：为“抓取标签页声音”提供扩展侧的上下文。
 *
 * 它本身不采集任何音频，存在的理由是 Chrome 的硬性要求：
 * tabCapture.getMediaStreamId() 需要扩展有一个可用的扩展页面上下文。
 * 真正生成音频流并分块录音的是内容脚本。
 *
 * 历史说明：早期版本在这里做过“把抓到的声音接回扬声器”，但那需要第二个
 * streamId，而 Chrome 拒绝同一标签页存在两个抓取（报
 * “Cannot capture a tab with an active stream”）。去掉之后抓取才成功，
 * 而且页面自身的播放本来也不受影响。
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  if (message.type === 'offscreen:probe') {
    // background 用它确认离屏文档已就绪
    sendResponse({ ok: true, ready: true });
    return false;
  }

  return false;
});
