# lark-cli 飞书知识库导入能力边界

调查日期：2026-08-11  
调查对象：本机安装的官方 `@larksuite/cli` `v1.0.84`

## 结论

MVP 可以继续坚持“复用 `lark-cli` 用户登录态”，而且不需要在 Bridge 中获取、保存或刷新飞书 access token。最短且风险最低的导入主链路是：

1. 用 `wiki +space-list`、`wiki +node-list` 枚举用户可访问的知识库与目录；
2. 将 Readability 提取出的 HTML 在插件侧转换为 Markdown；
3. 用 `docs +create --as user --parent-token <wiki_node_token> --doc-format markdown` 一次创建并写入文档；
4. 从成功 JSON 中读取 `document.document_id` 与 `document.url`，把 URL 返回插件；
5. 对飞书服务端无法下载的图片，再用 `docs +media-insert` 的本地文件路径链路补插。

不建议让 MVP 直接依赖 `POST /open-apis/docx/v1/documents/blocks/convert`。当前官方 CLI 的 typed schema 没有 `docx` 服务，而该 convert 文档旧地址目前返回“文档不存在”；`docs +create/+update` 已经提供了更稳定的 Markdown/DocxXML 编排层。

## 能力矩阵

| 能力 | v1.0.84 覆盖情况 | MVP 决策 |
|---|---|---|
| 用户 OAuth | **命令层覆盖；当前自动化环境未完成实测**。`auth login` 支持 Device Flow、按 domain/scope 增量授权；业务命令可显式 `--as user`。当前 sandbox 执行 `auth status --verify` 时无法读取 macOS Keychain，返回 `keychain not initialized`。 | Bridge 只调用 CLI 并显式加 `--as user`，绝不读取 token。安装验收必须在最终 LaunchAgent 运行上下文中验证 Keychain 可读。 |
| 列出知识空间 | **覆盖**。`wiki +space-list --as user --page-all`，每页最多 50；个人文档库需用 `my_library` 单独解析。 | 可用于设置页的知识库选择器。 |
| 列出目录/节点 | **覆盖**。`wiki +node-list --space-id ... --parent-node-token ... --page-all`。 | 逐层懒加载目录；不要递归拉取整个大知识库。 |
| 在 Wiki 创建 docx | **覆盖**。`wiki +node-create` 可指定 space 或父 Wiki 节点；更短的 `docs +create --parent-token <wiki_node_token>` 可直接在该父节点下创建带内容文档。 | 目录目标优先走一次 `docs +create`。如允许“知识空间根目录”作为目标，再用 `wiki +node-create` 创建空 docx，随后 `docs +update` 写正文。 |
| HTML/Markdown 转块 | **Markdown 覆盖，任意 HTML 不覆盖**。`docs +create/+update` 接受 Markdown 或官方 DocxXML；Markdown 支持标题、列表、代码、表格与 HTTP(S) 图片。 | 插件负责 `Readability HTML -> Markdown`，Bridge 不接受任意网页 HTML。不要依赖旧 convert API。 |
| 嵌套块写入 | **高层覆盖，typed 原子命令不覆盖**。`docs +create/+update` 会把 Markdown/DocxXML 写成块树；官方 OpenAPI 仍提供 children 与 descendant 接口，但 `lark-cli schema` 不注册 `docx` 服务。 | MVP 使用高层命令。只有发现高层导入无法满足已验收的结构时，才回退 `lark-cli api --as user` 调官方 descendant 接口。 |
| 图片上传与替换 | **高层覆盖**。网络图片可直接写 Markdown URL，由 CLI 自动下载；`docs +media-insert` 会编排“创建空图片块 -> 上传素材 -> 设置 token”，支持本地文件、定位插入与自动回滚；`docs +media-upload` 暴露较低层上传。 | 公网图片先走 Markdown；受登录、Referer 或防盗链保护的图片由浏览器下载为 blob，Bridge 落临时文件后调用 `+media-insert`。不要自行实现 token 替换，除非高层命令验证失败。 |
| 返回 Wiki URL | **覆盖**。`docs +create` 返回 `document.document_id`、`revision_id`、`url`；其官方 CLI 参考明确说明知识库场景的 `url` 可能是 `/wiki/...`。`wiki +node-create` 从 v1.0.34 起也返回真实 node URL。 | 把 CLI 返回 URL 原样交给插件，不要用域名和 token 手工拼 URL。 |

## 推荐命令契约

所有命令都应使用 argv 数组启动，不经 shell 拼接；正文通过 stdin 传入，结果只接受 JSON。下面的命令仅展示契约，token 为占位符。

### 读取目标

```bash
lark-cli wiki +space-list --as user --page-all --format json
lark-cli wiki +node-list --as user --space-id SPACE_ID \
  --parent-node-token PARENT_WIKI_TOKEN --page-all --format json
```

### 创建带正文的 Wiki 文档

```bash
lark-cli docs +create --as user \
  --parent-token PARENT_WIKI_TOKEN \
  --title "网页标题" \
  --doc-format markdown \
  --content - \
  --format json
```

Bridge 的成功判断必须是进程退出码为 0 且顶层 `ok == true`。不能按旧 OpenAPI 响应的 `code == 0` 判断；官方 CLI 的成功 envelope 没有顶层 `code`。

### 补插本地图片

```bash
lark-cli docs +media-insert --as user \
  --doc DOCUMENT_ID \
  --file ./relative/path/image.png \
  --selection-with-ellipsis "UNIQUE_IMAGE_ANCHOR" \
  --before \
  --format json
```

图片补插需要在正文中保留唯一锚点，全部图片插入成功后再移除锚点。`+media-insert` 应传 `document_id`，不要传 `/wiki/...` URL。CLI 的文件参数要求 cwd 下的相对路径，因此 Bridge 应为每次导出创建隔离的任务目录，并从该目录运行 CLI。

