# 项目交接说明（新窗口从这里开始）

> 这份文档是给**接手的新会话**看的。读完它你应该能直接继续干活，不需要翻历史记录。
> 最后更新：项目功能已完整跑通并通过实测验证。

---

## 一句话现状

**功能已全部跑通**：能给网页教学视频生成实时中文字幕，采集 → 传输 → 识别 → 显示整条链路
已用真实课程页面验证。当前瓶颈（识别延迟）已通过改用**本地 Whisper** 解决，
实测识别速度是实时的 3.5 倍。

**第二轮（用户实测反馈后）修了 5 处会导致“字幕缺内容 / 不连贯”的缺陷**；
**第三轮修了采集侧的“覆盖不变式”与“分块节拍被推迟”问题**；
**第四轮修了“有新内容却不显示 / 一句滞留很久 / 前后不连贯”**；
**第五轮新增了流式识别模式**（服务端滚动解码 + 一致前缀定稿）；
**第六轮修掉了“降级后采集窗口没回滚”这个错字漏字的真因，
并让识别模型可选**（硅基流动 Qwen3-ASR-1.7B / 星辰、阿里云百炼 qwen3-asr-flash）。
测试从 142 项增加到 **209 项**，全绿。

**下一步该做什么**：见 [docs/roadmap.md](roadmap.md)。最优先的仍是**在真实课程上做一次完整回归**。

> **⚠ 关于延迟的重要结论（第五轮实测得出，别再按旧说法承诺）**：
> 流式识别**不能**把延迟降到 1~2 秒。真实语音实测的**首次定稿地板约为 5 秒**，
> 因为 Whisper 对短音频输出本就不稳，必须攒够上下文。流式真正买到的
> 是**连续性**与**时间戳准确性**，不是更低的延迟。要归零延迟只能走**预转写**（roadmap P0.5）。
> 详见 `docs/gotchas.md` #32、#33。

---

## 快速验证（确认环境没坏）

按顺序跑，全部通过说明项目处于健康状态：

```powershell
cd "F:\Agent xiangmu\DSH project\zimu"

# 1. 构建 + 单元测试（应输出 209 项全通过）
node tools/build.mjs
node --test "test/**/*.test.mjs"

# 2. 本地识别服务自检（不下载模型，几秒出结果）
python tools\local-asr\server.py --selftest

# 3. 若服务已在运行，验证识别链路（含静音测试）
python tools\local-asr\probe.py

# 4. 用真实中文语音验证识别质量与耗时
python tools\local-asr\verify-speech.py
```

---

## 环境事实（这台机器上确认过的）

| 项 | 值 |
| --- | --- |
| 项目路径 | 任意目录（无绝对路径依赖） |
| Node | v20+（开发时用 v24） |
| Python | 3.10+（开发时用 3.13.2） |
| CPU / 内存 | AMD Ryzen 7 7735H（8 核 16 线程）/ 16 GB |
| 浏览器 | Edge 122 / Chrome 116+ |
| 目标平台 | 内部学习平台 `https://example.internal/...`（自签名证书，播放器用 MSE + blob URL） |
| 模型缓存 | `~/.cache/zimu-whisper`（small 约 464 MB） |
| 已装 Python 依赖 | `faster-whisper 1.2.1`、`ctranslate2 4.8.2`、`av 19.0.1`、`onnxruntime 1.31.0` |

**网络约束（重要）**：
- `huggingface.co` **不可达**（超时），`hf-mirror.com` 可达 → 模型下载已默认走镜像
- 清华 PyPI 镜像会返回 403 → 用官方 PyPI 或阿里云镜像
- 硅基流动（`api.siliconflow.cn`）可达

---

## 当前有服务在运行

我测试时启动的本地识别服务**还在跑**（端口 8788）：

```json
{"ok": true, "backend": "faster-whisper", "model": "small", "requests": 4, "avgMs": 1392.3}
```

**注意**：这是后台残留进程，新窗口重启（或用户关窗口）后会消失。
正式使用时需要用户自己开一个终端跑 `python tools\local-asr\server.py` 并保持窗口开着。

---

## 架构速览

