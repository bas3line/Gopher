export const DISCORD_OPUS_SAMPLE_RATE = 48_000;
export const DISCORD_OPUS_CHANNELS = 2;
export const PCM_16_BIT_BYTES_PER_SAMPLE = 2;
export const PCM_BLOCK_ALIGN =
  DISCORD_OPUS_CHANNELS * PCM_16_BIT_BYTES_PER_SAMPLE;
export const PCM_BYTES_PER_SECOND =
  DISCORD_OPUS_SAMPLE_RATE * PCM_BLOCK_ALIGN;

export function maxPcmBytesForSeconds(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError("seconds must be a positive integer");
  }
  return seconds * PCM_BYTES_PER_SECOND;
}

export function pcmDurationSeconds(pcm: Buffer): number {
  if (pcm.length % PCM_BLOCK_ALIGN !== 0) {
    throw new RangeError("PCM must contain complete interleaved samples");
  }
  return pcm.length / PCM_BYTES_PER_SECOND;
}

/** Wraps Discord's decoded 48 kHz, stereo, signed-16-bit PCM in a WAV container. */
export function pcmToWav(pcm: Buffer): Buffer {
  if (pcm.length === 0) {
    throw new RangeError("PCM audio must not be empty");
  }
  if (pcm.length % PCM_BLOCK_ALIGN !== 0) {
    throw new RangeError("PCM must contain complete interleaved samples");
  }
  if (pcm.length > 0xffff_ffff - 36) {
    throw new RangeError("PCM audio is too large for a WAV container");
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(DISCORD_OPUS_CHANNELS, 22);
  header.writeUInt32LE(DISCORD_OPUS_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(PCM_BLOCK_ALIGN, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm], header.length + pcm.length);
}

export function isPcmWav(audio: Buffer): boolean {
  return (
    audio.length >= 44 &&
    audio.subarray(0, 4).toString("ascii") === "RIFF" &&
    audio.subarray(8, 12).toString("ascii") === "WAVE" &&
    audio.subarray(12, 16).toString("ascii") === "fmt " &&
    audio.readUInt16LE(20) === 1 &&
    audio.readUInt16LE(22) === DISCORD_OPUS_CHANNELS &&
    audio.readUInt32LE(24) === DISCORD_OPUS_SAMPLE_RATE &&
    audio.readUInt16LE(34) === 16 &&
    audio.subarray(36, 40).toString("ascii") === "data"
  );
}
