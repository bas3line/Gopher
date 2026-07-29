import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const commandData = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the server's low-key resident Gopher about anything")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Your question or code problem")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Research the web, then answer with sources")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("What to research")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Ask anything and get the answer as a native voice message")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("What to answer in voice")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("card")
    .setDescription(
      "Turn any take, roast, or verdict into a shareable image card",
    )
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("The take, review, or question")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("memory")
    .setDescription("Show the current channel's rolling long-term memory"),
  new SlashCommandBuilder()
    .setName("about")
    .setDescription("Explain what this bot is and what it can do"),
  new SlashCommandBuilder()
    .setName("server")
    .setDescription("Admin-only server actions with confirmation")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ban")
        .setDescription("Ban a member after confirmation")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Member to ban")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Audit-log reason")
            .setMaxLength(512),
        )
        .addIntegerOption((option) =>
          option
            .setName("delete_days")
            .setDescription("Delete this many days of their messages")
            .setMinValue(0)
            .setMaxValue(7),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("kick")
        .setDescription("Kick a member after confirmation")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Member to kick")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Audit-log reason")
            .setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("timeout")
        .setDescription("Timeout a member after confirmation")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Member to timeout")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("minutes")
            .setDescription("Timeout length in minutes")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(40_320),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Audit-log reason")
            .setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("role-create")
        .setDescription("Create a role after confirmation")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Role name")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100),
        )
        .addStringOption((option) =>
          option
            .setName("color")
            .setDescription("Optional hex color, like #22c55e"),
        )
        .addBooleanOption((option) =>
          option
            .setName("mentionable")
            .setDescription("Allow members to mention this role"),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Audit-log reason")
            .setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("role-delete")
        .setDescription("Delete a role after confirmation")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Role to delete")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Audit-log reason")
            .setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channel-create")
        .setDescription("Create a text or voice channel after confirmation")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Channel name")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100),
        )
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("Channel type")
            .setRequired(true)
            .addChoices(
              { name: "text", value: "text" },
              { name: "voice", value: "voice" },
            ),
        )
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription("Optional parent category")
            .addChannelTypes(ChannelType.GuildCategory),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Audit-log reason")
            .setMaxLength(512),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channel-delete")
        .setDescription("Delete a channel after confirmation")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel to delete")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Audit-log reason")
            .setMaxLength(512),
        ),
    ),
].map((command) => command.toJSON());

export const aboutText =
  "**Gopher** is an AI bot—not a human—with dry group-chat energy and senior Go experience. " +
  "It remembers channel context in PostgreSQL, retrieves older relevant chat, can inspect images, " +
  "uses Firecrawl for explicit or time-sensitive web research, and can send Fish Audio voice replies. " +
  "Mention it, reply to it, use `/ask`, `/voice`, `/search`, or `/card`. Server administrators can use confirmed `/server` actions. It never executes " +
  "pasted code, and its takes are not proof: run your tests.";
