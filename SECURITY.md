# Security notes

## Trust boundaries

- Discord users, message history, attachment URLs, and Firecrawl content are untrusted.
- Only Discord-hosted attachment URLs are forwarded to the configured vision provider; the bot does
  not download arbitrary user-supplied URLs.
- Web content is delimited as untrusted JSON and cannot authorize tool use or reveal secrets.
- Recalled memory, semantic search results, and Discord history are also untrusted data. Only the
  current requester message can authorize an agent-driven Discord write.
- The bot does not offer shell execution, arbitrary URL fetching, package installation, or database
  commands to Discord users.
- Discord output disables mentions and suppresses automatic source embeds.
- Agent Discord writes require explicit current-message intent, a fresh requester/bot permission
  check, and a durable action receipt. Sends and inline replies use enforced Discord nonces to
  suppress recent duplicate deliveries. Edits/deletes are limited to bot-authored messages;
  pin/unpin remains owner/administrator-only.
- AI output cannot prepare or execute Discord administration. `/server` uses typed slash-command
  inputs and deterministic code. Explicit Administrator chat imperatives are parsed before the AI
  and may prepare only ban, kick, bounded timeout, role creation, or channel creation actions.
- Every action requires a human Administrator and a requester-bound confirmation plus a fresh
  permission/hierarchy check at execution. Slash confirmations are private; chat confirmations are
  visible but cannot be consumed by another user. Confirmations are single-use and expire from Redis
  after two minutes.
- Chat member resolution accepts a direct user mention or one exact username/display name. It
  rejects zero or multiple matches and never asks a model to infer the target. Natural-language
  deletion is unsupported; admins must select the exact Discord object through `/server`.
- Discord audit-log reasons identify the requesting administrator. The bot role should have only
  Ban Members, Kick Members, Moderate Members, Manage Roles, and Manage Channels as needed;
  Administrator is not required.

## Secrets

Credentials are read only from environment variables. Logging redacts authorization headers,
Discord tokens, Cloudflare API tokens, vision-provider keys, Firecrawl keys, database URLs, and
Redis URLs. `.env` files are ignored by Git and Docker build context.

Typed memory extraction rejects credential-shaped content before storage. Relationship edges are
accepted only between exact active memory identities, require direct transcript evidence, and are
expanded only through the same user/channel/guild visibility filter as primary recall. This is
defense in depth, not a secret scanner: members must not paste credentials into channels the bot can
read. When semantic memory is enabled, typed memory text and recall queries are sent to the
configured embedding provider; choose that provider and its retention terms accordingly.

Use mode `600` for deployed `.env` files, rotate any credential disclosed outside a secret manager,
and never put secret values in CLI arguments or Compose files.

## Data retention

The bot journals all messages visible to it so retrieval works even when it did not answer. Edits
retain message revisions. A Discord deletion tombstones the message, excludes it from working and
lexical context, revokes typed memories and graph edges backed by that evidence, clears the affected
rolling summary, and schedules reconsolidation. Raw content and revision/audit records are still
retained in PostgreSQL until the operator's retention process deletes them.

Restrict channel access, tell members that memory is enabled, and establish a documented
retention/export/deletion policy appropriate for the server. PostgreSQL and Redis are not published
to the host network by the provided Compose deployment.

## Non-claims

Prompt boundaries reduce prompt-injection risk; they do not make model output trustworthy. Generated
code still needs compilation, tests, race detection, and review. Rate limits bound ordinary abuse
and cost; they are not DDoS protection.

Hybrid retrieval, durable side-effect receipts, and bounded multi-tool loops do not make the bot
sentient or infallible. A hard process crash can still interrupt the final answer even when its
already-completed Discord side effects are deduplicated. Local tests do not prove the configured
provider, Firecrawl account, Discord permissions, or deployed runtime.
