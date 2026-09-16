# PDF Translator 文件契约

PDF Translator 是从论文页面识别 PDF Attachment Candidate 的可执行 JavaScript 适配器。文件采用 Zotero Web Translator 的原始外形：开头是 JSON 元数据对象，后面声明 `detectWeb(document, url)` 与 `doWeb(document, url)`。

## 元数据

```json
{
  "translatorID": "7d4a70c6-5f63-4f65-bc2e-40cc75f5f39a",
  "label": "Example Papers",
  "creator": "Community author",
  "target": "^https://papers\\.example/",
  "priority": 100,
  "translatorType": 4,
  "lastUpdated": "2026-09-16 12:00:00",
  "requestOrigins": ["https://cdn.example"]
}
```

- `translatorID`：稳定 UUID。同一 ID 的用户文件覆盖内置版本。
- `label`：设置页展示名称；同名文件才追加序号。`creator` 保留作者信息，但不在简洁列表中展示。
- `target`：匹配来源页面 URL 的正则表达式；空字符串表示通用后备项。
- `priority`：非负整数，数字越小越先检测。
- `translatorType`：必须是 Zotero Web Translator 使用的 `4`。
- `version`：非空字符串；原始 Zotero 文件可直接使用格式为 `YYYY-MM-DD HH:mm:ss` 的 `lastUpdated`。两者必须至少提供一个。
- `requestOrigins`：可选的跨域请求 origin 数组。只接受不含路径、查询、凭据的 HTTP(S) origin。

## v1 Zotero 兼容子集

文件必须声明 `detectWeb` 与 `doWeb`。v1 接受普通只读 DOM 查询、XPath、常用文本辅助函数、受控网络请求、`new Zotero.Item()`、附件数组和 `item.complete()`。具体支持的 Zotero/ZU 成员由 `src/extension/pdf-translator.js` 的兼容检查器统一判定。

以下能力会在导入时标记为不兼容：

- `Zotero.selectItems` / `ZU.selectItems` 多条目选择。
- `Zotero.loadTranslator` 等嵌套 Translator 调用。
- `Zotero.Search`、`Zotero.Items`、`Zotero.Collections` 等文献库访问。
- 未列入兼容子集的 Zotero/ZU 成员。
- `Zotero["..."]` 计算成员、`const Z = Zotero` 别名或从 Zotero/ZU 解构等无法静态确认的访问。

兼容检查只负责在导入时给出明确反馈。真正执行文件时仍由 PDF Translator Runtime 强制实施隔离、网络权限、超时和响应体预算。

同一 `translatorID` 只选择一个有效版本。通过兼容检查的用户导入版本覆盖内置版本；用户停用覆盖版本时该 ID 不执行，移除用户版本后内置版本自然恢复。不兼容的用户文件仍显示在设置页，但不会静默禁用可用的内置版本。有效版本按 `priority` 从小到大执行。

随扩展提供的默认规则也使用相同文件格式，位于 `src/extension/pdf-translators/`。设置页打开时加载这些文件，并默认启用。`src/extension/paper-sites.js` 是 paper trigger 与预置 Translator 的共享站点清单，新增或删除站点必须同时影响两处，避免规则漂移。

预置规则参考 Zotero 官方 `zotero/translators` 仓库（核对基线 `c83003773b65359e41466e1d419b2d1df5512af7`）中对应站点 Translator，以及其 Embedded Metadata 对 `citation_pdf_url` 的处理。这里只保留 PDF 发现部分，并改写为本项目沙箱支持的接口；不携带 Zotero 的文献元数据导入逻辑。

## PDF 附件输出

`doWeb` 通过 `Zotero.Item.attachments` 返回附件。PDF 附件使用以下字段：

```js
item.attachments.push({
  url: 'https://papers.example/article.pdf',
  title: 'Article PDF',
  mimeType: 'application/pdf',
  primary: true
});
```

- `url` 必须能解析为 HTTP(S) 地址；相对地址按来源页面解析。
- `name` 或 `title` 用作展示文件名。
- `primary: true` 可标记主 PDF。多个标记只保留第一个并生成诊断；没有标记时第一个有效 PDF 成为主 PDF。
- 地址规范化后去重，保留 Translator 的原始顺序和原始序号。