```
网页里的 <video>
   │  ① captureStream() 取音频（剥掉视频轨，见 gotchas #1）
   ▼
每 N 秒切一块（默认 6 秒，相邻块重叠 1 秒）
   │  ② 用 video.currentTime 记录每块在视频时间轴上的真实起止时间
   ▼
③ 转成 16kHz 单声道 WAV（见 gotchas #6）
   │  ④ base64 编码后经 chrome.runtime.sendMessage 送给 background（见 gotchas #4）
   ▼
⑤ background 复原字节 → POST /audio/transcriptions
   │      ├─ 本地 Whisper  http://127.0.0.1:8788/v1
   │      ├─ 本地中继    http://127.0.0.1:8787/v1 → 云端
   │      └─ 云端直连    硅基流动 / OpenAI / 任意兼容服务
   ▼
⑥ 按时间轴对齐 + 跨块去重 + 按标点断句 + 补足最短显示时长
   ▼
⑦ 字幕叠加层（Shadow DOM，像素定位，见 gotchas #7）
```

### 目录结构

```
src/                        源码（改这里，不要改 dist）
  manifest.json             MV3 清单（权限：storage/tabCapture/offscreen/scripting）
  common/
    settings.js             默认设置、供应商预设、权限匹配规则
    transcript.js           字幕文本处理（纯函数，测试最全）
    asr-client.js           识别服务调用 + 供应商能力预检
    binary.js               base64 编解码、跨进程二进制形态处理
  content/                  内容脚本（普通脚本，靠 window.__ZIMU__ 共享）
    transcript.js           由 build 从 common/transcript.js 生成
    binary.js               同上，从 common/binary.js 生成
    capture.js              音频采集与分块
    wav-encoder.js          录音 → 16kHz 单声道 WAV
    audio-source.js         音频来源选择（元素 / 标签页）+ 自动降级
    overlay.js              字幕叠加层 + 悬浮面板 + 诊断
    subtitles.js            主控：探测视频、启停、渲染同步
  background/
    service-worker.js       保管密钥、发起请求、离屏文档管理、消息路由
  offscreen/                离屏文档（tabCapture 需要）
  popup/                    设置面板（也是 options 页）

tools/
  build.mjs                 打包 + 语法检查 + manifest 引用校验
  check-modules.mjs         ES module 语法检查（子进程）
  server/relay.mjs          本地中继（Node，零依赖，转发到云端）
  local-asr/
    server.py               本地 Whisper 识别服务（Python，零第三方 Web 框架）
    probe.py                链路探测（含静音测试）
    verify-speech.py        真实语音验证（用 Windows SAPI 合成）
    relay.config.example.json（在 tools/server/ 下）

test/                       209 项测试，见下表
docs/
  handoff.md                ← 你正在读的
  gotchas.md                踩坑清单（40 条，接手前必读）
  roadmap.md                下一步该做什么
  verify-round3.md          端到端验证手册（照着走，含流式场景）
  troubleshooting.md        面向用户的排错指南
tools/
  local-asr/server.py       本地识别服务（含流式接口 /v1/audio/stream）
  local-asr/verify-speech.py 真实语音测速（脱离页面，判断是不是页面抢 CPU）
  prefetch-probe.js         预转写可行性探测（整段粘进页面 Console）
  sim-timeline.mjs          **渲染节奏推演**（按真实节奏打印屏幕上出现过什么，第七轮新增）
```

### 测试覆盖分布

