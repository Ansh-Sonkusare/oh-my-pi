# Autonomous Memory

omp supports six memory modes. Memory is disabled by default; select one backend via `/settings` or `config.yml`:

| `memory.backend` | Storage and behavior                                                   | Guide                                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `off`            | No memory backend                                                      | —                                                       |
| `local`          | Project-scoped summaries and lessons generated from persisted sessions | This page                                               |
| `hindsight`      | Remote, bank-scoped Hindsight memory                                   | [Hindsight](#hindsight-remote-backend)                  |
| `mnemopi`        | Local Mnemopi SQLite memory                                            | [Mnemopi memory backend](./mnemosyne-memory-backend.md) |
| `sharpshooter`   | Friction-gated project decision files (architecture/product/style), consolidated in the background | —                           |
| `supermemory`    | Remote Supermemory memory, hosted or self-hosted: recalls on the first prompt and retains the transcript every few turns | [Supermemory](#supermemory-backend) |

Enable the local summary pipeline:

```yaml
memory:
  backend: local
```

## Usage

### What gets injected

At session start, if a consolidated summary or manually captured lesson exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The summary and lessons share `memories.summaryInjectionTokenLimit`.

If startup consolidation finishes after the first prompt build, the active session's summary snapshot is refreshed. Captured lessons remain pinned to the initial snapshot, so a concurrent `learn` call still affects only later sessions.

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Reading memory artifacts

The agent can read memory files directly using `memory://` URLs with the `read` tool:

| URL                                    | Content                              |
| -------------------------------------- | ------------------------------------ |
| `memory://root`                        | Compact summary injected at startup  |
| `memory://root/MEMORY.md`              | Full long-term memory document       |
| `memory://root/learned.md`             | Lessons captured by the `learn` tool |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook           |
| `memory://<memory-id>`                 | Full Mnemopi memory row (working or episodic) with a YAML frontmatter metadata header; only available when `memory.backend` is `mnemopi` |

The `memory://<memory-id>` form returns the full stored row rather than the clipped recall preview (recall content that exceeds the preview cap ends with a trailing `…`); agents are instructed to read it before any `memory_edit update`.

The `memory://root[/…]` rows are file-backed and only exist with `memory.backend: local`, which populates the on-disk memory root via the consolidation pipeline. Under `hindsight`, `mnemopi`, or `supermemory` the root is never written, so those URLs do not resolve — use `recall` (plus `reflect` on `hindsight` and `mnemopi`, and `read memory://<memory-id>` on `mnemopi`) instead.

### `/memory` slash command

| Subcommand            | Effect                                                    |
| --------------------- | --------------------------------------------------------- |
| `view`                | Show the current backend injection payload                |
| `stats`               | Show backend-specific memory statistics, when supported   |
| `diagnose`            | Show backend-specific diagnostics, when supported         |
| `queue`               | Show pending memory deltas awaiting consolidation         |
| `sync`                | Run memory consolidation now                              |
| `clear` / `reset`     | Delete active backend memory data/artifacts               |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend |
| `mm …`                | Hindsight mental-model maintenance (`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`); unsupported in ACP mode |

### Capturing lessons

Enable `autolearn.enabled` to make the `learn` tool available:

```yaml
autolearn:
  enabled: true
```

With the local backend active, `learn` saves explicit durable lessons to the project's `learned.md`. Lessons are newest-first, deduplicated, secret-redacted, capped at 100 entries, and injected starting with the next session; a `learn` call does not mutate the active session's prompt-cache prefix. Each lesson's content is capped at 2,000 characters and optional context at 400 characters. Structured memory search, `recall`, `retain`, `reflect`, and `memory_edit` are not available for the local backend.

With `supermemory` active, `learn` stores the lesson in the project container like `retain` does; the optional `skill` payload works as with the other backends.

## How it works

Local summary memories are built by a background pipeline that runs at startup; `/memory enqueue` marks consolidation work that the next startup picks up. The pipeline is skipped for subagents and for sessions that are not persisted to a session file.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, currently active, or beyond the configured scan/age limits are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three generated outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

The separately maintained `learned.md` is not overwritten by consolidation.

Phase 2 uses a lease and heartbeat to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

Consolidated output is redacted for common secret/token patterns before `MEMORY.md`, `memory_summary.md`, or generated skills are written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                      | Purpose                                          | Variables                                   |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | System prompt for per-session extraction         | —                                           |
| `stage_one_input.md`      | User-turn template wrapping session content      | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | System prompt for cross-session consolidation    | —                                           |
| `consolidation.md`        | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | Memory guidance injected into live sessions      | `{{memory_summary}}`, `{{learned}}`         |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `local` for this pipeline; legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.threadScanLimit`            | `300`   | Maximum recent session records scanned at startup                                                                                        |
| `memories.maxRawMemoriesForGlobal`    | `200`   | Maximum per-session extractions supplied to global consolidation                                                                         |
| `memories.stage1Concurrency`          | `8`     | Concurrent per-session extraction jobs                                                                                                   |
| `memories.stage1LeaseSeconds`         | `120`   | Extraction job lease duration                                                                                                            |
| `memories.stage1RetryDelaySeconds`    | `120`   | Delay before a failed extraction becomes claimable again                                                                                 |
| `memories.phase2LeaseSeconds`         | `180`   | Consolidation lease duration                                                                                                             |
| `memories.phase2RetryDelaySeconds`    | `180`   | Delay before failed consolidation is retried                                                                                             |
| `memories.phase2HeartbeatSeconds`     | `30`    | Consolidation lease heartbeat interval                                                                                                   |
| `memories.rolloutPayloadPercent`      | `0.7`   | Fraction of the selected model's context budget available to rollout payloads                                                            |
| `memories.phase1InputTokenLimit`      | `4000`  | Per-session extraction input cap                                                                                                         |
| `memories.fallbackTokenLimit`         | `16000` | Model token budget used when the model has no finite declared context window                                                             |
| `memories.summaryInjectionTokenLimit` | `5000`  | Shared approximate token cap for the summary and captured lessons injected into the system prompt                                        |

## Hindsight remote backend

Hindsight requires a reachable [Hindsight](https://hindsight.vectorize.io/) server. The default endpoint is `http://localhost:8888`; set a token when the server requires authentication:

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` environment variables override `hindsight.*` settings, which override built-in defaults. See the [complete Hindsight environment-variable table](./environment-variables.md#hindsight-memory-backend) for all 18 supported overrides, accepted values, parsing rules, precedence, and defaults.

By default, Hindsight uses `per-project-tagged` scoping: writes go to a shared bank with a project tag, while recall includes project-tagged and untagged global memories. `per-project` isolates each working-directory project in its own bank; `global` uses one shared bank. An explicit `hindsight.bankId` selects the bank base. Changes to the bank ID, prefix, or scoping rebuild the primary session state so later operations use the new scope.

Both project-scoped modes name the project the same way: take the repository's primary checkout root (so every linked worktree of one repository resolves to the same directory), then lowercase its basename. A checkout at `~/code/General` therefore tags `project:general`. Tags are matched literally, so this fold is what keeps one repository in one memory scope no matter how the path is capitalised.

The primary session recalls on its first model turn (`hindsight.autoRecall: true`) and automatically retains completed conversation turns every three user turns by default. `/memory enqueue` flushes queued tool retains and forces retention of the current session. At agent end, the primary state schedules cadence-based retention and flushes the retain queue; session disposal drains that queue before releasing the state. Request failures and configured timeouts are logged and leave the coding session usable. Subagents alias the parent's client, bank, and scope for explicit `recall`, `retain`, and `reflect` calls, but do not run their own automatic recall or retention.

Recall is injected as background context, not instructions, and recalled memory is also available as extra context during compaction. Selecting Hindsight exposes `recall`, `retain`, and `reflect`; `memory_edit` is not available because upstream Hindsight memories are not edited through this backend.

`/memory view`, `/memory stats`, `/memory diagnose`, and `/memory enqueue` operate through the active Hindsight state. `/memory clear` first drains pending retains, then clears only the local session state and recall cache. It **does not delete the server-side bank**; delete that bank with the Hindsight UI or API.

## Supermemory backend

`memory.backend: supermemory` keeps memory in [Supermemory](https://supermemory.ai), hosted or self-hosted. omp sends `supermemory.apiKey` as a bearer token; without a key the backend stays inert and `recall`, `retain`, and `learn` are not offered.

```yaml
memory:
  backend: supermemory
supermemory:
  apiKey: ${SUPERMEMORY_API_KEY}
```

| Setting                         | Env var               | Default                      | Effect                                                                                           |
| ------------------------------- | --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `supermemory.apiKey`            | `SUPERMEMORY_API_KEY` | unset                        | Bearer API key. Required.                                                                        |
| `supermemory.apiUrl`            | `SUPERMEMORY_API_URL` | `https://api.supermemory.ai` | Server base URL.                                                                                 |
| `supermemory.recallLimit`       | —                     | `5`                          | Maximum hits per search. Automatic recall searches the user and project containers separately.   |
| `supermemory.threshold`         | —                     | `0.6`                        | Search threshold from 0 to 1; higher values return fewer, closer matches.                        |
| `supermemory.autoRecall`        | —                     | `true`                       | Recall on the first prompt of a session.                                                         |
| `supermemory.autoRetain`        | —                     | `true`                       | Retain the session transcript automatically.                                                     |
| `supermemory.retainEveryNTurns` | —                     | `3`                          | Retain after every Nth completed turn; `0` disables automatic retention.                         |

`SUPERMEMORY_API_KEY` and `SUPERMEMORY_API_URL` override the matching settings, which override the built-in defaults. While `memory.backend` is `supermemory`, `/settings` → Memory shows a Supermemory group with the API key, API URL, auto-recall, and auto-retain; the other three settings are config-file only.

### Container tags

Supermemory scopes data by container tag. omp uses two:

- User: `omp_user_<hash>`, where `<hash>` is the first 16 hex characters of the SHA-256 of your OS username. The same tag serves every project.
- Project: `omp_project_<name>_<hash>`, where `<name>` is the lowercase basename of the repository's primary checkout root with anything outside `a-z`, `0-9`, and `_` replaced by `_`, and `<hash>` is the first 16 hex characters of the SHA-256 of that root path. Every linked worktree of one repository resolves to the same primary checkout, so they share one project tag.

Recall reads both tags. Everything omp writes goes to the project tag.

### Recall and retain

On the first prompt of a session (`supermemory.autoRecall: true`), omp fetches your Supermemory profile and searches the user and project tags with that prompt, then injects the result as a `<memories>` block of background context, not instructions. Sections are User profile, Recent context, Relevant user memories, and Relevant project memories; empty sections are omitted. The block is kept for the rest of the session, and `/new` recalls again. A failed request is logged and skipped; if all three fail, nothing is injected.

Searches run in Supermemory's `hybrid` mode, which matches both extracted memories and raw document chunks. A hit is therefore either a distilled memory or an excerpt of an uploaded document, such as a retained transcript.

Automatic retention (`supermemory.autoRetain: true`) runs after every `supermemory.retainEveryNTurns`th completed turn. It uploads the session transcript (user and assistant text only, recalled-memory blocks stripped, secrets redacted, newest 100,000 characters) to the project tag under one document ID per session, so repeated uploads update that document instead of adding new ones. `/memory enqueue` uploads the current transcript immediately. Subagents do not run automatic recall or retention.

The `recall` tool searches both tags and returns hits best first, up to `supermemory.recallLimit`, as `[user|project] <id>: <text> (similarity 0.83)`. The `retain` tool stores each item, with its optional context, as a document in the project tag, and `learn` (with `autolearn.enabled`) does the same for lessons. Retained content and context are secret-redacted before upload. Global scope is Mnemopi-only. A `retain` batch stops at the first failure and reports which items were kept. Failures of automatic recall and retention are logged and never interrupt the session; failures of `recall`, `retain`, and `learn` are returned to the agent as tool errors.

### Self-hosting

Run your own server with [supermemory-docker](https://github.com/Ansh-Sonkusare/supermemory-docker) and point omp at it. `supermemory.apiKey` must still be non-empty; use the key your server expects.

```yaml
memory:
  backend: supermemory
supermemory:
  apiUrl: http://127.0.0.1:6767
  apiKey: ${SUPERMEMORY_API_KEY}
```

### Limits

`reflect` and `memory_edit` are not available: Supermemory memories are neither synthesized nor edited through this backend. `/memory clear` does **not** delete server-side data. Supermemory memories cannot be bulk-deleted from omp, so the command reports that nothing was cleared; delete documents through Supermemory itself.

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, clear/enqueue entry points (the `/memory` command routes here via `packages/coding-agent/src/memory-backend/local-backend.ts`)
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL handler
- `packages/coding-agent/src/supermemory/backend.ts` — Supermemory backend: first-prompt recall, transcript retention, and the search/save used by `recall`, `retain`, and `learn`
- `packages/coding-agent/src/supermemory/client.ts` — REST client for Supermemory search, profile, document, and memory endpoints
- `packages/coding-agent/src/supermemory/tags.ts` — user and project container tags
