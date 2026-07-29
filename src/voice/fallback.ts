import type { Logger } from "../logger.ts";
import type {
  SynthesizedVoiceMessage,
  VoiceSynthesizer,
} from "./fish-audio.ts";

export class FallbackVoice implements VoiceSynthesizer {
  constructor(
    private readonly options: {
      primary: VoiceSynthesizer;
      fallback: VoiceSynthesizer;
      primaryName: string;
      fallbackName: string;
      logger: Logger;
    },
  ) {}

  get enabled(): boolean {
    return this.options.primary.enabled || this.options.fallback.enabled;
  }

  async synthesize(text: string): Promise<SynthesizedVoiceMessage> {
    let primaryError: unknown;
    if (this.options.primary.enabled) {
      try {
        return await this.options.primary.synthesize(text);
      } catch (error) {
        primaryError = error;
        this.options.logger.warn(
          {
            provider: this.options.primaryName,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : "unknown voice error",
          },
          "primary voice synthesis failed; trying fallback",
        );
      }
    }

    if (this.options.fallback.enabled) {
      const result = await this.options.fallback.synthesize(text);
      this.options.logger.info(
        { provider: this.options.fallbackName },
        "voice fallback succeeded",
      );
      return result;
    }

    if (primaryError) throw primaryError;
    throw new Error("No voice provider is configured");
  }
}
