# lark-cli Drive 原生文件上传事实查证（PDF 原文件直传）

调查日期：2026-09-05  
调查对象：本机安装的官方 `@larksuite/cli` `v1.0.84`（用户 OAuth 身份 `--as user` 实测）  
关联 Issue：#57（父 map #56）

## 结论

用 `lark-cli drive +upload --as user --file <本地相对路径> --folder-token <folder_token>` 即可把本地 PDF **按原格式**上传到指定 Drive 文件夹，不经 `+import` 转换。整条链路已在真实云盘上实测通过：建临时文件夹 → 上传 → 同名复传 → 覆盖上传 → 列举 → 删除清理。

针对 issue 的五个子问题：

1. **命令与档位**：`drive +upload` 一个命令覆盖两种档位；≤ 20 MB 走一次性 `upload_all`，> 20 MB 由 CLI 自动切分片上传（`upload_prepare` / `upload_part` / `upload_finish`，分片固定 4 MB）。API 层一次性上传硬上限 20 MB；分片上传的单文件有效上限是租户版本限额（认证后个人 10 GB 起，企业版 100 GB，见下文「大小上限」）。
2. **根目录 folder token**：`lark-cli api GET /open-apis/drive/explorer/v2/root_folder/meta --as user` 返回 `data.token`。但多数场景不需要它——`+upload` / `+create-folder` 省略 `--folder-token` 即默认根目录。
3. **同名文件行为（实测）**：**不报错、不自动改名、不覆盖**。同名复传会生成一个同名但 `file_token` 全新的第二个文件。要原地覆盖必须显式传 `--file-token`。
4. **文件夹列举**：`lark-cli drive files list --as user --folder-token <token>` 返回子项的 `name` / `token` / `type` / `url`，支持分页与排序，可直接支撑目录选择器 picker。
5. **返回 token 与 URL**：上传成功 JSON 含 `data.file_token`、`data.url`（形如 `https://<租户>.feishu.cn/file/<file_token>`，可直接打开）和 `data.version`。

## 命令契约

所有命令以 argv 数组启动，不经 shell 拼接；结果只认 JSON，成功判断为进程退出码 0 且顶层 `ok == true`。

### 上传本地文件到指定文件夹

```bash
lark-cli drive +upload --as user \
  --file ./relative/path/report.pdf \
  --folder-token FOLDER_TOKEN \
  --name "报告.pdf" \
  --format json
```

- `--file` 必须是 **cwd 下的相对路径**；传绝对路径会被 CLI 拒绝（`unsafe file path`）。Bridge 应为每次上传准备任务目录并从该目录运行 CLI，与图片补插链路一致。
- `--folder-token` 与 `--wiki-token` 互斥；两者都省略时上传到调用者的 Drive 根目录；显式传空字符串会报参数错误。
- `--name` 省略时沿用本地文件名。

成功返回（实测样例，token 已失效）：

```json
{
  "ok": true,
  "data": {
    "file_name": "test.pdf",
    "file_token": "FdXjb4yQzoypMCx1E6xcyQHtnnb",
    "size": 69,
    "url": "https://my.feishu.cn/file/FdXjb4yQzoypMCx1E6xcyQHtnnb",
    "version": "7681878496334892001"
  }
}
```

### 覆盖已存在文件（原地覆盖，保留 file_token）

```bash
lark-cli drive +upload --as user \
  --file ./relative/path/report.pdf \
  --file-token EXISTING_FILE_TOKEN \
  --format json
```

实测：`file_token` 不变，`version` 更新为新值；同时传 `--name` 会顺带改名。日志行会打印 `-> Drive root folder`，那是误导性输出——文件仍留在原文件夹。

### 根目录 folder token

```bash
lark-cli api GET /open-apis/drive/explorer/v2/root_folder/meta --as user --format json
```

返回 `data.token`（本机实测为 `nodcn...` 形态）。typed schema 未注册该接口，走 raw escape hatch。注意：上传到根目录、在根目录建文件夹都可以靠「省略 `--folder-token`」完成，只有需要把根目录当普通 folder token 传递（如 `drive files list` 分页行为差异）时才取它。

### 列举文件夹（picker 用）

```bash
lark-cli drive files list --as user \
  --folder-token FOLDER_TOKEN \
  --page-size 200 --page-all \
  --order-by CreatedTime --direction DESC \
  --format json
```

- 省略/留空 `--folder-token` 列举根目录，但**根目录模式不支持分页、不返回快捷方式**，且一次返回全部。
- 子文件夹列举支持 `--page-token` 分页、`--order-by EditedTime|CreatedTime` 排序；每项含 `name`、`token`、`type`（`file` / `folder` / `docx` 等）、`url`、`created_time`、`modified_time`。picker 按 `type == "folder"` 过滤出可下钻目录即可。
- 新建文件夹用 `drive +create-folder --as user --name <名> [--folder-token <父>]`，返回 `folder_token` 和 `url`。

