# Chrome 应用商店上架材料 —— 先存飞书

## 基本信息

- **名称**：先存飞书
- **简短描述**（32 字，限 132）：先进团队，先存飞书——一键将当前网页剪藏为飞书知识库文档
- **分类**：工作效率
- **语言**：简体中文
- **支持网站**：https://github.com/bailynlove/feishu-clip
- **版本**：0.1.2

## 详细描述

**先进团队，先存飞书。**

网页看到好内容，点一下就是一篇排版干净、图片齐全的飞书文档——不用再复制粘贴、不用担心图片丢失。

**核心功能**

- **一键剪藏**：点击扩展图标，正文自动提取为 Markdown，图片本地下载校验后嵌入飞书文档，失败的图片保留原图链接并提示，绝不静默丢图。
- **存进知识库**：保存目标可选知识库里的任意目录节点，或整个知识空间根层；弹窗内可临时更换本次目标，不影响默认设置。
- **预设系统**：多套剪藏预设随心切换——保存目标、标题模板、正文模板、默认动作、URL 触发规则全部可预设。支持 `{{title}}`、`{{content}}`、`{{date}}` 等变量自定义标题与正文；按网址规则自动命中预设，打开即配好。
- **三种保存动作**：保存到飞书 / 复制 Markdown 到剪贴板 / 保存为本地 .md 文件，下拉即选。
- **所见即所得**：弹窗内直接编辑标题、预览 Markdown 正文，确认后再保存。

**安全可靠**

- 本地 Bridge 架构：扩展只与本机 127.0.0.1 服务通信，通过一次性配对码绑定，绑定扩展 Origin 与专用凭据，他人扩展无法冒用。
- 图片下载经 SSRF 防护（仅公网地址、尺寸与总量上限、魔数校验）。
- 不上传任何数据到第三方服务器；你的飞书凭据由本机 lark-cli 管理，不经过扩展。

**使用前提**：需要本机安装 lark-cli 并完成飞书用户登录（安装脚本会引导配对）。

## 权限说明（审核用，英文）

- **activeTab**："Grants temporary access to the active tab only after the user clicks the extension icon, so the extension can read the page's title, URL and content for the clip. No access to other tabs and no background monitoring."
- **scripting**："The extension uses chrome.scripting.executeScript to inject its content-extraction script into the active tab when the user clicks save. This is how the article text and images are read. Scripts are never injected automatically or in the background."
- **storage**："Stores the pairing credential for the local Bridge service and the user's clip presets/settings locally on the user's machine. Data never leaves the device."
- **downloads**："The optional 'Save as file' action saves the clipped Markdown as a local .md file to the user's chosen download location."
- **host_permissions: http://127.0.0.1:38479/**："The extension talks only to a local Bridge service on 127.0.0.1 that the user installs and pairs via a one-time code. The Bridge creates the Feishu document using the user's own lark-cli credentials. The extension itself contacts no remote server."

## Privacy policy URL

`https://github.com/bailynlove/feishu-clip#privacy-policy`（README 已含中英隐私政策，推送后生效）

## 单一用途声明

本扩展的单一用途是：将当前网页剪藏为飞书知识库文档（或其 Markdown 副本）。所有权限均服务于该用途。

## 数据使用与隐私

- 不收集、不传输、不出售任何用户数据。
- 网页内容与图片仅发送至用户自己的飞书账号（经本机 lark-cli），或保存到用户本地。
- 无远程代码执行，无第三方分析 SDK。

## 截图清单（1280×800）

1. `screenshot-1-popup.png` — 弹窗主界面：标题编辑、预设 chips（trigger 自动命中）、本次设置展开、保存按钮
2. `screenshot-2-preview.png` — 弹窗预览展开：Markdown 正文层级、列表、图片占位
3. `screenshot-3-options.png` — 设置页：预设标签页管理、{{}} 模板变量、Triggers 规则

## 宣传图

1. `promo-small-440x280.png` — 小横幅（440×280）：logo + 产品名 + slogan + 功能点，蓝绿果冻渐变底
2. `promo-marquee-1400x560.png` — 大横幅（1400×560）：左侧品牌区，右侧弹窗 UI 特写（裁自 screenshot-1）

## 商店图标

`store-icon-128.png` — 商店列表用 128×128 图标，24-bit 无 alpha 白底（商店规范要求）；由 `prototypes/logo/variant-d.svg` 以 `--default-background-color=ffffffff` 渲染。与扩展用 `src/extension/icons/`（圆角外透明）区分，互不影响。

素材见 `docs/store/` 目录；截图重生成方式见 `prototypes/store-shots/build.mjs`，宣传图源文件为 `prototypes/store-shots/promo.html`（`?size=small|marquee` 两版）。

## 打包

`feishu-clip-0.1.2.zip`（仓库根）为改名后重新打包的扩展文件（`src/extension/` 内容），上传到开发者后台即可。

## 仍需人工操作

- 注册 Chrome 开发者账号（一次性 $5）
- 后台填写：分类、权限说明（上文「权限说明」逐条粘贴）、单一用途声明、数据使用声明
- 上传宣传图：小横幅 440×280（`promo-small-440x280.png`，非必填但建议）、大横幅 1400×560（`promo-marquee-1400x560.png`，仅在被推荐位选中时使用）
