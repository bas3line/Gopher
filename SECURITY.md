# Security notes

## Trust boundaries

- Discord users, message history, attachment URLs, and Firecrawl content are untrusted.
- Only Discord-hosted attachment URLs are forwarded to the configured vision provider; the bot does
  not download arbitrary user-supplied URLs.
- Web content is delimited as untrusted JSON and cannot authorize tool use or reveal secrets.
- The bot does not offer shell execution, arbitrary URL fetching, package installation, or database
  commands to Discord users.
- Discord output disables mentions and suppresses automatic source embeds.
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

Use mode `600` for deployed `.env` files, rotate any credential disclosed outside a secret manager,
and never put secret values in CLI arguments or Compose files.

## Data retention

The bot stores all messages visible to it so retrieval works even when it did not answer. Restrict
its channel access, tell members that memory is enabled, and establish a retention/deletion policy
appropriate for the server. PostgreSQL and Redis are not published to the host network by the
provided Compose deployment.

## Non-claims

Prompt boundaries reduce prompt-injection risk; they do not make model output trustworthy. Generated
code still needs compilation, tests, race detection, and review. Rate limits bound ordinary abuse
and cost; they are not DDoS protection.