| 文件 | 项数 | 覆盖什么 |
| --- | --- | --- |
| `transcript.test.mjs` | 39 | 文本清洗、跨块去重、断句、时间轴、最短显示时长、SRT/VTT 导出、乱序有序性、**流式的带时间戳插入** |
| `binary.test.mjs` | 17 | base64 往返、各种二进制形态还原（含跨 realm） |
| `recorder-options.test.mjs` | 19 | 录音参数备选链、暂停语义、空块判定、媒体时间分块、**覆盖不变式（不留采集空档）** |
| `subtitle-continuity.test.mjs` | 29 | 字幕保留语义、追赶补显、**落后上限与跳历史**、**逐字 + 补显通道 11 条（按音频时长放字、打完即消失）** |
| `audio-source.test.mjs` | 13 | 音频来源选择、视频轨剥离、自动降级、抓取释放 |
| `overlay-position.test.mjs` | 16 | 字幕像素定位、**底部下限（无 12% 硬顶）**、**底色浓度与透明**、面板四角位置、**收起方向与状态写回**、诊断分支 |
| `asr-client.test.mjs` | 11 | 错误提示质量、供应商预检、响应解析 |
| `asr-protocol.test.mjs` | 9 | **两条调用协议（transcriptions / chat）、端点拼接、预设完整性、百炼必走 chat** |
| `streaming-fallback.test.mjs` | 7 | **流式该不该开、降级必须回滚采集窗口、setChunking 幂等与坏值、本地地址内联** |
| `auto-attach.test.mjs` | 10 | 自动挂载时机、自愈、上下文失效、传输方式 |
| `wav-encoder.test.mjs` | 10 | WAV 头逐字段、采样往返、溢出夹紧、单次解码+响度 |
| `diagnose.test.mjs` | 10 | 诊断输出结构、落后量与采集空档的行项 |
| `content-scripts.test.mjs` | 8 | 内容脚本加载顺序、命名空间完整性、manifest 校验 |
| `relay.test.mjs` | 6 | 本地中继端到端（起真实进程） |
| `streaming-settings.test.mjs` | 5 | **流式开关与切片参数钳位** |

---

## 第二轮修改（用户实测反馈后）

**用户反馈的现象**（原话）：

> 出现字幕后该条字幕会持续存在一段时间，但是视频中音频语速挺快，等下次字幕更新又会持续一段时间，
> 导致中间的那段字幕直接不显示，还是输出不连贯的问题，视频中的语言没有被字幕完整的表达出来。

**日志里的三条关键证据**：

1. 同一批块的识别耗时：1.3s → 7.9s → 14.9s → **73.7s**（这是排队的特征，不是模型突然变慢）
2. 块的索引顺序与时间顺序不一致：索引 7/8/9/10 分别覆盖 552.7 / 583.0 / 578.5 / 589.5 秒
3. 两段覆盖区间之间有一段**谁也没覆盖**：第 7 块结束于 565.6s，下一块却从 578.5s 才开始

**改了 5 处**（真因详见 gotchas 第 21–25 条）：

| # | 文件 | 改了什么 |
| --- | --- | --- |
| 1 | `common/transcript.js` | `addChunk` 改为**按时间有序插入**，不再 `push`（乱序到达会让二分查找失效、整条字幕被跳过） |
| 2 | `content/subtitles.js` | 新增**追赶队列**：识别落后时把已经播过去的字幕逐条补显，不再只显示该块的最后一句；拖动进度/停止时清空 |
| 3 | `content/wav-encoder.js` + `subtitles.js` | 新增 `decodeChunk()`，**每块只解码一次**（原来 3 次：两次完全重复的响度检测 + 一次转 WAV） |
| 4 | `content/capture.js` | 恢复播放后**立刻**开窗，不再等一个分块周期（那等于每暂停一次就在音频里挖一个 `chunkSeconds` 的洞） |
| 5 | `content/capture.js` | 开窗/关窗改用**媒体时间** `video.currentTime`，倍速播放下每块才是真正的 `chunkSeconds` 秒音频 |

**怎么验证**：`node tools/build.mjs` → `chrome://extensions` 刷新扩展 → 视频页 F5。
Console 里现在应该还能看到：

- `第 N 块：x→y，kKB，音频 X.Xs` —— 音频时长应当稳定接近设置里的「分块秒数」
- 倍速播放时多一行 `当前播放倍速 2x：每块仍然是 6 秒音频，但请求会更密集`
- 落后时会打 `有 N 条字幕已落后于画面，将按顺序补显（当前积压 N 条）`
- `__ZIMU__.inspect()` 里多了一行「待补显字幕：N 条」

**还没验证的**：以上全部只经过单元测试（159 项）与代码推演，**没有在真实浏览器里跑过**
（本机没有可用的自动化手段，见 gotchas #19）。端到端回归仍是 roadmap 的 P0。

**已知但未处理**：后台对 `zimu:transcribe` 没有并发上限，识别服务端用 `MODEL_LOCK` 串行处理。
一旦出现“服务比产出慢”，等待时间就会线性堆积（那串 73.7 秒就是这么来的）。
当前选择**不丢块**（内容完整性优先），只把积压量暴露出来。
若实测确认本地服务长期跟不上，再考虑加并发上限或自动增大分块。

