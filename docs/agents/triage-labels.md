# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Option in 标签 field | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role, use the corresponding option name from this table.

Labels are options of the multi-select 标签 field in the Feishu Bitable issue tracker (see `docs/agents/issue-tracker.md`). Apply or remove them by writing the full 标签 array via `lark-cli base +record-batch-update`. Only existing options are writable — new options must be added to the field first via `+field-update`.

Edit the right-hand column to match whatever vocabulary you actually use.
