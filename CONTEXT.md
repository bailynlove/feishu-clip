# 飞书网页剪藏

这个上下文描述用户把浏览器中的网页内容一次性保存为飞书知识库文档时涉及的核心概念。

## Language

**网页剪藏（Web Clip）**:
来源页面在某一时刻的可读内容与来源信息快照，保存后成为一篇新的飞书文档。
_Avoid_: 网页导出、书签、同步副本

**来源页面（Source Page）**:
用户当前选择进行剪藏的浏览器页面。
_Avoid_: 原文档、源文件

**保存目标（Save Destination）**:
用户选定、用于接收新剪藏文档的位置：一个现有 Wiki 父节点，或一个知识空间的根层。
_Avoid_: 导出路径、同步目录

**剪藏尝试（Clip Attempt）**:
用户发起的一次保存请求；即使来源页面相同，每次尝试也请求创建一篇新文档。
_Avoid_: 更新、同步、覆盖

**部分成功（Partial Success）**:
剪藏文档及正文已经创建，但一张或多张图片按写入模式降级（预览优先：预览块 → 下载上传 → 原图链接文本；下载优先：下载上传 → 原图链接文本）全部失败；失败位置保留原图链接，并向用户展示警告。PDF 云盘模式下，剪藏文档成功而 PDF 上传任务失败时同样按部分成功呈现（双 job 各自终态，聚合判定在弹窗）。
_Avoid_: 导出失败、静默跳过

**图片候选（Image Candidate）**:
从来源页面识别出的一个图片位置；按优先级落成预览块（公开 URL 直出为 iframe 块）或嵌入图片（下载上传），都不可行时成为原图链接或安全占位文字。
_Avoid_: 图片文件、上传素材

**配对（Pairing）**:
用户授权一个具体浏览器扩展实例连接本机 Bridge 的关系；该关系同时绑定扩展 Origin 与专用访问凭据。
_Avoid_: 登录、飞书授权、仅校验扩展 ID

**配对码（Pairing Code）**:
用户为建立或替换配对而临时生成的一次性授权信息；它不等同于配对成功后的长期访问凭据。
_Avoid_: 访问令牌、飞书验证码

**预设（Preset）**:
一套命名的剪藏参数组合：保存目标、图片写入模式（预览优先/下载优先/不保存）、标题模板、追加正文模板、默认保存动作与 URL 触发规则；预设列表中有一套为默认预设，弹窗内的改动不回写预设。
_Avoid_: 模板方案、配置档案

**模板（Template）**:
预设中支持 `{{}}` 变量语法的标题或追加正文文本；`{{content}}` 是剪藏正文在正文模板中的显式占位符。
_Avoid_: 格式串、占位文本

**AI 摘要（AI Digest）**:
由 Bridge 调用用户配置的 AI API 对剪藏正文生成的摘要文本；生成失败按部分成功降级，不阻断剪藏。呈现方式由预设级 `digest.mode` 决定（#98，缺省读作 subdoc，存量预设读侧迁移）：inline 在建档前生成、经 `{{digest}}` 占位符或默认布局写进正文；subdoc 把摘要挪到建档之后——父文档秒建空文档不等 AI，再建「Digest」子文档（标题取 `digest.docTitle`，模板在扩展侧渲染）落库复用，正文 `{{digest}}` 渲染为子文档链接、父文档顶部插子页面列表块导航，AI 完成后清空子文档重写（失败则留与 job 警告同文案的失败原因）；拿不到 wiki 节点/建子文档失败时退化 inline 并记警告。三型 API 统一走流式（SSE delta），流式过程产出摘要进度（digestProgress：thinking/writing 相位 + 近似 token 计数，思考相位也随 reasoning delta 计数，usage 帧校准），仅存 executor 内存、随 job 视图输出、终态即清（subdoc 在 digest 阶段结束即删，阶段开始先落 waiting 相位占位）；popup 状态条据此显示「思考中 · 约 N tokens（计数为 0 退回「思考中…」）/已生成 N tokens」，旧 bridge 无此字段时退回「已等待 N 秒」。popup「本次设置」里的临时摘要设置（开关即折叠子卡）只覆盖本次提交，不回写预设。设置页的预设级摘要开关同语义：只折叠设置区，关闭写 `enabled:false` 保留 instruction/provider/mode/docTitleTemplate 全部配置，不清空（运行时判定走 `resolveDigest`，编辑器回填走 `readDigestConfig`）。
_Avoid_: 网页导读、内容总结报告

**AI provider 预设（AI Provider Preset）**:
Bridge 端 `ai.json` 里一套命名的 AI API 配置（apiType / baseUrl / model / apiKey + 高级设置 headers / maxOutputTokens / timeoutMs / reasoning 三态（默认不发参数 / 开 / 关，按 apiType 映射为 reasoning.effort、thinking.type、thinking budget），超时默认 180 秒，reasoning 模型思考也耗时）；「默认」由旧单配置迁移而来，可编辑不可删除/改名；模板预设按名选用（`digest.provider`），空 = 默认 provider，悬空引用按摘要失败降级。
_Avoid_: 模型配置、API 档案

