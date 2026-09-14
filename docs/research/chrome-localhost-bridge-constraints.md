# Chrome MV3 调用 localhost Bridge：安全与安装约束

研究日期：2026-08-11

## 结论

MVP 可以继续采用 `Chrome MV3 扩展 → HTTP loopback Bridge`，但应把它视为一个本机特权 API，而不是“localhost 天然可信”。推荐基线如下：

- Bridge 只绑定 IPv4 loopback `127.0.0.1`，使用固定高位端口；不绑定 `0.0.0.0`、局域网地址或主机名。
- WXT/Chrome manifest 只声明该精确 endpoint 的 host permission，例如 `http://127.0.0.1:38473/*`。不要使用 `<all_urls>`，也不要省略端口。
- 网页内容在 `activeTab` + `scripting` 授权下提取；只有扩展页或 MV3 background service worker 能访问 Bridge。内容脚本不得直接访问 Bridge，也不得获得配对令牌。
- Bridge 同时校验精确的扩展 `Origin` 和高熵配对令牌。Origin 是浏览器侧约束，令牌才是不可由任意本机 HTTP 客户端绕过的认证；两者缺一不可。
- Bridge 实施严格 CORS：仅回显已配对的 `chrome-extension://<id>`，只允许必要方法和请求头，并拒绝缺失/不匹配 Origin 的浏览器 API 请求。绝不使用 `Access-Control-Allow-Origin: *`。
- 导出采用异步 job 协议：`POST /v1/exports` 快速返回 `202 + jobId`，Bridge 独立完成飞书导出并持久化状态；扩展用短轮询查询。不要让一次 MV3 `fetch()` 等待完整导出。
- macOS 使用当前用户的 LaunchAgent，在登录后启动 Bridge；安装器必须使用绝对可执行路径、显式环境/配置路径、受限文件权限，并提供 `health`、`status`、重启和卸载命令。

这套约束足以支撑个人、macOS、Chrome、单租户 MVP。无需改用 Native Messaging；但必须把当前 Chrome Stable 上的 loopback/LNA 行为加入真实安装验收。

## 1. Chrome 权限与请求发起位置

### 1.1 最小 manifest 权限

推荐 WXT 配置等价于：

```ts
export default defineConfig({
  manifest: {
    permissions: ['activeTab', 'scripting', 'storage'],
    host_permissions: ['http://127.0.0.1:38473/*'],
  },
})
```

理由：

