import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as browser from "./embedded-browser.js";
import { answerWithGemini, geminiStatus } from "./gemini.js";
import { answerWithOllama, ollamaStatus } from "./ollama.js";

export type CareerProfile = {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  portfolio?: string;
  currentCompany?: string;
  currentTitle?: string;
};

export type CareerApplicationStatus = "saved" | "preparing" | "ready_to_submit" | "applied" | "interview" | "rejected" | "offer";

export interface CareerApplicationRecord {
  id: string;
  url: string;
  title: string;
  company: string;
  source: string;
  status: CareerApplicationStatus;
  updatedAt: string;
}

const safeProfileKeys = new Set<keyof CareerProfile>([
  "fullName", "firstName", "lastName", "email", "phone", "location", "linkedin", "github", "website", "portfolio", "currentCompany", "currentTitle",
]);

function careerDir() { return path.join(app.getPath("userData"), "career"); }
function profileFile() { return path.join(careerDir(), "profile.json"); }
function applicationsFile() { return path.join(careerDir(), "applications.json"); }

async function ensureCareerDir() { await mkdir(careerDir(), { recursive: true, mode: 0o700 }); }

export async function careerProfile(): Promise<CareerProfile> {
  try {
    const parsed = JSON.parse(await readFile(profileFile(), "utf8")) as CareerProfile;
    const clean: CareerProfile = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (safeProfileKeys.has(key as keyof CareerProfile) && typeof value === "string" && value.trim()) (clean as Record<string, string>)[key] = value.trim().slice(0, 500);
    }
    return clean;
  } catch { return {}; }
}

export async function saveCareerProfile(update: CareerProfile) {
  await ensureCareerDir();
  const current = await careerProfile();
  const next: CareerProfile = { ...current };
  for (const [key, value] of Object.entries(update || {})) {
    if (!safeProfileKeys.has(key as keyof CareerProfile)) continue;
    const clean = String(value || "").trim().slice(0, 500);
    if (clean) (next as Record<string, string>)[key] = clean;
  }
  await writeFile(profileFile(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return next;
}

export async function inspectCurrentJob() {
  const page = await browser.careerPageSnapshot();
  const summary = page.isJobPage
    ? `${page.title || "Job"}${page.company ? ` at ${page.company}` : ""}${page.location ? ` · ${page.location}` : ""}${page.salary ? ` · ${page.salary}` : ""}. Source: ${page.source}. ${page.hasApplyControl ? "An application control is visible." : "No application control is currently visible."}`
    : `This does not look like a job posting yet. Current page: ${page.title || page.url}.`;
  return { ...page, summary };
}

export async function inspectCurrentApplication() {
  const form = await browser.applicationFormSnapshot();
  const safeBlank = form.fields.filter(field => !field.sensitive && !field.value && !["file", "password", "hidden", "checkbox", "radio"].includes(field.type));
  const sensitive = form.fields.filter(field => field.sensitive);
  const files = form.fields.filter(field => field.type === "file");
  const summary = `Orbit found ${form.fields.length} application field(s): ${safeBlank.length} safe blank field(s), ${sensitive.length} sensitive/review field(s), and ${files.length} file upload field(s). Orbit will not guess legal, demographic, compensation, identity, authentication, or EEO answers, and will not submit the form automatically.`;
  return { ...form, summary };
}

export async function learnProfileFromCurrentForm() {
  const learned = await browser.captureSafeCareerProfileFields();
  const profile = await saveCareerProfile(learned.profile);
  const keys = Object.keys(learned.profile);
  return {
    profile,
    learned: keys,
    skipped: learned.skipped,
    summary: keys.length
      ? `Saved ${keys.length} reusable non-sensitive application field(s) locally: ${keys.join(", ")}. Sensitive/legal answers were not learned.`
      : "I did not find reusable non-sensitive profile values on this form. Fill your contact/profile fields first, then ask Orbit to learn them.",
  };
}

export async function autofillCurrentApplication() {
  const profile = await careerProfile();
  if (!Object.keys(profile).length) {
    return { filled: [], skipped: [], needsReview: [], summary: "Your Orbit Career profile is empty. Fill your basic contact/profile fields once, then say “learn my application profile from this form.”" };
  }
  const result = await browser.autofillSafeCareerFields(profile as Record<string, string>);
  const summary = result.filled.length
    ? `Filled ${result.filled.length} non-sensitive application field(s). ${result.needsReview.length ? `${result.needsReview.length} field(s) still need your review. ` : ""}${result.fileInputs.length ? `${result.fileInputs.length} resume/file upload field(s) require file selection. ` : ""}Orbit did not submit anything.`
    : `No safe blank fields matched your saved Career profile. ${result.needsReview.length ? `${result.needsReview.length} field(s) need your review.` : ""}`;
  return { ...result, summary };
}

async function applicationRecords(): Promise<CareerApplicationRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(applicationsFile(), "utf8")) as CareerApplicationRecord[];
    return Array.isArray(parsed) ? parsed.slice(-1000) : [];
  } catch { return []; }
}

export async function trackCurrentApplication(status: CareerApplicationStatus = "saved") {
  const page = await browser.careerPageSnapshot();
  if (!page.url.startsWith("http")) throw new Error("Open the job or application page in Orbit Browser first");
  await ensureCareerDir();
  const records = await applicationRecords();
  const existing = records.find(item => item.url === page.url);
  const record: CareerApplicationRecord = {
    id: existing?.id || crypto.randomUUID(),
    url: page.url,
    title: page.title || existing?.title || "Job application",
    company: page.company || existing?.company || "",
    source: page.source,
    status,
    updatedAt: new Date().toISOString(),
  };
  const next = [...records.filter(item => item.id !== record.id), record].slice(-1000);
  await writeFile(applicationsFile(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return { record, summary: `${record.title}${record.company ? ` at ${record.company}` : ""} is now tracked as ${status.replaceAll("_", " ")}.` };
}

export async function listCareerApplications() {
  const records = (await applicationRecords()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const counts = records.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  return { records, counts, summary: records.length ? `Tracking ${records.length} job application(s).` : "No job applications are tracked yet." };
}

export async function draftRecruiterOutreach(instruction = "") {
  const page = await browser.careerPageSnapshot();
  const profile = await careerProfile();
  const context = [
    page.title && `Role: ${page.title}`,
    page.company && `Company: ${page.company}`,
    page.location && `Location: ${page.location}`,
    profile.currentTitle && `Candidate current title: ${profile.currentTitle}`,
    profile.github && `Candidate GitHub: ${profile.github}`,
    profile.linkedin && `Candidate LinkedIn: ${profile.linkedin}`,
  ].filter(Boolean).join("\n");
  const prompt = `Draft a concise, natural recruiter or hiring-manager outreach message for the current job page. Do not invent experience, referrals, relationships, or achievements. Keep it under 500 characters unless the user explicitly requests email length. ${instruction ? `User instruction: ${instruction}` : ""}\n${context}\nReturn only the message text.`;
  let text = "";
  if (geminiStatus().available) text = await answerWithGemini({ query: prompt, history: [] });
  else if ((await ollamaStatus()).available) text = await answerWithOllama({ query: prompt, sources: [], history: [] });
  else throw new Error("Connect Gemini or start local Ollama to draft personalized outreach");
  text = text.replace(/^```\w*\s*|\s*```$/g, "").trim().slice(0, 1500);
  return { text, summary: `Recruiter outreach draft ready for ${page.company || page.title || "this opportunity"}. It has not been sent.` };
}
