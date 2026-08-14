import test from "node:test";
import assert from "node:assert/strict";
import { fallbackEmailBody, inferEmailSubject } from "../src/main/email-drafting.ts";
import { rankRecipients } from "../src/main/recipients.ts";
import { destinationAdapter } from "../src/main/destination-adapters.ts";

const preferences = { tone: "professional", length: "concise", greeting: "Hi", signature: "Nikhil", natural: true };

test("email acceptance: arbitrary requests preserve their dictated purpose", () => {
  const cases = [
    ["Draft an email to Aishwarya Sai saying the Task Manager meeting has to reschedule", "Task Manager meeting has to reschedule"],
    ["Write an email for Anirudh about sending the report tomorrow", "sending the report tomorrow"],
    ["Compose an email to Michael telling him my EAD arrived", "my EAD arrived"],
    ["Draft an email to Claudia regarding my enterprise data experience", "my enterprise data experience"],
    ["Write an email for the team saying Friday works for me", "Friday works for me"],
  ];
  for (const [instruction, fact] of cases) {
    const body = fallbackEmailBody("Aishwarya Sai", instruction, preferences);
    assert.match(body, /^Hi Aishwarya,/);
    assert.ok(body.toLowerCase().includes(fact.toLowerCase()), `${fact} should remain in the draft`);
    assert.match(body, /Best,\nNikhil$/);
    assert.notEqual(inferEmailSubject(instruction), "Draft Email");
  }
});

test("recipient acceptance: exact names outrank partial and ambiguous matches remain visible", () => {
  const contacts = [
    { id: "1", name: "Aishwarya Sai", emails: ["sai@example.com"], phones: [] },
    { id: "2", name: "Aishwarya Reddy", emails: ["reddy@example.com"], phones: [] },
    { id: "3", name: "Sai Kumar", emails: ["kumar@example.com"], phones: [] },
  ];
  const exact = rankRecipients("Aishwarya Sai", contacts);
  assert.equal(exact[0].name, "Aishwarya Sai");
  assert.equal(exact[0].score, 100);
  const ambiguous = rankRecipients("Aishwarya", contacts);
  assert.deepEqual(ambiguous.slice(0, 2).map(item => item.name), ["Aishwarya Reddy", "Aishwarya Sai"]);
});

test("destination acceptance: supported compose targets are HTTPS and explicit", () => {
  for (const id of ["gmail", "outlook", "linkedin"]) {
    const adapter = destinationAdapter(id);
    assert.equal(new URL(adapter.composeUrl).protocol, "https:");
    assert.equal(adapter.id, id);
  }
});
