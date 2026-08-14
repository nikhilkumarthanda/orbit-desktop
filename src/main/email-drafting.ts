export interface EmailWritingPreferences { tone: string; length: string; greeting: string; signature: string; natural: boolean }

export function emailRequestDetails(instruction: string) {
  return instruction
    .replace(/^.*?\b(?:draft|write|compose)\s+(?:an?\s+)?(?:email|e-mail)(?:\s+(?:to|for)\s+.+?)?\s+(?:saying|telling|about|regarding)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

export function inferEmailSubject(instruction: string) {
  const details = emailRequestDetails(instruction);
  if (!details) return "Email Draft";
  const meaningful = details
    .replace(/\b(?:please|just|saying|telling|that|the|a|an|has to|have to|needs? to|should|i want to|i wanted to)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  return meaningful.replace(/^./, letter => letter.toUpperCase()).slice(0, 90) || "Email Draft";
}

export function fallbackEmailBody(displayName: string, instruction: string, preferences: Pick<EmailWritingPreferences, "length"|"greeting"|"signature">) {
  const firstName = displayName.trim().split(/\s+/)[0] || "there";
  const details = emailRequestDetails(instruction);
  const message = (details || instruction).replace(/^./, letter => letter.toUpperCase()).replace(/[.!?]*$/, ".");
  const lead = preferences.length === "concise" ? "" : "I wanted to reach out and let you know that ";
  const sentence = lead ? `${lead}${message.charAt(0).toLowerCase()}${message.slice(1)}` : message;
  return `${preferences.greeting || "Hi"} ${firstName},\n\n${sentence}\n\nBest,\n${preferences.signature || "Nikhil"}`;
}