---

## 第三轮修改（真实浏览器实测反馈后）

**用户反馈**：延迟已经可以接受（落后几秒），但**还是会「输不全」**。

**日志里的关键证据**：第 0 块结束于 **896.9s**，第 2 块却从 **908.2s** 才开始，
中间 11.3 秒**连一条“第 N 块”日志都没有** → 当时没有任何窗口在录，
那段音频从未被录下来。另有一条：块长 12.0s / 窗口间隔 11.1s，
说明慢在**分块设置或节拍**，不在识别服务。

**改了 3 处**（真因详见 gotchas 第 26–28 条）：

| # | 文件 | 改了什么 |
| --- | --- | --- |
| 1 | `content/capture.js` | **覆盖不变式**：新增 `closeSessionIfCovered()`，视频在播时**绝不关掉最后一个窗口**。宁可块录长（慢些），也不留空档（漏内容）。这是本轮最重要的一条 |
| 2 | `content/capture.js` | 抗节拍推迟：巡检 250ms→**200ms**、加 **`timeupdate`** 第二条触发路径、每窗口加**到点必关**的独立定时器（按倍速换算墙钟） |
| 3 | `content/capture.js` + `subtitles.js` | **可观测性**：启动打「分块设置」、节拍被推迟/块超长/采集空档都打 `⚠`；`inspect()` 与停止汇总里报「采集空档 N 处」和「文字偏少 N 块」 |

**新增的诊断输出**（定位“输不全”用）：

- `分块设置：每块 6s 音频，重叠 1s` —— 块长该等于它，对不上就是采集问题
- `⚠ 分块节拍被推迟 X.Xs` / `⚠ 第 N 块超长：X.Xs`
- `⚠ 采集空档 a→b`（这段音频真的没录到，不是识别不准）
- `⚠ 第 N 块文字偏少：X 字 / Ys ≈ Z 字/秒`（正常 3~6）
- `__ZIMU__.inspect()` 里的「采集空档：N 处」

**还没验证的**：以上仍只经过单元测试（163 项）与代码推演，**没有在真实浏览器里跑过**。
按 [docs/verify-round3.md](verify-round3.md) 走一遍即可确认。

**设计取舍（重要）**：延迟与完整性在这里是**冲突**的——关窗太早会留空档（漏内容），
关窗太晚会把块录长（变慢）。本项目的默认选择是**内容完整性优先**：用户能忍慢，
不能忍缺内容。所以即使页面主线程被占死导致块被录得很长，也不会主动断开采集。

---

## 第四轮修改（用户实测「字幕不显示 / 滞留 / 不连贯」后）

**用户反馈**：Console 右侧能看到识别返回的文字，但字幕就是不上屏；一句话长时间
滞留，换新句时前后不连贯。**分块秒数设为 12**。

**最有价值的一条证据**：用户回看**已经播过**的片段时，字幕**完全准确**。
这直接证明识别结果与字幕轨都是对的，问题只在「实时追赶」这一段
（详见 gotchas 第 29 条——这是个可以反复用的诊断判别法）。

**改了 4 处**（真因见 gotchas 第 29–31 条）：

| # | 文件 | 改了什么 |
| --- | --- | --- |
| 1 | `content/subtitles.js` | **渲染优先级反转**：`segmentAt(time)` 命中优先于历史补显，命中时清空追赶队列 |
| 2 | `content/subtitles.js` | **落后上限** `maxLagSeconds = max(6, chunkSeconds)`：超过就跳过历史、直接对齐最新（SRT 导出仍完整） |
| 3 | `content/subtitles.js` | **补显提速**：`catchUpDwellFor()` 取自然时长的一半（700~2200ms），积压越多越快——原速补显永远追不平 |
| 4 | `content/subtitles.js` | **拆掉 `holdSeconds` 的双重职责**：保留显示不再限时；跳转点之前的字幕改由 `lastJumpMediaTime` 排除 |

**新增诊断**：