**PDF 附件占位符（{{@file}}）**:
摘要指令（预设级/全局）中的占位符；Bridge 检出后把本次剪藏 PDF 以 base64 附件随摘要请求一并发给 AI（三种 API 类型各自附件形状），无 PDF、预设未开「PDF 存云盘」或超 32MB 时降级为纯文本摘要并记 job 警告，不阻断剪藏。
_Avoid_: 模板变量、正文占位符

**悬浮内容（Hover Content）**:
labuladong 代码行内的灯泡注解面板：`span.code-extend-tooltip` 内 `svg.code-extend-icon`（灯泡图标）的兄弟 `span.code-extend-content`，默认隐藏、悬停灯泡才展示。判定硬收窄为此精确触发器关联——其他站点的类似悬停注解、一般隐藏容器一律不算悬浮内容（按普通内容渲染或随容器丢弃）。剪藏时在触发位置留 `悬浮内容{i}` 标记，文字内容作为注释段落 `悬浮内容{i}: 内容` 排到所在块之后（列表项内的提升到整个列表之后），面板内的图片锚定在同一位置、锚点前带 `悬浮内容{i}：` 编号标签段。含 iframe 的隐藏容器不作悬浮打标。
_Avoid_: 隐藏内容、提示框、工具提示、通用悬停面板

**画布组图（Canvas Group）**:
来源页面中同一容器内多层叠放的 2d canvas（如 labuladong 的算法图形），懒渲染（滚入视口才绘制）、无独立 URL。剪藏时按父容器分组、逐组滚入视口触发绘制后按 DOM 序合成一张白底 PNG，以 `bytesBase64` 作为图片候选接入图片管线（走「下载上传」级）；合成前逐层查 alpha，全透明组丢弃。
_Avoid_: 画布截图、图层合并

**建档歧义（Ambiguous Create）**:
创建文档的调用超时（本地或服务端），飞书侧可能已实际建出文档但剪藏尝试拿不到句柄的不确定状态；此时任务进入 reconciling，严禁直接重试建档，必须先由 Bridge 周期 sweep 查证。
_Avoid_: 创建失败、重复建档

**尝试标记（Attempt Marker）**:
剪藏正文元信息引用块里的 `剪藏尝试：<attemptId>` 文本；reconcile 按它在保存目标下反查同名文档来认领建档歧义中实际建出的文档，无标记的同名文档无法确证归属、一律按未建处理。
_Avoid_: 水印、追踪码

**iframe 占位符（iframe Placeholder）**:
正文内 iframe（如折叠起来的算法可视化面板）在剪藏正文中的 `[[FEISHU_CLIP_IFRAME:i]]` 独立段落标记；桥接侧据此转写为飞书 iframe 块（block_type 26），失败时降级为标题链接段落并警告。
_Avoid_: 嵌入帧、外部网页块

**PDF 识别（PDF Detection）**:
点击剪藏时判定来源页面是否携带一份可存云盘的 PDF：标签页本身是 PDF（executeScript 探针读 `document.contentType`，注入失败回退 URL 后缀兜底），或 HTML 论文页存在主 PDF 链接（站点规则 + `citation_pdf_url` meta 启发式，不做全量 PDF 链接扫描）。
_Avoid_: 网页里有 PDF 链接、浏览器下载记录

**PDF 上传任务（PDF Upload Job）**:
与剪藏 job 共享同一剪藏尝试 `attemptId`、以 `kind: 'pdf'` 区分的独立 job；状态机为最小集（queued / awaiting_bytes / running / succeeded / failed / cancelled / expired），上传歧义按失败处理（飞书云盘同名复传合法并存，多传一份无害），不做 reconcile 或查重。字节来源在提交时声明：Bridge 按 URL 下载（url 型），或扩展带凭据抓取后分块喂入（bytes 型）；url 型撞 401/403 转入 awaiting_bytes 等待扩展喂字节。上传成功后把该 PDF 以「@」引用（mention_doc，quote container 内）插到本次剪藏文档开头（#88）；幂等靠剪藏 job 的 `pdfRefInserted` 标记（mark-before-insert：先置位再插入，插入失败清除标记），插入失败只记 pdf job 警告、不改终态；clip 文档尚未建好时跳过并记警告，clip 侧建档后不自动补插（协议空隙，pdf 重试可补）。
_Avoid_: 附件同步、文献库条目

**云盘目录（Drive Folder）**:
PDF 上传任务接收文件的位置：预设 `pdfDrive` 里的 Drive 文件夹 token + 冗余展示名；token 为空即云盘根目录。弹窗内改动仅本次生效、不回写预设。
_Avoid_: 导出路径、同步目录
