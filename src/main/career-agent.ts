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
const sensitiveField = /\b(?:password|passcode|otp|verification|social security|ssn|government id|date of birth|dob|race|ethnicity|gender|sex|disability|veteran|military|religion|sexual orientation|citizen|citizenship|work authori[sz]ation|visa|sponsor|sponsorship|salary|compensation|desired pay|eeo|equal employment|self.identif|signature|attest|agree|consent)\b/i;

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
  if (next.fullName && (!next.firstName || !next.lastName)) {
    const parts = next.fullName.split(/\s+/).filter(Boolean);
    if (!next.firstName) next.firstName = parts[0];
    if (!next.lastName && parts.length > 1) next.lastName = parts.at(-1);
  }
  await writeFile(profileFile(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return next;
}

function profileFromInstruction(instruction: string): CareerProfile {
  const update: CareerProfile = {};
  const value = instruction.trim();
  const email = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = value.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/)?.[0];
  const linkedin = value.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_%.-]+\/?/i)?.[0];
  const github = value.match(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/?/i)?.[0];
  const website = value.match(/https?:\/\/(?!www\.)?(?!linkedin\.com|github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s,]*)?/i)?.[0];
  const named = value.match(/\b(?:full\s+name|name)\s*(?:is|:|=)\s*([^,;\n]+?)(?=\s+(?:email|phone|location|linkedin|github|website|portfolio|current\s+title|current\s+company)\b|[,;\n]|$)/i)?.[1]?.trim();
  const location = value.match(/\b(?:location|city)\s*(?:is|:|=)\s*([^,;\n]+?)(?=\s+(?:linkedin|github|website|portfolio|current\s+title|current\s+company|email|phone)\b|[,;\n]|$)/i)?.[1]?.trim();
  const currentTitle = value.match(/\bcurrent\s+title\s*(?:is|:|=)\s*([^,;\n]+)/i)?.[1]?.trim();
  const currentCompany = value.match(/\bcurrent\s+company\s*(?:is|:|=)\s*([^,;\n]+)/i)?.[1]?.trim();
  const portfolio = value.match(/\bportfolio\s*(?:is|:|=)\s*(https?:\/\/[^\s,;]+)/i)?.[1]?.trim();
  if (named) update.fullName = named;
  if (email) update.email = email;
  if (phone) update.phone = phone;
  if (location) update.location = location;
  if (linkedin) update.linkedin = linkedin;
  if (github) update.github = github;
  if (website) update.website = website;
  if (portfolio) update.portfolio = portfolio;
  if (currentTitle) update.currentTitle = currentTitle;
  if (currentCompany) update.currentCompany = currentCompany;
  return update;
}

export async function updateCareerProfileFromInstruction(instruction: string) {
  const update = profileFromInstruction(instruction);
  if (!Object.keys(update).length) {
    return { profile: await careerProfile(), summary: "I did not find a reusable profile field in that request. You can give me name, email, phone, location, LinkedIn, GitHub, portfolio, current title, or current company." };
  }
  const profile = await saveCareerProfile(update);
  return { profile, summary: `Saved ${Object.keys(update).join(", ")} to your local Orbit Career profile. Legal, demographic, compensation, visa, and EEO answers are intentionally not stored by this shortcut.` };
}

function pageSource(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("linkedin")) return "LinkedIn";
    if (host.includes("jobright")) return "Jobright";
    if (host.includes("greenhouse")) return "Greenhouse";
    if (host.includes("lever")) return "Lever";
    if (host.includes("workday")) return "Workday";
    return host || "web";
  } catch { return "web"; }
}