- 开启时若分块 ≥ 10s：`⚠ 分块秒数设为 12s：仅“等一块”就要 11s …建议改到 4~6s`
- 超上限跳历史：`字幕落后约 X.Xs，超过上限 Ys：跳过 N 条补显，直接对齐最新内容…`
- 追平画面：`识别已追平画面，放弃补显 N 条历史字幕…`
- `__ZIMU__.inspect()` 新增「屏幕字幕落后约：X.Xs（上限 Ys）」

**测试**：163 → **167 项全绿**。

**给用户的第一建议**：把「分块秒数」从 12 降到 **4~6**。延迟 ≈ 分块秒数 + 识别耗时，
12 秒分块意味着仅“等一块”就有 11 秒，字幕必然长期落后——这是目前最大的单一杠杆。

---

## 第五轮修改（用户要求「改成流式输出」）

**用户反馈**：分块从 12s 改到 **5s** 后连贯性明显变好，但**仍有几秒延迟**；
并且明确要求「把文字输出模式改成流式输出」。

**用户选了哪一种**：在四个方案里选了 **连续流式识别**（服务端滚动解码）。

### 新增的流式链路

| 层 | 文件 | 做什么 |
| --- | --- | --- |
| 服务端 | `tools/local-asr/server.py` | 新增 `POST /v1/audio/stream`：按 session 维护滚动 PCM 缓冲，**按媒体时间**裁重叠、断档补静音；每攒够 0.8s 新音频重解一次未定稿区间；用**相邻两次解码的最长公共前缀**（LocalAgreement）决定哪些段落可定稿，超过 5s 未定稿则强制定稿；`flush` 时把尾巴全部定稿并销毁会话 |
| 设置 | `settings.js` / `popup.html` / `popup.js` | 新增 `streaming`（默认开）、`streamSliceSeconds`（默认 1.6，钳 1~5）、`streamOverlapSeconds`（默认 0.4，钳 0~2） |
| 采集 | `content/capture.js` | `chunkSeconds` 下限从 4s 放宽到 1s（否则流式的小切片会被强行拉长） |
| 字幕轨 | `common/transcript.js` | 新增 `addTimedSegments()`：直接插入服务端给出的**真实时间戳**，不再按字数估算摊时间 |
| 内容脚本 | `content/subtitles.js` | 流式开启且地址是本机时，按切片参数采集并走 `sendSliceForStream()`；停止时发 `flush` 收尾；拖动/切集换 session；**连续失败或服务端明确不支持时自动退回分块模式** |
| 后台 | `background/service-worker.js` | 新增 `zimu:transcribe-stream`；**只对本机地址生效**（云端按次计费，流式会重复解码未定稿音频，费用会翻几倍）→ 非本机直接 `fallback: true` |

### 顺手修掉的一个真实缺陷

流式下「幻觉」更容易漏出来：非语音上 Whisper 编的内容**高度可复现**，
两次解码一致 → 被当成「稳定内容」**定稿进字幕轨**。
新增 `is_hallucination()` 置信度过滤（详见 gotchas #32）。

### 这轮**没有**兑现的承诺（重要）

我在 roadmap 里写过「流式可把延迟降到 1~2 秒」。**实测证伪**：
真实中文语音的**首次定稿地板约 5 秒**（Whisper 对短音频输出本来就不稳，
2 秒缓冲时会给出错误词）。流式买到的是**连续性 + 时间戳准确性**，
不是更低的延迟。数据与结论见 gotchas #33。**要归零延迟只能走预转写。**

**测试**：167 → **178 项全绿**；服务端自检 22 → **27 项全绿**。

**已做的真实端到端验证**（脱离浏览器，直接打 HTTP 接口）：

1. 真实中文语音（SAPI 合成 10.6s）逐 2s 投喂 → 第 3 片定稿、flush 补尾、
   时间戳单调递增、关键词命中 4/7 ✓
2. 220Hz 正弦音 → **0 条定稿**（幻觉过滤生效）✓
3. 未知路径 → 404（契约未破坏）✓

命令留档（`$env:TEMP\zimu_stream_speech.py` 是一次性脚本，未入库）：

```powershell
# 服务端自检（含幻觉过滤与定稿判定）
python tools\local-asr\server.py --selftest
```

### 怎么确认流式真的生效了

看 Console：

