# 飞书剪藏 MVP

Chrome/Edge MV3 扩展通过只绑定 `127.0.0.1:38479` 的本机 Bridge，把当前来源页面剪藏为现有 Wiki 父节点下的新飞书文档。Bridge 复用 `lark-cli` 的用户 OAuth，不读取或复制飞书 token。

## 前置条件

- macOS、Chrome 或 Edge、Node.js 22+
- 已安装 `lark-cli`，且 `lark-cli auth status --json --verify` 显示用户身份 ready
- 一个当前用户可访问的现有 Wiki 父节点 token

## 安装

```bash
npm test
npm run install:mac
```

安装器输出固定扩展目录和一次性配对码。打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载输出的目录。随后打开扩展设置：

1. 粘贴配对码完成动态配对；
2. 输入现有 Wiki 父节点 token，验证并保存默认目标；
3. 打开一篇 `http(s)` 文章，点击扩展的“保存到飞书”。

弹窗关闭不会中断 Bridge job；重新打开会恢复进度。成功或部分成功时可直接打开生成文档。每次点击都是新的剪藏尝试，不会覆盖旧文档。

## 运行维护

```bash
npm run status:mac
npm run install:mac             # 原地升级，保留配对
npm run pair:mac                # 生成新配对码；成功前旧配对仍有效
npm run uninstall:mac
```

安装根目录为 `~/Library/Application Support/FeishuClip`，LaunchAgent 为 `com.feishu-clip.bridge`。卸载会移除 Bridge、LaunchAgent、日志、配置和凭据；Chrome 中的扩展需由用户点击移除。

## 已知 MVP 边界

- 保存目标必须是现有 Wiki 父节点，不支持知识空间根目录。
- 正文支持标题、段落、链接、强调、列表、引用、代码和基础表格。
- 图片限 JPEG/PNG/GIF/WebP；单图 8 MiB、每篇 30 张、总计 40 MiB。浏览器传递可读取的 `blob:`、`data:` 与同源图片字节；Bridge 对页面快照声明的公网 HTTP(S) 图片逐跳执行 SSRF 校验后下载，不携带页面凭据。
- 正文已创建而图片失败时返回“部分成功”，保留可用原图链接或安全占位。
- 正式发布前仍需在安装后的真实 macOS 注销/登录场景中验收 LaunchAgent 自启动。
