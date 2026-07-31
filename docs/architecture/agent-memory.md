# Gopher agent and memory architecture

This document describes the implemented agent runtime and long-term memory system. The editable
diagram lives in [`gopher-agent-memory.excalidraw`](./gopher-agent-memory.excalidraw).

## Design goals

1. Preserve the original Discord event before any model interprets it.
2. Keep immediate conversation context fast and bounded.
3. Convert durable facts into typed, revisioned memories with direct evidence.
4. Retrieve only memory visible to the current user/channel/server context.
5. Let the model choose and chain tools, while deterministic code remains the authority for writes.
6. Make every model turn, tool call, memory correction, and Discord action auditable.
7. Recover after process crashes without losing unprocessed memory work.
8. Treat messages, remembered text, and web pages as untrusted data.

## Request path

```text
Discord gateway event
  -> deduplication and rate limits (Redis)
  -> append-only event + raw message journal (PostgreSQL)
  -> deterministic routes (moderation confirmation, reactions, music)
  -> context assembly
       recent working set
       rolling channel summary
       lexical older-message retrieval
       typed durable-memory recall
  -> bounded agent loop
       model turn
       zero or more validated tool calls
       parallel reads / serialized writes
       tool results returned to the model
       repeat until final answer or a hard limit
  -> Discord-safe response
  -> assistant message journal
```

Vision and ambient participation stay on their specialized single-turn paths. Direct text requests
use the agent runtime by default.

## Memory layers

| Layer | Storage | Purpose | Mutation model |
| --- | --- | --- | --- |
| Raw event ledger | `discord_events` | Reconstruct create/edit/delete/reaction/thread/action history | Append-only, idempotent event keys |
| Message journal | `chat_messages`, `chat_message_revisions` | Exact conversational evidence and edit history | Insert once; edits create revisions |
| Working memory | Recent message query | Resolve immediate references without stale-topic contamination | Bounded read |
| Channel summary | `conversation_summaries` | Compress longer channel continuity | Monotonic checkpointed update |
| Durable memory | `memory_items` | Typed profile, preference, fact, decision, project, relationship, commitment, event, skill, correction | Stable-key upsert |
| Memory history | `memory_item_revisions`, `memory_links` | Preserve corrections and relationships between memories | Append revisions; typed edges |
| Research cache | `web_documents` | Retain source material used by web research | URL-keyed refresh |
| Ingestion outbox | `memory_ingestion_jobs`, `memory_channel_checkpoints` | Crash-safe asynchronous consolidation | Claim with `SKIP LOCKED`, retry/backoff |

### Typed-memory scopes

- `user`: visible only as that member's memory inside the current guild/DM identity boundary.
- `channel`: recalled only in the channel where it was learned.
- `guild`: server-wide projects, decisions, norms, and events.

A normal member can explicitly write or forget only their own user-scoped memory. Channel and guild
writes require a configured bot owner or Discord administrator. Automatic extraction may create all
three scopes, but only from direct evidence in the transcript and with a confidence score.

### Stable keys and corrections

Each memory has a stable key such as `preference.runtime` or
`project.atlas.database`.

- Repeated identical evidence raises confirmation/confidence without creating duplicates.
- A corrected value keeps the same key, snapshots the previous version in
  `memory_item_revisions`, increments `version`, and replaces the active value.
- Forgetting changes the active record to `forgotten`; its audit history remains but retrieval
  excludes it.
- Evidence is stored as Discord message IDs, so a recalled statement can be traced back to source
  conversation.

### Retrieval

The current implementation combines:

- PostgreSQL full-text rank;
- trigram similarity over content and stable keys;
- explicit importance and confidence;
- pinned-memory boost;
- recency decay;
- access-frequency reinforcement;
- deterministic scope and expiry filters.

The context assembler retrieves a diverse durable set plus outstanding commitments/projects.
The model can call `memory_search` again with a more focused query when the preloaded context is not
enough. Corrections in the current user message always outrank recalled memory.

## Consolidation lifecycle

Every newly journaled message creates or reopens an ingestion job in the same database transaction.
The background worker:

