export interface EmailWritingPreferences { tone: string; length: string; greeting: string; signature: string; natural: boolean }

export const EMAIL_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

// Classify failures without displaying provider payloads, credentials, or email content.
export function emailFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/429|quota|rate.limit|resource.exhausted/i.test(message)) return "request quota reached; check your provider usage";
  if (/401|403|api.key|unauth|permission.denied/i.test(message)) return "authentication failed; check the API key in Settings";
  if (/timeout|timed.out|abort/i.test(message)) return "request timed out; retry when the model is ready";
  if (/fetch|network|ECONN|connect/i.test(message)) return "connection failed; check that the provider is reachable";
  if (/JSON|incomplete email|drafting instructions|empty|no answer|truncated/i.test(message)) return "model returned an invalid or incomplete draft";
  return "provider could not generate a draft; check its status in Settings";
}

export function emailVerificationScript(provider: "gmail" | "outlook", recipient: string, subject: string, body: string) {
  return `(()=>{
    if(location.hostname!==${JSON.stringify(provider === "gmail" ? "mail.google.com" : "outlook.office.com")})return 'UNVERIFIED';
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
    const normalize=v=>String(v||'').replace(/\\r\\n/g,'\\n').trim();
    const roots=[...document.querySelectorAll('[role="dialog"],form')].filter(visible);
    const expected=${JSON.stringify({ recipient, subject, body })};
    return roots.some(root=>{
      const subjects=[...root.querySelectorAll('input[name="subjectbox"],input[aria-label="Subject"],input[placeholder="Add a subject"]')].filter(visible);
      const bodies=[...root.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"][aria-label*="Message body"],textarea[name="body"]')].filter(visible);
      const recipients=[...root.querySelectorAll('[email],[data-email-address]')].filter(visible);
      return subjects.some(e=>normalize(e.value)===normalize(expected.subject))&&bodies.some(e=>normalize(e.value||e.innerText)===normalize(expected.body))&&recipients.some(e=>String(e.getAttribute('email')||e.getAttribute('data-email-address')||'').toLowerCase()===expected.recipient.toLowerCase());
    })?'VERIFIED':'UNVERIFIED';
  })()`;
}

export function parseGeneratedEmail(output: string): { subject: string; body: string } {
  const text = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("The writing model returned invalid JSON."); }
  if (!value || typeof value.subject !== "string" || typeof value.body !== "string" ||
      !value.subject.trim() || !value.body.trim() || value.subject.length > 200 || value.body.length > 5000 ||
      /[\r\n]/.test(value.subject)) throw new Error("The writing model returned an incomplete email. Please retry.");
  if (/\b(?:keep it (?:short|professional|friendly)|open (?:it )?in gmail|do not send it)\b/i.test(value.subject + "\n" + value.body)) {
    throw new Error("The writing model copied drafting instructions into the email. Please retry.");
  }
  return { subject: value.subject.trim(), body: value.body.trim() };
}

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