## 最小安全降级策略

1. **先用 shortcut，不先用 raw API。** 主链路仅依赖 `wiki +*`、`docs +create`、`docs +media-insert`。它们会校验参数、统一 JSON envelope，并负责多步编排与部分回滚。
2. **HTML 转换缺口放在本地解决。** 用可测试的 HTML-to-Markdown 转换器产生 Markdown；不要把已经失去稳定文档入口的 convert API 变成关键依赖。
3. **确有原子能力缺口时，用 `lark-cli api --as user`。** CLI 的 raw escape hatch 能调用任意官方 OpenAPI，并继续使用同一 user access token。Bridge 仍然看不到 token。请求体通过 stdin 或 cwd 内相对文件传入，日志中不得记录 Authorization header、CLI 配置或完整错误上下文中的敏感字段。
4. **原始块链路仅作第二级 fallback。** 官方链路是 Markdown/HTML 转换结果 -> `descendant` 嵌套插入 -> 为图片块上传素材 -> `replace_image` 更新块。该链路字段多、受 block 父子关系和文档 revision 约束，MVP 只有在真实页面夹具证明 shortcut 不达标后才采用。
5. **不要默认执行 `config keychain-downgrade`。** CLI 提示该命令可让 sandbox/自动化进程改读本地文件，但同时明确指出同一 macOS 用户下的任意进程都可能读取该文件。这是安全退化，必须由用户单独决定，不能写进静默安装脚本。

## 仍需真实环境验证的风险

### 1. LaunchAgent 与 macOS Keychain

本次调查能证明命令和协议存在，但当前受限进程无法读取 CLI Keychain，因此不能证明后台 Bridge 能复用现有登录态。安装验收应先注册一个最小 LaunchAgent，在其真实上下文执行：

```bash
lark-cli auth status --json --verify
lark-cli wiki +space-list --as user --page-size 1 --format json
```

若交互式 Terminal 可成功而 LaunchAgent 失败，应先修复 Keychain ACL/运行上下文；只有用户明确接受安全权衡后才考虑 `keychain-downgrade`。

### 2. 图片来源可访问性

CLI 可自动下载公开 HTTP(S) 图片，但飞书/CLI 进程无法继承网页 Cookie、Referer 和浏览器会话。验收夹具至少应包含：公开图片、相对 URL、`srcset`/懒加载图片，以及一个需要网页登录态或防盗链的图片。后者必须走“浏览器取 blob -> Bridge 临时文件 -> `+media-insert`”。

### 3. 创建的幂等与模糊失败

MVP 已决定每次点击创建新文档，但 Bridge 在超时后盲目重试 `docs +create` 仍可能产生非用户意图的重复副本。对创建命令发生“请求可能已成功但响应丢失”的错误时，应返回可重试提示并先按本次 request id/标题标记查询，而不是立即自动重建。

### 4. 频控与串行写入

官方文档对单应用创建/编辑一般限制为每秒约 3 次；素材上传另有 5 QPS 与日配额。Bridge 应串行处理单篇文档写入，对 429/99991400 使用带抖动的指数退避，不并发补插同一文档的多张图片。

## 建议验收用例

1. 在真实团队知识库的指定子目录导出一篇公开文章；返回 URL 为 Wiki 页面且能打开。
2. 文档包含标题、来源 URL、保存时间、正文标题层级、列表、引用、代码块、简单表格。
3. 至少一张公开图片自动导入；至少一张浏览器可见但服务端不可直取的图片经本地补插后位于正确段落附近。
4. 退出/撤销用户授权后，Bridge 返回结构化“需要重新登录”，不回退 bot 身份。
5. 在 LaunchAgent 上重启 Bridge 后仍能读取用户登录态并列出目标目录。

## 证据与复核方式

### 本机官方 CLI

- `lark-cli --version` -> `1.0.84`
- `lark-cli wiki --help`
- `lark-cli wiki +space-list/+node-list/+node-create --help`
- `lark-cli docs +create/+update/+media-upload/+media-insert --help`
- `lark-cli auth login/status/check --help`
- `lark-cli api --help`
- `lark-cli schema wiki.spaces.list/wiki.nodes.list/wiki.nodes.create`
- `lark-cli skills read lark-wiki`
- `lark-cli skills read lark-doc/references/lark-doc-create.md`
- `lark-cli skills read lark-doc/references/lark-doc-md.md`
- `lark-cli skills read lark-doc/references/lark-doc-media-insert.md`
- 安装包元数据：[larksuite/cli](https://github.com/larksuite/cli)（本机 package 指向该官方仓库）

### 飞书开放平台官方文档

- [创建知识空间节点](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/wiki-v2/space-node/create)
- [获取知识空间节点信息](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node?lang=zh-CN)
- [新版文档概述与块 API 列表](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/docx-overview)
- [创建块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create)
- [文档常见问题：嵌套块、转换内容与图片替换链路](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/faq)
- [上传素材](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all?lang=zh-CN)
- [素材概述](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/introduction?lang=zh-CN)
- [API 权限列表](https://open.feishu.cn/document/server-docs/application-scope/scope-list?lang=zh-CN)

## 调查限制

- `agent-reach` 的 Exa 后端本次因 DNS 失败不可用，后续网页检索改走官方飞书站点；没有采用第三方资料。
- 当前 sandbox 无法访问 macOS Keychain，因此没有执行真实写入，也没有暴露任何凭据。
- 官方旧 convert 文档地址目前返回“文档不存在”；FAQ 仍描述转换后的嵌套块与图片替换链路。这个不一致正是 MVP 不应直接绑定该接口的原因。