1. Claims the newest available target for one channel using `FOR UPDATE SKIP LOCKED`.
2. Loads messages after the durable channel checkpoint, bounded by `MEMORY_BATCH_SIZE`.
3. Supplies the transcript, known user IDs, and existing relevant keys to the memory model.
4. Validates strict JSON output with Zod.
5. Rejects unknown users, invented evidence IDs, malformed keys, and credential material.
6. Upserts accepted memories transactionally.
7. Advances the checkpoint and completes every obsolete job covered by it.
8. Retries transient failures with bounded exponential backoff; stale processing leases are
   reclaimable.

Raw messages remain available even when extraction fails, so consolidation can catch up later.

## Agent loop

The loop has six hard controls:

1. Maximum model iterations.
2. Maximum total tool calls.
3. Maximum parallel read calls.
4. Per-tool timeout.
5. Whole-run timeout.
6. Maximum repeated identical call count.

Each assistant tool-call message and every tool result is preserved in the next model input. Read
tools marked parallel-safe execute concurrently. Writes execute in order. An identical successful
write is served from the run-local idempotency cache rather than executed twice.

Unknown tools, malformed JSON, schema violations, denied permissions, and tool failures become
structured tool results; they do not crash the entire process. Repeated-call and budget exhaustion
fail closed.

## Tool catalog

### Read tools

- `memory_search`
- `web_search` through Firecrawl search plus scraped main content
- `discord_read_messages`
- `discord_list_channels`
- `discord_get_member`

### Write tools

- `memory_remember`
- `memory_forget`
- `discord_react`
- `discord_send_message`
- `discord_create_thread`
- `discord_edit_own_message`
- `discord_delete_own_message`
- `discord_pin_message`

Moderation remains outside the model tool layer. Ban, kick, timeout, role, and channel
administration continue through typed Discord inputs or deterministic natural-language parsing,
requester-bound Redis confirmations, and fresh permission/hierarchy checks.

Music and live voice chat remain dedicated stateful services with their existing ownership and
permission rules.

## Write authorization

Model intent is never authorization. A Discord write runs only when all of these are true:

1. Agent-driven Discord actions are enabled.
2. The current user message explicitly requests that exact action.
3. The request is not negated (`do not send`, `never delete`, and similar).
4. The requester can view/use the target channel.
5. The bot has the required Discord permission.
6. Tool-specific ownership rules pass:
   - edits/deletes target only bot-authored messages;
   - pinning requires owner/administrator plus `Manage Messages`;
   - DM tools cannot escape the current DM;
   - cross-channel sends require both requester and bot access.

Web pages, recalled memories, summaries, and tool output cannot authorize writes.

## Trust boundaries

- Discord content, attachments, history, Firecrawl pages, model output, and recalled text are
  untrusted.
- Provider credentials stay in environment variables and never enter prompts or tool results.
- Credential-shaped content is rejected from typed memory.
- Source URLs and scraped content are returned as data, not instructions.
- Discord output disables mentions; agent sends cannot ping users or roles.
- The bot does not expose shell execution, arbitrary HTTP fetching, SQL execution, or package
  installation to Discord.

## Observability

- `agent_runs`: request identity, model, status, iteration/tool counts, aggregate tokens, error code,
  and latency boundary.
- `agent_tool_calls`: call ID, iteration, effect, success, idempotency-cache hit, duration, safe
  output preview, and error code.
- `ai_events`: chat, vision, summary, voice, agent, and memory-extraction success/latency/token
  accounting.
- `discord_events`: durable audit of model-independent and agent-driven Discord activity.

## Failure behavior

- Provider failure: no fabricated answer; the user receives a provider error.
- Firecrawl failure: structured tool error; the model must disclose that live research failed.
- Tool denial: returned to the model with a stable safe error code.
- Process crash during consolidation: stale lease becomes claimable after five minutes.
- Duplicate gateway event: Redis deduplication plus database unique keys.
- Duplicate model write: run-local write cache plus durable event idempotency key.
- Summary failure: raw messages and typed-memory ingestion continue independently.

## Operational limits and non-claims

This architecture creates a capable persistent Discord agent; it does not make the model sentient,
omniscient, or literally AGI. Memory remains evidence-driven and fallible. A local test proves code
behavior, not provider compatibility or live Discord permissions. Production acceptance still
requires live provider tool-calling, Firecrawl, Discord action, and deployment checks with the
configured accounts.