```
[字幕助手] 流式识别已启用：每 1.6s 投喂一片（重叠 0.4s），服务端边解码边定稿。若本机服务不支持会自动退回分块模式。
[字幕助手] 第 N 片定稿 M 条：……（解码 ?ms，视频 ?.?s）｜未定稿：……
[字幕助手] 流式统计：投喂 N 片，定稿 M 条，失败 0 片，服务端平均解码 ?ms
[字幕助手] 流式延迟归因：等一片约 1.6s + 服务识别平均 ?s ≈ 共 ?s。…
```

见到「流式识别已启用」但不出现「已退回分块模式」，就是生效了。

---

## 第六轮修改（用户反馈「错字漏字多 / 想用云端模型」后）

这一轮的两件事各自独立，但都指向同一个诉求：**让字幕更准、又不想占本机资源**。

### 1. 修掉「错字漏字」的真因：降级后采集窗口没回滚（重要）

用户日志里，`流式识别不可用（…已退回分块模式）` 之后每一块仍是
`音频 1.6s` —— 采集窗口是**开始录音前**定死的（流式用 1.6s），
降级分支只改了标志位、没改窗口，于是整个会话都在用 1.6 秒切片送识别。
一句话被反复切断，模型没有上下文，输出大量串字；请求数还涨到约 3.75 倍，
把云端排队也拖长了。

修法（两层，缺一不可）：

- `Controller.shouldUseStreaming()`：**开工之前**判断「开关 + 服务是否在本机」。
  云端直接按 `chunkSeconds` 起步，不开 1.6s 窗口。
  判定规则复用 `settings.js` 的 `isLocalRelayUrl`——它被 build.mjs
  **内联进内容脚本**（`content/settings.js`），不另写第二份。
- `Controller.fallBackToChunkMode(reason)`：真降级时调
  `capturer.setChunking({chunkSeconds, overlapSeconds})` 把窗口改回去。
- `AudioChunkCapturer.setChunking()`：新增，幂等、坏值不动（0/负数/NaN 一律忽略）。

新增 `test/streaming-fallback.test.mjs`（7 项）守住这条。
详见 `docs/gotchas.md` #34。

### 2. 模型可选：接入硅基流动与阿里云百炼

设置面板新增 4 个预设，并新增 `apiStyle` 配置：

| 预设 | 模型 | 协议 |
| --- | --- | --- |
| 硅基流动 · Qwen3-ASR-1.7B ★首推 | `Qwen/Qwen3-ASR-1.7B` | transcriptions |
| 硅基流动 · 星辰 V3.2-Ultra | `XingChenAGI/XingChenASR-V3.2-Ultra` | transcriptions |
| 阿里云百炼 · qwen3-asr-flash | `qwen3-asr-flash` | **chat** |
| 阿里云百炼 · Fun-ASR（实验性） | `fun-asr` | **chat** |

- `transcriptions` = 现在的老路（multipart 传 `/audio/transcriptions`）；
- `chat` = 音频以 data URI 放进 `/chat/completions` 的 `messages`。
  百炼的 `qwen3-asr-flash` 只有后者。
- `resolveEndpointUrl(baseUrl, apiStyle)` 统一拼接规则，**设置面板直接把
  实际请求地址显示出来**，协议选错时一眼可见。
- `extractText` 增加了对 `choices[0].message.content` 的解析。

新增 `test/asr-protocol.test.mjs`（10 项）。
模型选型的数据与取舍见 `docs/gotchas.md` #35。

**注意**：换模型只提高**准确率**，不降低延迟。延迟仍由「分块秒数 + 排队」决定。

### 这轮的测试数

178 → **194 项**，全绿。

---

## 第七轮修改（用户反馈「逐字输出 / 黑框太丑 / 位置偏高 / 悬浮窗遮挡」后）

用户原话：「延迟和错字漏字大大改善」，然后提了四条纯界面诉求。
**这轮没有动识别链路**，只动渲染与面板。

### 1. 逐字显示（打字机）

新增 `settings.typewriter`（默认开）+ `Controller.typewriterSlice()`。

**这个需求用户提了两轮，第一版做错了**（详见 gotchas #36）：

- 第一版按「**这条字幕到达之后的耗时**」放字，给固定 0.75~1.8 秒。
  解决了"整句蹦出"，但用户的评价是「**整句说完之后，字幕才把上一句输出出来**」——
  逐字成了事后回放。