function summarizeJob(snapshot: Awaited<ReturnType<typeof browser.actionSnapshot>>) {
  const text = snapshot.text;
  const titleFromPage = snapshot.title.split(/\s+[|·–—-]\s+/)[0]?.trim() || snapshot.title;
  const h1ish = text.split(/\n+/).map(item => item.trim()).find(item => item.length > 3 && item.length < 100) || titleFromPage;
  const company = snapshot.title.split(/\s+[|·–—-]\s+/)[1]?.replace(/linkedin|jobs?|careers?/ig, "").trim() || "";
  const location = text.match(/\b(?:Remote|Hybrid|On-site|Onsite)\b(?:\s*[·|,-]\s*[^\n]{2,60})?|\b[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b/)?.[0] || "";
  const salary = text.match(/\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s*(?:-|–|to)\s*\$?\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?(?:\s*\/?\s*(?:yr|year|hour|hr))?/i)?.[0] || "";
  const applyControls = snapshot.controls.filter(control => /\b(?:apply|easy apply|submit application|continue application)\b/i.test(control.label));
  const isJobPage = /\b(?:job description|qualifications|responsibilities|requirements|about the role|about this job|apply|easy apply)\b/i.test(text) || /\b(?:jobs?|careers?|positions?|openings?)\b/i.test(snapshot.url);
  return { url: snapshot.url, title: h1ish.slice(0, 160), company: company.slice(0, 120), location: location.slice(0, 120), salary: salary.slice(0, 120), source: pageSource(snapshot.url), hasApplyControl: applyControls.length > 0, isJobPage, text: text.slice(0, 9000) };
}

export async function inspectCurrentJob() {
  const page = summarizeJob(await browser.actionSnapshot());
  const summary = page.isJobPage
    ? `${page.title || "Job"}${page.company ? ` at ${page.company}` : ""}${page.location ? ` · ${page.location}` : ""}${page.salary ? ` · ${page.salary}` : ""}. Source: ${page.source}. ${page.hasApplyControl ? "An application control is visible." : "No application control is currently visible."}`
    : `This does not look like a job posting yet. Current page: ${page.title || page.url}.`;
  return { ...page, summary };
}

export async function inspectCurrentApplication() {
  const snapshot = await browser.actionSnapshot();
  const fields = snapshot.controls.filter(control => /^(?:text|email|tel|url|number|input|textarea|select|file|checkbox|radio)$/i.test(control.kind));
  const sensitive = fields.filter(field => sensitiveField.test(field.label));
  const fileInputs = fields.filter(field => field.kind.toLowerCase() === "file" || /\b(?:resume|cv|cover letter|upload)\b/i.test(field.label));
  const safe = fields.filter(field => !sensitive.includes(field) && !fileInputs.includes(field));
  return {
    url: snapshot.url,
    fields,
    sensitive,
    fileInputs,
    safe,
    summary: `Orbit can see ${fields.length} application field/control(s): ${safe.length} appear safe for profile autofill, ${sensitive.length} require your review, and ${fileInputs.length} look like resume/file uploads. Orbit will not guess legal, demographic, compensation, identity, authentication, visa, sponsorship, or EEO answers and will not submit automatically.`,
  };
}

const aliases: Array<[keyof CareerProfile, string[]]> = [
  ["firstName", ["first name", "given name"]],
  ["lastName", ["last name", "family name", "surname"]],
  ["fullName", ["full name", "name"]],
  ["email", ["email", "email address"]],
  ["phone", ["phone", "phone number", "mobile", "mobile phone"]],
  ["location", ["location", "city", "current location", "address city"]],
  ["linkedin", ["linkedin", "linkedin url", "linkedin profile"]],
  ["github", ["github", "github url", "github profile"]],
  ["portfolio", ["portfolio", "portfolio url"]],
  ["website", ["website", "personal website", "website url"]],
  ["currentCompany", ["current company", "company"]],
  ["currentTitle", ["current title", "job title", "current position"]],
];

export async function autofillCurrentApplication() {
  const profile = await careerProfile();
  if (!Object.keys(profile).length) return { filled: [], needsReview: [], summary: "Your Orbit Career profile is empty. Say something like “Career profile: name …, email …, phone …, location …, LinkedIn …, GitHub …” first." };
  const snapshot = await browser.actionSnapshot();
  const available = snapshot.controls.map(control => ({ ...control, lower: control.label.toLowerCase() }));
  const filled: string[] = [];
  for (const [key, names] of aliases) {
    const value = profile[key];
    if (!value) continue;
    const match = available.find(control => !sensitiveField.test(control.label) && names.some(name => control.lower === name || control.lower.includes(name)));
    if (!match || ["file", "password", "checkbox", "radio"].includes(match.kind.toLowerCase())) continue;
    try {
      if (match.kind.toLowerCase() === "select") await browser.selectByLabel(match.label, value);
      else await browser.fillByLabel(match.label, value);
      filled.push(match.label);
    } catch {}
  }
  const application = await inspectCurrentApplication();
  const needsReview = application.sensitive.map(item => item.label);
  return {
    filled,
    needsReview,
    fileInputs: application.fileInputs.map(item => item.label),
    summary: filled.length
      ? `Filled ${filled.length} reusable non-sensitive field(s): ${filled.join(", ")}. ${needsReview.length ? `${needsReview.length} sensitive/review field(s) were left untouched. ` : ""}${application.fileInputs.length ? "Resume/file upload still requires file selection. " : ""}Orbit did not submit anything.`
      : `No safe form fields matched your saved Career profile. ${needsReview.length ? `${needsReview.length} sensitive/review field(s) were intentionally left untouched.` : ""}`,
  };
}

async function applicationRecords(): Promise<CareerApplicationRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(applicationsFile(), "utf8")) as CareerApplicationRecord[];
    return Array.isArray(parsed) ? parsed.slice(-1000) : [];
  } catch { return []; }
}

