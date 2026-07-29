import { describe, expect, test } from "bun:test";
import {
  buildConversationRetrievalQuery,
  decideConversationContext,
  decideResponse,
  isAnswerRequest,
  isTechnicalRequest,
  needsWebSearch,
  requestsConversationContext,
  referencesRecentConversation,
  shouldRespond,
  stripBotMention,
  voiceCapabilityStatusReply,
  wantsImageCard,
  wantsVoiceReply,
} from "../src/discord/router.ts";

describe("Discord response routing", () => {
  const base = {
    content: "ordinary server chatter",
    mode: "ambient" as const,
    isDirectMessage: false,
    isMentioned: false,
    isReplyToBot: false,
    isOwner: false,
    mentionsOtherRecipients: false,
    hasImage: false,
    ambientReplyChance: 0.08,
  };

  test("always responds to direct conversation", () => {
    expect(shouldRespond({ ...base, isMentioned: true, random: 1 })).toBeTrue();
    expect(
      shouldRespond({ ...base, isReplyToBot: true, random: 1 }),
    ).toBeTrue();
    expect(
      shouldRespond({ ...base, isDirectMessage: true, random: 1 }),
    ).toBeTrue();
  });

  test("classifies direct and ambient messages separately", () => {
    expect(decideResponse({ ...base, isMentioned: true, random: 1 })).toBe(
      "direct",
    );
    expect(
      decideResponse({ ...base, content: "gopher you alive", random: 1 }),
    ).toBe("direct");
    expect(
      decideResponse({
        ...base,
        content: "how are you lil bro?",
        random: 0.69,
      }),
    ).toBe("ambient");
  });

  test("stays silent when another recipient is tagged", () => {
    expect(
      decideResponse({
        ...base,
        content: "2 week salary rokdo",
        mentionsOtherRecipients: true,
        random: 0,
      }),
    ).toBe("ignore");
    expect(
      decideResponse({
        ...base,
        isMentioned: true,
        mentionsOtherRecipients: true,
        random: 1,
      }),
    ).toBe("direct");
    expect(
      decideResponse({
        ...base,
        content: "gopher ask them about it",
        mentionsOtherRecipients: true,
        random: 1,
      }),
    ).toBe("direct");
  });

  test("treats owner instructions as direct without hijacking owner chatter", () => {
    expect(
      decideResponse({
        ...base,
        content: "bro fix the server setup",
        isOwner: true,
        random: 1,
      }),
    ).toBe("direct");
    expect(
      decideResponse({
        ...base,
        content: "nice weather today",
        isOwner: true,
        random: 1,
      }),
    ).toBe("ignore");
    expect(
      decideResponse({
        ...base,
        content: "tell zentex to handle it",
        isOwner: true,
        mentionsOtherRecipients: true,
        random: 0,
      }),
    ).toBe("ignore");
  });

  test("does not mistake ordinary yo-prefixed chatter for a direct address", () => {
    expect(decideResponse({ ...base, content: "yo:gurt", random: 1 })).toBe(
      "ignore",
    );
    expect(
      decideResponse({ ...base, content: "yo gopher you alive", random: 1 }),
    ).toBe("direct");
  });

  test("samples general questions more often without answering all of them", () => {
    expect(
      decideResponse({
        ...base,
        content: "anyone watching the match?",
        random: 0.69,
      }),
    ).toBe("ambient");
    expect(
      decideResponse({
        ...base,
        content: "anyone watching the match?",
        random: 0.71,
      }),
    ).toBe("ignore");
  });

  test("ambient mode occasionally joins general conversation", () => {
    expect(shouldRespond({ ...base, random: 0.01 })).toBeTrue();
    expect(shouldRespond({ ...base, random: 0.5 })).toBeFalse();
  });

  test("mentions-only mode stays quiet unless addressed", () => {
    expect(shouldRespond({ ...base, mode: "mentions", random: 0 })).toBeFalse();
  });

  test("answers Go questions in ambient mode", () => {
    expect(
      shouldRespond({
        ...base,
        content: "why does this goroutine leak?",
        random: 1,
      }),
    ).toBeTrue();
  });

  test("strips both Discord mention syntaxes", () => {
    expect(stripBotMention("<@123> yo <@!123>", "123")).toBe("yo");
  });

  test("detects research and card intent", () => {
    expect(needsWebSearch("what is the latest stable Go version?")).toBeTrue();
    expect(needsWebSearch("tell me a bad joke")).toBeFalse();
    expect(wantsImageCard("make me a cursed verdict card")).toBeTrue();
  });

  test("detects explicit voice replies without confusing voice channels", () => {
    expect(wantsVoiceReply("reply in a voice message please")).toBeTrue();
    expect(wantsVoiceReply("voice mein answer kar")).toBeTrue();
    expect(wantsVoiceReply("say it out loud")).toBeTrue();
    expect(
      wantsVoiceReply("create a voice channel called bakchodi"),
    ).toBeFalse();
  });

  test("grounds questions about live voice listening in the actual capability state", () => {
    const enabled = {
      nativeVoiceEnabled: true,
      liveVoiceChatEnabled: true,
      liveVoiceChatActive: false,
    };
    expect(
      voiceCapabilityStatusReply("maybe the bot can talk but can it listen", enabled),
    ).toContain("/voicechat join");
    expect(
      voiceCapabilityStatusReply("you can listen u dumb fuck", enabled),
    ).toContain("/voicechat join");
    expect(
      voiceCapabilityStatusReply("can it listen?", { ...enabled, liveVoiceChatActive: true }),
    ).toContain("explicitly started VC session");
    expect(
      voiceCapabilityStatusReply("can it listen?", {
        ...enabled,
        liveVoiceChatEnabled: false,
      }),
    ).toContain("isn't enabled");
    expect(voiceCapabilityStatusReply("listen to this song", enabled)).toBeUndefined();
  });

  test("distinguishes technical requests from casual chatter", () => {
    expect(isTechnicalRequest("why does this goroutine leak?")).toBeTrue();
    expect(isTechnicalRequest("review this typescript code")).toBeTrue();
    expect(isTechnicalRequest("bro that movie was dead")).toBeFalse();
  });

  test("keeps real general questions out of the one-line casual path", () => {
    expect(isAnswerRequest("explain quantum entanglement simply")).toBeTrue();
    expect(isAnswerRequest("what should I cook tonight?")).toBeTrue();
    expect(isAnswerRequest("bro just woke up")).toBeFalse();
  });

  test("loads stored chat only when casual messages explicitly ask for it", () => {
    expect(requestsConversationContext("what up")).toBeFalse();
    expect(
      requestsConversationContext("remember what we discussed earlier?"),
    ).toBeTrue();
    expect(requestsConversationContext("continue from last time")).toBeTrue();
    expect(requestsConversationContext("where were we bro")).toBeTrue();
    expect(requestsConversationContext("then what happened")).toBeTrue();
  });

  test("enriches vague callback searches with recent human context", () => {
    expect(
      buildConversationRetrievalQuery("what about that?", [
        "anyone watching the match",
        "the umpire sold so hard",
      ]),
    ).toBe(
      "what about that? OR anyone watching the match OR the umpire sold so hard",
    );
    expect(
      buildConversationRetrievalQuery("explain this mutex", [
        "old unrelated chat",
      ]),
    ).toBe("explain this mutex");
  });

  test("isolates standalone casual mentions from stale recent topics", () => {
    expect(
      decideConversationContext({
        ambient: false,
        casual: true,
        forceRecent: false,
        content: "kya bey gandu",
      }),
    ).toBe("none");
    expect(
      decideConversationContext({
        ambient: false,
        casual: true,
        forceRecent: true,
        content: "why though",
      }),
    ).toBe("recent");
    expect(
      decideConversationContext({
        ambient: false,
        casual: true,
        forceRecent: false,
        content: "you saw that?",
      }),
    ).toBe("recent");
    expect(
      decideConversationContext({
        ambient: false,
        casual: true,
        forceRecent: false,
        content: "remember that image from earlier?",
      }),
    ).toBe("full");
  });

  test("recognizes short conversational continuations", () => {
    expect(referencesRecentConversation("wdym")).toBeTrue();
    expect(referencesRecentConversation("then what")).toBeTrue();
    expect(referencesRecentConversation("bro just woke up")).toBeFalse();
  });
});
