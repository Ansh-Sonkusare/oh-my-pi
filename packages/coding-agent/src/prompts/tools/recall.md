Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}`: specific facts or entries.{{#if hasReflect}} `{{toolRefs.reflect}}`: synthesized answer across many memories.{{/if}}

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size).{{#if hasMemoryEdit}} Before any `{{toolRefs.memory_edit}} update`, MUST fetch full row: `read memory://<id>`.{{/if}}