## 档位与大小上限

| 档位 | 触发条件 | 底层接口 | 上限 |
|---|---|---|---|
| 一次性上传 | 文件 ≤ 20 MB（且非空文件） | `POST /drive/v1/files/upload_all` | 20 MB，5 QPS、10000 次/天 |
| 分片上传 | 文件 > 20 MB，CLI 自动切换 | `upload_prepare` → `upload_part` → `upload_finish` | 分片固定 4 MB；`upload_id` 24 小时有效可断点续传；5 QPS |

- API 层只规定一次性档 20 MB 上限；分片档的单文件实际上限由租户版本决定（[飞书帮助中心](https://www.feishu.cn/hc/zh-CN/articles/360049067549)：基础版认证前 20 MB / 认证后 10 GB，商业版 50–100 GB，企业版 100 GB）。超出会报 `1061043 file size beyond limit`。
- PDF 在云空间**在线预览无大小限制**（同一帮助中心表格），剪藏场景无需担心预览档位。
- 其它相关限制：文件名 ≤ 250 字符；同目录深度 ≤ 15 层、单树节点 ≤ 40 万（错误码 1062506/1062507）。

## 同名文件行为（实测记录）

在临时文件夹 `tmp-issue57-upload-test` 内对同名 `test.pdf` 连传两次：

- 两次均成功，第二次返回**不同的 `file_token`**；
- `drive files list` 显示文件夹内存在**两个同名 `test.pdf`**，name 未被改写（无 `(1)` 后缀）；
- 即同名语义 = **无冲突检测、无自动改名、无覆盖**。

对 Bridge 的含义：以文件夹为目标的上传不是幂等的，超时重试前必须先 `drive files list` 按 name 查重，或记录上次返回的 `file_token` 走 `--file-token` 覆盖上传。这也和 `+import` 的并发冲突语义不同——`+upload` 同名不冲突，但不能靠服务端去重。

## 仍需注意的风险

1. **同名重复**：如上，Bridge 需自行保证幂等（先查重或覆盖）。
2. **相对路径约束**：`--file` 只接受 cwd 相对路径，Bridge 调用时要设置好工作目录。
3. **频控**：上传接口 5 QPS、日限 10000 次；批量上传串行执行，429 时指数退避。
4. **bot 身份差异**：`--as bot` 新建上传会自动尝试给当前 CLI 用户授 `full_access`；`--file-token` 覆盖不改权限。剪藏主链路用 `--as user`，不依赖该行为。

## 证据与复核方式

### 本机官方 CLI（v1.0.84）

- `lark-cli drive +upload --help`（`--file` 注明 "> 20MB use multipart upload automatically"）
- `lark-cli skills read lark-drive` 与 `lark-cli skills read lark-drive references/lark-drive-upload.md`
- `lark-cli drive files list/create_folder --help`
- `lark-cli api GET /open-apis/drive/explorer/v2/root_folder/meta --as user`（实测返回根目录 token）
- 实测序列：`+create-folder` → `+upload` ×2（同名）→ `files list`（确认两个同名文件）→ `+upload --file-token`（确认原地覆盖 + version 更新）→ `+delete --type folder --yes`（已清理，临时文件夹与本地测试文件均已删除）

### 飞书官方文档

- [上传文件（upload_all）：20 MB 上限、5 QPS](https://open.feishu.cn/document/server-docs/docs/drive-v1/upload/upload_all?lang=zh-CN)
- [上传文件概述（分片上传流程）](https://open.feishu.cn/document/server-docs/docs/drive-v1/upload/multipart-upload-file-/introduction?lang=zh-CN)
- [分片上传文件（预上传）：4 MB 定长分片、upload_id 24 小时](https://open.feishu.cn/document/server-docs/docs/drive-v1/upload/multipart-upload-file-/upload_prepare?lang=zh-CN)
- [文件上传、在线预览的大小及格式要求（各版本单文件上限；PDF 预览不限大小）](https://www.feishu.cn/hc/zh-CN/articles/360049067549)

## 调查限制

- 本机 CLI 为 v1.0.84，已有 v1.0.93 可更新；skill 文档中提到的 `drive files upload_prepare/upload_finish` typed 命令在本版本未注册（`lark-cli schema` 仅列出 copy/create_folder/list/patch），需要手动分片时走 `lark-cli api` raw 调用。`+upload` 的自动分片不受影响。
- 分片档的实际单文件上限未以超大文件实测（无必要），以官方版本限额表为准。
