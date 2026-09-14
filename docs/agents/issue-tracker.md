# Issue tracker: Feishu Bitable

Issues and PRDs for this repo live in a Feishu (Lark) Bitable: https://my.feishu.cn/wiki/YwzbwEheuiYSkbk2Shfc2lcWnzd (wiki node under the "SomeThingsInteresting" wiki doc; open in browser via this URL). Operate it via `lark-cli base` with:

- base_token: `WAMqbDV7nabjaisXq6jcjJ91nVp`
- table: `Issues`, table_id `tblXkRfPuoBZnt4z`

All commands below take `--base-token WAMqbDV7nabjaisXq6jcjJ91nVp --table-id tblXkRfPuoBZnt4z --as user --format json` (omitted for brevity).

Views: `待办 (open)` (view_id `vewFM7CYEi`, filter 状态=open) and `Agent 就绪` (view_id `vew98NTDPG`, filter 状态=open AND 标签 intersects ready-for-agent).

## Fields

| Field | Type | Semantics |
| ----- | ---- | --------- |
| 标题 | text (primary) | Issue title |
| 编号 | number | Issue number (continues the GitHub numbering; next new issue is #89) |
| 状态 | single select (`open` / `closed`) | Issue state |
| 标签 | multi select | Labels; options: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, wayfinder:map, wayfinder:task, wayfinder:research, wayfinder:grilling, wayfinder:prototype |
| 描述 | text | Issue body (Markdown) |
| 评论 | text | Comments as `[YYYY-MM-DD HH:mm:ss] author:\n<body>` entries separated by blank lines; append new comments at the end in the same format |
| 负责人 | text | Assignee (free text) |
| 创建时间 / 关闭时间 | datetime | Creation / close timestamps |
| GitHub 链接 | url | Link back to the archived GitHub issue (historical only) |
| 验收 Specs | text | Acceptance spec/evidence for the issue |
| 父级 Map | text | Wayfinder: parent map reference like `#56` |
| 阻塞依赖 | text | Blocking refs like `#57, #58` |

## Conventions

- **Create an issue**: `lark-cli base +record-batch-create --json '{"create_records":[{"标题":"...","状态":"open","标签":["needs-triage"],"描述":"..."}]}'` (max 200 per batch).
- **Read an issue**: filter on 编号, e.g. `lark-cli base +record-list --filter-json '{"logic":"and","conditions":[["编号","==",56]]}'`. The response rows align with the `fields` array in the response.
- **List issues**: `lark-cli base +record-list --filter-json '{"logic":"and","conditions":[["状态","==","open"],["标签","intersects",["ready-for-agent"]]]}' --limit 200`. Conditions are triples `[field, op, value]`; select fields use `intersects` with an array value.
- **Comment on an issue**: read-modify-write the 评论 field — fetch the current value, append a `[YYYY-MM-DD HH:mm:ss] author:\n<body>` entry after a blank line, write back via `+record-batch-update`.
- **Apply / remove labels**: write the full 标签 array via `+record-batch-update`. Select fields reject unknown options — use only existing option names; new options must be added to the field first (see below).
- **Change any field**: `lark-cli base +record-batch-update --json '{"update_records":{"<record_id>":{"状态":"closed","关闭时间":"YYYY-MM-DD HH:mm:ss"}}}'`. Resolving `<record_id>` requires a prior query by 编号.
- **Close**: batch-update 状态→closed plus 关闭时间; for "close with comment", also append the comment to 评论 in the same update.
- **Add a new label option**: `lark-cli base +field-update --field-id <id> --json '<full field JSON incl. all existing options>' --yes` (PUT semantics). `+field-list` shows current options and field ids.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

GitHub issues remain as a read-only archive, linked from each record's GitHub 链接 field. Do not create or modify GitHub issues or PRs.

## When a skill says "publish to the issue tracker"

Create a record in the Issues table (see **Create an issue** above).

## When a skill says "fetch the relevant ticket"

Query the Issues table by 编号 (see **Read an issue** above).

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single record with **child** records as tickets.

- **Map**: a record with 标签 `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body in 描述.
- **Child ticket**: a record with its 父级 Map field set to the map's `#N` reference.
- **Blocking**: the 阻塞依赖 field holds `#N` refs, e.g. `#57, #58`.
- **Frontier query**: filter 状态=open, 父级 Map=<map ref>, 阻塞依赖 empty, then take the lowest 编号.
- **Claim**: set the 负责人 field via `+record-batch-update`.
- **Resolve**: append the answer to the ticket's 评论, set 状态=closed plus 关闭时间, and append a context pointer to the map record's 评论.

## Acceptance specs

Acceptance criteria and evidence for a ticket live in its 验收 Specs field. Historical evidence was migrated from `docs/acceptance.md`, which is now a frozen archive — new acceptance records go into the 验收 Specs field.
