// Detection of context-window overflow: the conversation (or one prompt) no longer fits the model.
// Unlike a usage limit, waiting never helps; the next attempt must start a fresh session.

const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i, // Claude: "Prompt is too long"
  /context[ _-]?(?:length|window)[ _a-z]{0,24}(?:exceed|too (?:long|large)|limit)/i, // context_length_exceeded, context length exceeded
  /exceeds? the (?:context|model'?s? context)/i, // Codex: "Your input exceeds the context window of this model"
  /ran out of room in the model'?s context window/i, // Codex
  /maximum context/i, // "maximum context length is N tokens"
  /input token count[^.]{0,60}exceeds/i, // Gemini / Antigravity
  /(?:prompt|input|request) (?:token count|tokens?)[^.]{0,60}exceeds? (?:the )?(?:limit|maximum)/i, // Copilot: "prompt token count of N exceeds the limit of M"
  /reduce the length of the (?:messages|prompt)/i,
  /too many tokens/i,
];

export function looksLikeContextOverflow(text: string): boolean {
  return OVERFLOW_PATTERNS.some((p) => p.test(text));
}

/** The plain-language error every overflow outcome carries, so a stored run can be recognised later. */
export const CONTEXT_OVERFLOW_ERROR = "The conversation no longer fits the model's context window";