- 现行版按「**这句话自己的音频时长**」放字，`span = clamp(end-start, 0.8, 8)`：
  6 秒说完的句子就花 6 秒打完。锚点分两种——
  `time <= end`（还没播完就拿到文字，例如**回看已识别片段**）锚在**句首**，
  字真的在被念出来时出现；`time > end`（迟到）锚在**到手那一刻**，
  整体后移但语速对得上话音。
- **放字速度 = 语速**，于是出字速度与识别产出速度同频，字幕流不会越积越多。

连带的三条约束（每条都对应一个真实坑，见 gotchas #36 的表）：
只增不减、**正在打的那句优先于追最新**（否则后半截被扔掉）、
整句上屏要标记 `done` 但 `doneAtMs` 留 0。

### 1c. 补显通道把逐字吞掉了（真机上"没效果"的真因）

**渲染有两条路，我一开始只给一条装了逐字。** 详见 gotchas #39。

- 补显通道的触发条件是 `segment.end <= 当前播放时间`，而"识别慢一两句"是常态 →
  **几乎每一句都走补显通道** → 正常路径根本没轮到 → 逐字等于没做。
- 单测发现不了：测试是直接调 `renderFrame` 喂数据，两条路在测试里没交汇。
- 靠新写的 `tools/sim-timeline.mjs`（按真实节奏推演整条时间轴）才看出来。
- 改法：`backlog === 1` 时补显不接管（交回正常路径）；`≥2` 时接管但**也逐字**，
  只是把放字压缩到 `dwell` 之内（积压越多越快）。另存 `catchUpItem`，
  保证节流只决定"何时换条"、不会把逐字进度一起冻住。

### 1d. 「落后上限」的取值修正（否则会截断正在打的句子）

`computeMaxLagSeconds()` 原本是 `Math.max(6, chunkSeconds)`，语义是"落后不超过
再来一块"。加了逐字后这条前提失效：屏幕常态就比话音晚「识别延迟 + 一个分块」≈ 11 秒，
**旧阈值卡在常态值以下 → 每几秒跳一次历史 → 正在打的那句被拦腰截断**。
现改为 `Math.max(20, chunkSeconds*2 + 8)`，并加 `catchUpQueue.length >= 2` 的条件
（能不能跟上要看积压，不看时间）。详见 gotchas #40。

### 1e. 新增排错工具：`tools/sim-timeline.mjs`

```powershell
node tools/sim-timeline.mjs 5 1     # 识别延迟 5 秒、1x 播放
```

按真实节奏（每 6 秒一块、句子按块一起回来）驱动 `renderFrame`，
把屏幕上出现过的内容按时间打印出来。**上面两个 bug 都是它揪出来的**，
以后改渲染节奏先跑它。

### 1f. 「组成一句话后再消失」

用户要的收尾节奏是「一句打完就消失、再出下一句」。
打完后再停留 `captionLingerMs`（1.5 秒）清空，并记下 `retiredText`
防止下一帧又把它捞回来重打（否则会无限循环地闪）。
稳态下几乎不留空白（出字速度与识别产出同频）；真空白只说明识别卡住了。
拖动进度条时 `resetCatchUp()` 清掉 `reveal` 与 `retiredText`，同一句可重新打一遍。

> ⚠️ 实现时踩过：`show()` 里"整句显示就标记完成"那段若无脑重建 reveal，
> 会把 `typewriterSlice` 刚写上的 `doneAtMs` 清零，「打完再消失」就永不触发。

### 2. 底色浓度可调（0 = 全透明）

新增 `settings.captionOpacity`（默认 72）。`Overlay.applyCaptionStyle()`。
**坑**：底色透明时 `text-shadow` 不能一起去掉，否则浅色课件上白字白底看不见
（gotchas #37）。低于 35% 时反而**加强**描边。

### 3. 字幕位置下移（去掉 12% 硬下限）

真凶不是默认值，是 `applyCaptionPosition()` 里那条
`Math.max(..., videoHeight * 0.12)` —— 它把任何小于 12% 的设置都顶回去，
600px 的播放器上字幕永远钉在离底 72px（gotchas #38）。
现在只保留 `minGap = fontSize + 6`；默认值 8% → 6%。

