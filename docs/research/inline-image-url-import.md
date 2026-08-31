# Markdown 内联图片 URL 的导入行为（#44 spike）

调查日期：2026-08-31
调查对象：本机 `lark-cli` `v1.0.84`，真实知识空间「临时数据」下的验收父节点
关联 issue：#44（本 spike）、#45（消费结论）

## 结论

`docs +create/+update --doc-format markdown` 的正文里直接写 `![label](https://...)`，飞书服务端会下载图片并建成真正的图片块（block_type 27，带 file_token 与宽高）。**失败可从 CLI 输出的 `data.warnings[]` 检测**（`degrade_code=2108` + 原始 URL），文档创建本身仍然成功（`ok: true`）。

对 #45 的关键含义：

1. 公开图片可以内联 URL、完全跳过「浏览器下载 → Bridge 下载 → 逐图 4 次 API 调用」管线；
2. 失败的图片**在文档里不留任何痕迹**（块被整体丢弃，无链接文本、无空块），所以回退不能靠「文档内定位残留物」，只能靠 warnings 里的 URL 反查；
3. 服务端**不校验 content-type/魔数**：HTML 页面当图片 URL 也会建成带 token 的图片块（内容是 HTML，前端必然裂图），且**无 warning**——URL 合法性校验必须留在 Bridge/扩展侧；
4. 客户端默认 30s 超时会截断大文档导入：超时后文档节点已创建但正文为空（模糊失败真实存在），Bridge 需要放大 `+create` 的 `timeoutMs` 并沿用既有 `markCreateAmbiguous` 逻辑。

## 实验记录

所有实验文档已删除（`wiki +node-delete`），以下为当时观测值。

### A. 公开图片内联（3 图，2 好 1 坏）

- 2 张 labuladong 图片 → 图片块，token 与宽高（688x856 / 1280x720）齐全；
- 1 张 wikimedia 图片 → 服务端 403，`warnings` 记录 `degrade_code=2108`，文档中**无任何残留块**；
- 全程一次 `+create`，6.8s。

### B. 失败行为矩阵（4 图：好 / 404 / 非图片 / 好）

| 场景 | 文档内结果 | warnings |
|---|---|---|
| 公开可下载 | 图片块 + token | 无 |
| 404 | **无任何残留** | `degrade_code=2108` + URL + HTTP status |
| 非图片 content-type（example.com 的 HTML） | **建成带 token 的图片块，内容为 HTML（裂图）** | **无** |

### C. 耗时基线

- 12 张 picsum.photos 图片：客户端 30.5s 超时（`server time out error`）。超时后文档节点已创建、**正文为空**——picsum 对飞书服务端可达性极差（单独测试 5000x4000 返回 503），且 12 张慢图超过了客户端默认 30s 超时。模糊失败场景确认真实存在。
- 12 张 labuladong 图片（6 个文件 × 2 个 query 变体）：**23.4s，12/12 成功，无 warning**。约 2s/张，与现有逐图管线的单图成本相当，但省掉浏览器下载、Bridge 下载、base64 传输与 4×N 次客户端 API 调用，且无客户端频控暴露。
- 带 query 串的 URL（`?v=1`）正常下载，不受影响。

### D. `+update` append 路径（知识空间根目标的写入方式）

- 内联图片 URL 同样生效，建成带 token 的图片块，1.4s。

### E. 服务端抓取的请求特征

- wikimedia 403 说明服务端抓取不带常见浏览器 UA/Referer 或被目标站点按特征拦截；**需要 Cookie/Referer 的图必然 403/401**——这类图必须保留「浏览器取字节 → 上传」管线。
- 图片尺寸/体积上限未实测（无稳定大图源）；官方素材上传限制为图片 ≤10MB，导入链路推测一致。#45 实现时超限图片应按既有 `image-policy` 限制在扩展侧拦截。

## 对 #45 的设计建议

1. **分类规则**：extractor 未取得字节的图片（跨域公开 URL）→ `prepareMarkdown` 输出 `![label](url)`；取得字节的（同源/需凭证/data/blob）→ 保留锚点 + 上传管线。
2. **失败回退**：解析 `+create`/`+update` 返回的 `data.warnings[]`，匹配 `degrade_code=2108` 提取失败 URL → 这些 URL 对应的图片转入现有「下载 + 原生块插入」管线补插。位置信息问题：失败图在文档里无残留，建议补插时用 str_replace 定位相邻文本，或接受「追加到文末 + warning 提示用户」的简化行为，实现时按成本取舍。
3. **URL 校验前置**：`safeHttpUrl` 之外，非图片 content-type 的 URL 飞书会静默裂图——extractor 侧只把 `readableBytes` 验证过 content-type 的图、或明确来自 `<img>` 元素的 URL 内联；不要内联任何「猜测」的 URL。
4. **超时**：`+create` 的 `timeoutMs` 需要按图片数量放大（12 图 labuladong 图床 23.4s；慢图床会顶到上限），建议 60-120s，并保留 `markCreateAmbiguous` 分支。

## 证据与复核方式

- `lark-cli docs +create --as user --parent-token <wiki_node> --doc-format markdown --content @file.md --format json`（正文含 `![label](url)`）
- `lark-cli api GET /open-apis/docx/v1/documents/{id}/blocks --params '{"page_size":500}' --format json`（检查 block_type 27 与 token）
- `lark-cli api GET /open-apis/drive/v1/medias/{file_token}/download --output ./f.bin`（验证 token 实际内容，example.com 案例即由此确认为 HTML）
- `lark-cli wiki +node-delete --node-token <token> --obj-type wiki --space-id <id> --yes`（清理；注意 node_token 的 `--obj-type` 是 `wiki`，传 `docx` 会 not_found）

## 调查限制

- 大图（>10MB）上限、Referer 防盗链图片未用真实样本实测（wikimedia 403 与 picsum 503/超时覆盖了「服务端不可达」大类）；
- 耗时数据基于单一网络环境（本机 → 飞书），labuladong 图床对飞书服务端较快，其他站点可能更慢；
- 服务端并发下载策略未公开，23.4s/12 图只能作为量级参考。