- Chrome 明确规定，扩展 service worker 或扩展页只有在 manifest 声明目标 host permission 后，才能跨源 `fetch()`；内容脚本仍受所在网页的同源/CORS 规则约束。因此 Bridge 请求应集中在 background service worker（或扩展页），不能由内容脚本直接发送。[Chrome: Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- `activeTab` 在用户点击扩展时临时授予当前页面访问权；配合 `scripting` 可按需注入提取逻辑，避免为所有网页申请永久 `<all_urls>` 权限。[Chrome: activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)；[Chrome: scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- Chrome match pattern 支持显式端口；若省略端口则等价于任意端口。`http://localhost/*` 也匹配所有 localhost 端口，所以 MVP 应使用 `http://127.0.0.1:<fixed-port>/*` 缩小权限范围。[Chrome: Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
- WXT 通过 `manifest.host_permissions` 原样生成 MV3 权限，background entrypoint 在 MV3 下生成 service worker。[WXT: Manifest](https://wxt.dev/guide/essentials/config/manifest.html)；[WXT: Entrypoints](https://wxt.dev/guide/essentials/entrypoints)

权限边界还应限制消息协议：内容脚本只提交已定义的“页面快照”结构，不得传入任意 Bridge URL、HTTP 方法或任意远程 URL。Chrome 官方特别提醒，后台代内容脚本跨源请求时必须限制可请求资源，否则恶意网页可能借内容脚本滥用扩展权限。[Chrome: Cross-origin network requests — security considerations](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests#security-considerations)

### 1.2 推荐数据流

```text
用户点击 popup
  → background 使用 activeTab/scripting 在当前页执行提取
  → 注入脚本返回经过 schema 校验的页面快照
  → background 从 chrome.storage.local 读取配对凭据
  → background POST 固定的 Bridge endpoint
  → Bridge 快速返回 jobId
  → popup/background 短轮询 job 状态
```

Readability 和 DOM 清理必须发生在有 DOM 的注入脚本/内容脚本里；MV3 service worker 没有 DOM。Bridge endpoint 常量应由扩展代码构造，而不是接受内容脚本提供的完整 URL。

## 2. CORS、Local Network Access 与 loopback

### 2.1 CORS 的实际含义

有匹配 host permission 的扩展 service worker/扩展页可跨源读取 Bridge 响应；普通网页和内容脚本不能凭该 permission 绕过 CORS。Chromium 对 content-script CORS 收紧的官方说明也明确建议把所需跨源请求转发给 extension background。[Chromium: Changes to Cross-Origin Requests in Extension Content Scripts](https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/)

因此，Bridge 的 CORS 策略应是纵深防御，而不能替代认证：

- `Access-Control-Allow-Origin` 只允许已配对的完整 Origin：`chrome-extension://<extension-id>`。
- 返回 `Vary: Origin`。
- OPTIONS 仅允许实际需要的方法（建议 `GET, POST, DELETE` 中的最小子集）和 `Authorization, Content-Type`。
- 拒绝网页可发送的简单写入形式：不要接受 `application/x-www-form-urlencoded`、`multipart/form-data`、`text/plain` 作为写 API；写 API 只接受 `application/json`。
- 状态改变请求必须携带 `Authorization: Bearer <token>`；不使用 cookie，也不把令牌放到 URL/query（避免日志、历史和 referrer 泄漏）。
- 对缺失 Origin 的 HTTP 请求按接口身份区分：浏览器 API 默认拒绝；若 CLI 需要同一 HTTP API，则为 CLI 设计单独的 Unix-domain/进程内入口，或明确要求同一 Bearer token。不要因为“curl 没有 Origin”而开放匿名写入。

CORS 主要阻止恶意网页读取响应；简单跨源请求仍可能被发送，所以真正阻止 CSRF/本机滥用的是“非简单请求 + 严格预检 + token + 服务端拒绝不匹配 Origin”的组合。

### 2.2 PNA 已被 LNA 取代；扩展 origin 当前被视为 local

Chrome 已暂停旧的 Private Network Access (PNA) 预检方案，并从 Chrome 142 起以 Local Network Access (LNA) 权限提示替代。LNA 首阶段约束的是 public origin 到 local/loopback 的请求。[Chrome: New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)

Chromium 现有浏览器测试明确把 `chrome-extension://` scheme 的 IP address space 归类为 `local`；据此推断，扩展 origin 到 `127.0.0.1` 的请求不是 public → loopback 降级，正常情况下不应触发网站式 LNA 提示。[Chromium source: LocalNetworkAccessBrowserTest.SpecialSchemeChromeExtension](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/local_network_access/local_network_access_browsertest.cc#323)

这是基于当前 Chromium 实现的推断，不应成为跳过测试的理由。Chrome 的 LNA 仍在演进（例如 Chrome 145 已把 local 与 loopback 权限拆分），所以 MVP 验收必须在目标 Chrome Stable 上测试。[Chrome 145 release notes](https://developer.chrome.com/release-notes/145#local-network-access-split-permissions)

1. 从 unpacked extension background 发起 `GET /v1/health` 和 `POST /v1/exports`。
2. 确认无 LNA 权限提示、mixed-content 阻断或 PNA/CORS 错误。
3. 从普通 `https://` 测试页发起相同请求，确认预检或服务端 Origin/token 校验阻断。
4. 从另一临时 unpacked extension 发起请求，确认精确 Origin allowlist 阻断。

不应使用 `0.0.0.0` 作为访问目标。Chrome 129 已明确阻止用 `0.0.0.0` 绕过 localhost 保护，并指出该方式可被 DNS rebinding 滥用。[Chrome 129 release notes](https://developer.chrome.com/release-notes/129#deprecate_0.0.0.0_for_private_network_access)

## 3. Bridge 的认证与网络边界

### 3.1 网络绑定

Bridge 必须显式监听 `127.0.0.1`。不要省略 Node `listen` 的 host 参数，也不要监听 `0.0.0.0`、`::` 或局域网接口。客户端同样使用 IP literal `127.0.0.1`，避免 `localhost` 在 IPv4/IPv6、代理或解析配置下产生歧义。

固定高位端口让 manifest 权限最小且安装诊断简单。启动时若端口被占用，应失败并打印可操作错误；不要自动漂移到随机端口，因为 manifest、配对和诊断都会失配。

### 3.2 配对与令牌

推荐流程：

1. 安装器首次运行时生成至少 256-bit 的 CSPRNG 随机 token，Bridge 配置文件权限设为 `0600`。
2. 安装器在终端一次性显示 token（或提供显式 `feishu-clip pair-code` 命令）；用户把它粘贴到扩展设置页。
3. 设置页由 background 调用认证的 `/v1/pair`；Bridge 记录该请求的精确 `chrome-extension://<id>` Origin。
4. 扩展将 token 保存在 `chrome.storage.local`，并立即调用 `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`，只允许 popup/background 等可信扩展上下文使用；绝不发给内容脚本或注入页面。Chrome 明确说明 `storage.local` 默认暴露给内容脚本，必须主动收紧访问级别。[Chrome: storage API](https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas)
5. Bridge 对令牌做恒定时间比较，并提供 rotate/revoke；重配后旧 token 立即失效。

Origin allowlist 与 token 的职责不同：浏览器保证请求的真实 initiator，能区分不同扩展；但任意本机进程可以伪造 HTTP `Origin`，所以 Origin 不能单独认证。token 能挡住未知本机客户端，但若被泄漏，精确 extension Origin 仍能阻止普通网页直接使用。两者组合才符合此 MVP 的威胁模型。

建议不依赖固定扩展 ID完成首次配对：首次认证 `/v1/pair` 记录实际 Origin，之后严格固定。只要 unpacked extension 始终从相同绝对目录加载，ID 通常保持稳定；若需要安装前即确定 Origin 或跨路径重装无感迁移，再加入 manifest `key`。Chrome 官方说明 `key` 可在开发期维持稳定 ID，也把“服务端只接受该 Chrome Extension origin”列为典型用途。[Chrome: Manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)

### 3.3 API 硬化

MVP 至少应包含：

- 请求体大小上限、图片数量/单图大小/总下载量上限、导出超时和并发上限。
- JSON schema 校验；拒绝额外字段或未知 action。
- 仅允许固定路由，禁止任意 shell 参数、任意文件路径和任意 URL 代理。
- Bridge 调 `lark-cli` 时使用参数数组而非 shell 拼接；不把网页标题、URL 或正文插入命令字符串。
- 日志不记录 token、Authorization、正文、图片二进制或完整飞书凭据；错误返回使用稳定错误码，不回传堆栈和本机路径。
- 目标 URL 下载若由 Bridge 执行，另行实施 SSRF 策略：只接受提取结果中的 `http/https` 图片 URL，拒绝 loopback、私网、link-local、`file:` 和重定向后的受限地址。更安全的替代是扩展侧读取页面已加载资源并上传字节，但这会增加权限与消息体成本。

最后一项（图片抓取位置与 SSRF 策略）是独立产品/架构决定，不应在本票据中默认为“Bridge 可下载任意 URL”。

## 4. MV3 生命周期约束

Chrome 通常会在 service worker 空闲 30 秒后终止它；单次事件/API 调用超过 5 分钟，或 `fetch()` 响应超过 30 秒才到达，也会触发终止。全局变量会随 worker 终止而丢失，Chrome 要求持久化状态而不是依赖内存。[Chrome: Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

这直接排除了“background 发起一个可能持续数分钟的 `/export` fetch，直到飞书文档创建完成才返回”的协议。推荐：

```http
POST /v1/exports          -> 202 { "jobId": "..." }
GET  /v1/exports/:jobId   -> 200 { "state": "queued|running|succeeded|failed", ... }
DELETE /v1/exports/:jobId -> optional cancellation
```

- Bridge 持久化 job 状态并独立完成工作，扩展或 popup 消失不影响导出。
- `POST` 应尽快返回；各次 `GET` 都是短请求。
- popup 关闭后停止高频轮询；保存最近 jobId 到 `chrome.storage.local`，下次打开继续查询。若要后台通知，可用 `chrome.alarms`/notifications，但不是 MVP 必需。
- 所有 Chrome 事件监听器在 WXT `defineBackground` 的同步 `main` 执行中顶层注册；WXT 明确要求 MV3 background 的 `main` 不能是 async，且运行时代码不能放在会被构建期 Node 导入执行的模块顶层。[WXT: Background entrypoint](https://wxt.dev/guide/essentials/entrypoints#background)
- 提取、提交、轮询各阶段必须可重试且幂等。`POST` 携带由扩展生成的 idempotency key，可避免 service worker 重启/网络重试意外创建两份同一点击的导出；这不改变已决定的“用户再次点击同一 URL会创建新文档”。

## 5. macOS 安装与自启动

### 5.1 LaunchAgent 选择

个人、单用户 MVP 应安装 per-user LaunchAgent，而非 root LaunchDaemon。Apple 说明用户登录时，per-user `launchd` 会从用户的 `Library/LaunchAgents` 读取配置，退出登录时终止这些 agent；这正好匹配“Chrome 登录会话可用时 Bridge 可用”的需求。[Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

建议 plist 至少包含：

- 唯一 `Label`（例如 `com.feishu-clip.bridge`）。
- `ProgramArguments`，首项是安装后的 Node launcher/可执行文件绝对路径；不要依赖交互 shell 的 `PATH`。
- `RunAtLoad: true`，登录后启动。
- `KeepAlive` 只在异常退出时重启，避免无条件 crash loop；或 MVP 简化为 `KeepAlive: true`，但进程必须稳定、具备退避且安装验收要测试异常重启。
- 显式 `WorkingDirectory`、配置路径和受限日志路径。
- `StandardOutPath` / `StandardErrorPath` 指向用户可读但不含凭据的滚动/受控日志。

Apple 更偏好按需启动，但纯 HTTP Node 服务若不采用 launchd socket activation，就需要在 Chrome 发请求前已经监听。MVP 可接受 `RunAtLoad + KeepAlive`；后续再决定是否实现 launchd socket activation。[Apple: Creating Launch Daemons and Agents — on-demand preference](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html#//apple_ref/doc/uid/10000172i-SW7)

安装器应：

1. 把 Bridge 及其确定版本的运行时/依赖安装到稳定绝对目录；不要让 LaunchAgent 指向仓库、WXT 临时目录或 Homebrew 当前 Node symlink。
2. 创建用户配置/日志目录，token 与配置文件使用 `0700` 目录和 `0600` 文件。
3. 写入 `~/Library/LaunchAgents/com.feishu-clip.bridge.plist`，确保 plist 归当前用户所有且不可被 group/world 写。Apple `launchctl` 文档说明可写的 job plist 会带来任意可执行文件启动风险。[Xcode launchctl(1) man page mirror](https://keith.github.io/xcode-man-pages/launchctl.1.html)
4. 使用现代 `launchctl bootstrap gui/<uid> <plist>` 加载，并以 `launchctl print gui/<uid>/com.feishu-clip.bridge`、HTTP health check 验证。更新时先 `bootout`，原子替换后再 `bootstrap`；卸载要同时停服务、删除 plist，并明确是否保留用户配置。
5. 输出固定的 unpacked extension 目录，指导用户在 `chrome://extensions` 开启 Developer mode 并 “Load unpacked”。更新扩展时复用同一目录，避免基于路径的 ID变化；若采用 manifest `key`，仍需验证生成 ID符合 Bridge allowlist。

### 5.2 首次安装失败模式

安装/设置页必须能区分并提示：

- Bridge 未运行或端口占用。
- host permission/Origin 不匹配。
- 尚未配对、token 失效或重装后 extension ID 改变。
- `lark-cli` 未安装、未登录、权限不足。
- LaunchAgent 已加载但立即退出（展示最后退出状态与日志位置）。
- Chrome 的 LNA/CORS/mixed-content 行为变化。

设置页至少显示 Bridge version、extension ID、pairing 状态、lark auth 状态、默认知识库目标和一次端到端诊断按钮。

## 6. MVP 验收清单

### 权限与安全

- 构建后的 `manifest.json` 只有 `activeTab`、`scripting`、`storage` 和精确 `http://127.0.0.1:<port>/*` host permission。
- 普通 HTTPS 页面无法读取 health，无法创建 export；跨站 form、`fetch(no-cors)` 与伪造简单请求均不能触发导出。
- 另一 unpacked extension（不同 ID）即使能访问该端口，也因 Origin/token 失败。
- 内容脚本消息中不出现 token；扩展无“任意 URL fetch”消息能力。
- Bridge 端口从同一局域网的另一台设备不可连接。

### 生命周期与可靠性

- 提交后立即关闭 popup，导出仍在 Bridge 完成；重开 popup 可恢复状态并打开飞书文档。
- 在 background service worker 被 Chrome 终止后，job 状态不丢失。
- Bridge/Chrome 重启后，已接受 job 的结果可查询；重复网络提交通过 idempotency key 不会产生非用户触发的副本。
- 超大页面、慢图片、飞书限流和 `lark-cli` 登录失效都得到有界超时与可操作错误。

### 安装与自启动

- 全新 macOS 用户按 README 安装，退出终端后 Bridge 仍可用。
- 注销/重新登录后 LaunchAgent 自动恢复并只监听 `127.0.0.1`。
- 安装、升级、重启、卸载命令可重复执行；不会留下第二个 Bridge 或多个 plist。
- 当前 Chrome Stable 下无意外 LNA 提示；若出现，文档能指导定位而不是要求关闭浏览器安全功能。

## 7. 建议形成的新决策票据

1. **确定 Bridge 异步 job 协议与幂等语义**：明确 job 状态机、持久化、取消、重试、popup 恢复和“一次点击”幂等键边界。
2. **确定图片获取位置与 SSRF/体积限制**：在扩展侧抓取字节和 Bridge 侧下载 URL 之间取舍，并定义重定向、私网地址、大小、类型与失败降级规则。
3. **确定 unpacked extension ID 与重新配对策略**：选择“固定安装路径 + 首次动态配对”还是 manifest `key` 固定 ID，并定义更新/迁移体验。

## Sources

- [Chrome: Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome: Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Chrome: Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
- [Chrome: activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome: scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome: storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome: Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome: Manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Chromium: Content-script cross-origin fetch changes](https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/)
- [Chrome: New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Chromium source: Local Network Access browser tests](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/local_network_access/local_network_access_browsertest.cc#323)
- [Chrome 129 release notes](https://developer.chrome.com/release-notes/129#deprecate_0.0.0.0_for_private_network_access)
- [Chrome 145 release notes](https://developer.chrome.com/release-notes/145#local-network-access-split-permissions)
- [WXT: Manifest configuration](https://wxt.dev/guide/essentials/config/manifest.html)
- [WXT: Entrypoints](https://wxt.dev/guide/essentials/entrypoints)
- [Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Xcode launchctl(1) man page mirror](https://keith.github.io/xcode-man-pages/launchctl.1.html)