export async function trackCurrentApplication(status: CareerApplicationStatus = "saved") {
  const page = summarizeJob(await browser.actionSnapshot());
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
  const page = summarizeJob(await browser.actionSnapshot());
  const profile = await careerProfile();
  const context = [page.title && `Role: ${page.title}`, page.company && `Company: ${page.company}`, page.location && `Location: ${page.location}`, profile.currentTitle && `Candidate current title: ${profile.currentTitle}`, profile.github && `Candidate GitHub: ${profile.github}`, profile.linkedin && `Candidate LinkedIn: ${profile.linkedin}`].filter(Boolean).join("\n");
  const prompt = `Draft a concise, natural recruiter or hiring-manager outreach message for the current job page. Do not invent experience, referrals, relationships, or achievements. Keep it under 500 characters unless the user explicitly requests email length. ${instruction ? `User instruction: ${instruction}` : ""}\n${context}\nReturn only the message text.`;
  let text = "";
  if (geminiStatus().available) text = await answerWithGemini({ query: prompt, history: [] });
  else if ((await ollamaStatus()).available) text = await answerWithOllama({ query: prompt, sources: [], history: [] });
  else throw new Error("Connect Gemini or start local Ollama to draft personalized outreach");
  text = text.replace(/^```\w*\s*|\s*```$/g, "").trim().slice(0, 1500);
  return { text, summary: `Recruiter outreach draft ready for ${page.company || page.title || "this opportunity"}. It has not been sent.` };
}

export async function handleCareerCommand(instruction: string) {
  const command = instruction.trim();
  if (/\b(?:career|application)\s+profile\b/i.test(command) && /\b(?:save|set|update|remember|my|name|email|phone|linkedin|github|location|portfolio)\b/i.test(command)) return updateCareerProfileFromInstruction(command);
  if (/\b(?:show|what(?:'s| is)|view)\b.*\b(?:career|application)\s+profile\b/i.test(command)) {
    const profile = await careerProfile();
    const visible = Object.entries(profile).map(([key, value]) => `${key}: ${value}`).join(" · ");
    return { profile, summary: visible ? `Orbit Career profile: ${visible}` : "Your Orbit Career profile is empty." };
  }
  if (/\b(?:inspect|review|analy[sz]e|read)\b.*\b(?:application|form)\b/i.test(command)) return inspectCurrentApplication();
  if (/\b(?:inspect|review|analy[sz]e|read|summari[sz]e)\b.*\b(?:job|role|posting|description)\b/i.test(command)) return inspectCurrentJob();
  if (/\b(?:autofill|auto-fill|fill)\b.*\b(?:application|form)\b/i.test(command)) return autofillCurrentApplication();
  if (/\b(?:draft|write|create)\b.*\b(?:recruiter|hiring manager|outreach|connection note|linkedin message)\b/i.test(command)) {
    const result = await draftRecruiterOutreach(command);
    return { ...result, summary: `${result.summary}\n\n${result.text}` };
  }
  if (/\b(?:show|list)\b.*\b(?:applications?|job tracker|career tracker)\b/i.test(command)) return listCareerApplications();
  if (/\b(?:mark|track|save)\b.*\b(?:applied|application|job)\b/i.test(command)) {
    const status: CareerApplicationStatus = /\boffer\b/i.test(command) ? "offer" : /\brejected\b/i.test(command) ? "rejected" : /\binterview\b/i.test(command) ? "interview" : /\bapplied\b/i.test(command) ? "applied" : /\bready\b/i.test(command) ? "ready_to_submit" : /\bprepar/i.test(command) ? "preparing" : "saved";
    return trackCurrentApplication(status);
  }
  return { summary: "Career Mode is ready. I can inspect this job, inspect the application form, autofill reusable non-sensitive fields, draft recruiter outreach, save your Career profile, and track the application. Final submit/send/publish actions remain approval-gated." };
}