### 4. 悬浮窗可收起（贴边半隐藏）

新增 `settings.panelCollapsed`。`Overlay.setCollapsed()` +
CSS `.panel.collapsed-right/-left`（`translateX(calc(100% - 18px))`）。

- 用 `transform` 而不是 `display:none`——收起来必须还能点回来
- 收起时方向跟着面板所在的那一侧走，换角要跟着换方向
- **收起态的点击必须在捕获阶段拦**，否则会顺手把卡片也点开
- 面板上加了「收起」按钮；收起/展开状态写回设置

### 这轮的测试数

194 → **209 项**，全绿。
新增用例集中在两处：`overlay-position.test.mjs`（下限 / 底色 / 收起方向 / 默认收起）
与 `subtitle-continuity.test.mjs`（逐字 5 条，含「时间段过完也照样逐字放」）。
后者本来那一组用例改成统一 `typewriter: false`——它们关心的是「该显示哪一条」，
逐字会让每帧只放出前几个字、断言全部失配。

---

## 关键命令

```powershell
# 改完 src/ 后必须重新打包，否则 dist 不会变
node tools/build.mjs

# 全部测试
node --test "test/**/*.test.mjs"

# 启动本地识别服务（用户日常要跑的就是这条）
python tools\local-asr\server.py
python tools\local-asr\server.py --model medium    # 更准，约 2.5GB 内存
python tools\local-asr\server.py --selftest        # 只自检，不加载模型

# 启动本地中继（走云端时用）
node tools/server/relay.mjs
```

---

## 改代码后的生效流程（三步，缺一不可）

```powershell
node tools/build.mjs          # 1. 重新打包到 dist
# 2. chrome://extensions 点扩展的刷新图标
# 3. 刷新视频页面（F5）—— 内容脚本只在页面加载时注入
```

**这是最高频的踩坑点**：只刷新扩展不刷新页面，页面里跑的还是旧脚本，
而它和扩展的联系已经断了，表现是各种莫名其妙的报错（详见 gotchas #14）。

---

## 交接时的已知状态

**已验证可用**：
- 采集 → 传输 → 识别 → 显示的完整链路（在用户真实课程页面上跑通）
- 本地 Whisper：6.6 秒语音识别耗时 1.91 秒（3.5x 实时），关键词命中 4/5
- 静音门控：纯静音返回空文本，不会产生假字幕
- 跨域视频、暂停/恢复、拖动进度、切换视频、全屏等场景

**尚未验证（下一步的首要任务）**：
- **本地 Whisper 接入扩展后的端到端效果**。服务侧单独验证过了，
  但"扩展 → 本地服务 → 字幕显示"这条完整路径还没在真实课程上跑过。
  预期总延迟约 8 秒（6 秒分块 + 2 秒识别）。
- 字幕连贯性在本地 Whisper 下的表现（服务变快后，等下一块的空白期应该显著缩短）

**已知但未处理**：
- 云端识别延迟 8~15 秒是服务端排队造成的，插件层面无法优化。
  **换模型也压不下去**（延迟由分块秒数 + 排队决定）；换模型买到的是准确率。
- ~~硅基流动的 `/audio/transcriptions` 只支持两个模型~~ → **已过时**：
  第六轮实测其模型广场里的 `Qwen/Qwen3-ASR-1.7B`、`XingChenASR-V3.2-Ultra`
  都从 `/audio/transcriptions` 可用且免费。百炼的 `qwen3-asr-flash` 走
  `/chat/completions`（`apiStyle: 'chat'`），插件已支持。
- `av 19.0.1` 与 `faster-whisper 1.2.1` 不兼容，靠服务端的兼容层绕过（gotchas #15）

---

## 沟通风格备忘

用户是**实际使用者**，不是开发者。他在真实课程上做测试并反馈现象。

- 报结论前先说**证据**（日志里的数字、时间戳），不要空口断言
- 每次改完给**明确的操作步骤**（打包 → 刷新扩展 → 刷新页面）
- 我在这轮交互里**判断错过好几处**（详见 gotchas 里标注"我误判过"的条目），
  教训是：**优先加可观测性，让数据说话，而不是靠推测改代码**
- 不要为了显得有进展而夸大把握。做不到的（例如云端延迟）要直说，并给替代方案
