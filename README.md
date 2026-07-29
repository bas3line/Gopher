# Gopher

> An absurdly capable AI Discord bot with long-term memory, web research, vision, voice replies,
> image cards, moderation tools, and custom-emoji fluency.

Gopher started with a simple idea: most Discord bots either feel like a command menu or a chatbot
that forgets the room every five minutes. We wanted one that could actually hang in a server,
remember useful context, answer technical questions, research current information, and still have
enough personality to not feel like a support ticket.

It is AI, not a person. It does not execute code from chat, invent Discord permissions, or get to
make moderation decisions on its own.

## How it is built

- **TypeScript + Bun + discord.js** for the bot runtime and Discord interactions.
- **OpenAI-compatible models** for chat and image understanding.
- **PostgreSQL** for chat memory, lexical retrieval, durable summaries, and cached research.
- **Redis** for deduplication, rate limits, locks, and one-shot moderation confirmations.
- **Firecrawl** for opt-in web research, plus Fish Audio and Cloudflare Aura-2 for voice replies.
- **Cloudflare Whisper Turbo + Aura-2** for opt-in, administrator-started live voice conversations. Audio, transcripts, and the short call context stay ephemeral.
- **Lavalink** for durable, per-server voice playback and YouTube search—inside Compose, never as a shell-out downloader.
- **Docker Compose** to run the bot, PostgreSQL, Redis, and optional music node together.

The bot can participate in ambient chat or reply only when mentioned. It keeps model context bounded
with recent messages, PostgreSQL full-text retrieval, and rolling summaries rather than pretending
it can remember an infinite server forever.

## Get running

You need Bun 1.3+ and Docker Compose.

```bash
git clone https://github.com/bas3line/Gopher.git
cd Gopher
bun install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

Open `.env` and set:

1. `DISCORD_TOKEN` from the [Discord Developer Portal](https://discord.com/developers/applications).
2. `TEXT_API_URL`, `TEXT_API_KEY`, and `TEXT_MODEL` for an OpenAI-compatible text provider.
3. A real `POSTGRES_PASSWORD` instead of `change-me`.

Vision, web research, and voice are optional. Add their keys only if you want those features.
Never commit `.env`.

For live voice chat, Cloudflare credentials are required. Set `VOICE_CHAT_ENABLED=true`; then a server
administrator can join a VC and run `/voicechat join`. The bot uses Cloudflare Whisper Large v3 Turbo
for speech-to-text and Aura-2 for speech, while its normal text model handles the conversation. Set
`VOICE_CHAT_LANGUAGE` if your server primarily speaks another supported language. Sessions time out after
15 minutes by default, never start merely because someone joins a channel, and can be stopped with
`/voicechat leave`.

To enable music, set `MUSIC_ENABLED=true`, generate a unique `LAVALINK_PASSWORD`, and start the
music profile too. Lavalink stays on the internal Docker network; do not publish port `2333`.

Start everything:

```bash
docker compose --profile bot up -d --build
docker compose logs -f bot
```

With music enabled:

```bash
docker compose --profile bot --profile music up -d --build
docker compose logs -f lavalink bot
```

Gopher runs database migrations when it starts. Its health endpoint is available inside the container
at `http://127.0.0.1:3000/healthz`.

## Discord setup

Create a Discord application, add a bot, and enable **Message Content Intent**. Invite it with the
`bot` and `applications.commands` scopes, then give it only the permissions it needs: View Channels,
Send Messages, Read Message History, Add Reactions, Attach Files, Connect, Speak, Send Voice
Messages, and Use Application Commands.

Use `/music play <song or URL>` after joining voice. Gopher persists queues and volume in PostgreSQL;
`/music queue`, `/music now`, `/music pause`, `/music resume`, `/music skip`, `/music remove`,
`/music shuffle`, `/music volume`, `/music seek`, `/music history`, and `/music stop` cover the rest.
Music history is capped at the latest 100 completed tracks per server.

`/voicechat join`, `/voicechat leave`, and `/voicechat status` are server-only administrator controls.
Voice chat takes ownership of the channel while active, so end it before issuing music commands. It does
not save raw audio, Whisper transcripts, or in-call context to PostgreSQL; it records only anonymous
model success/latency accounting.

`/server` moderation commands need extra Discord permissions and always require an administrator's
explicit, expiring confirmation. The model never executes moderation actions.

## Develop

```bash
bun run check
bun test
bun run dev
```

Live provider checks are opt-in so a normal test run never spends your API credits. See
[`package.json`](package.json) for the available `smoke:*` commands.

## Join the server

Come say hi, report bugs, or show us the weirdest thing Gopher did:

[discord.gg/f5Afe62uJj](https://discord.gg/f5Afe62uJj)

## Security and privacy

Gopher stores the messages it can see so memory and retrieval work. Tell your members, limit its
channel access, and set a retention policy that fits your server. Read [SECURITY.md](SECURITY.md)
before running it in a real community.
