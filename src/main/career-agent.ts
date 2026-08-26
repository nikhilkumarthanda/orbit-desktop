import { app } from "electron";
import { randomUUID } from "node:crypto";
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

export type CareerProfileSetupField = "fullName" | "email" | "phone" | "location" | "linkedin" | "github";
export type CareerApplicationStatus = "saved" | "preparing" | "ready_to_submit" | "applied" | "interview" | "rejected" | "offer";
export type CareerSiteAdapter = "linkedin" | "greenhouse" | "lever" | "workday" | "generic";

export interface CareerApplicationRecord {
  id: string;
  url: string;
  title: string;
  company: string;
  source: string;
  status: CareerApplicationStatus;
  updatedAt: string;
}

export interface CareerApplicationCheckpoint {
  adapter: CareerSiteAdapter;
  url: string;
  title: string;
  stepIndex: number;
  stepTotal?: number;
  nextLabel?: string;
  submitLabel?: string;
  manualLabel?: string;
  capturedAt: string;
}

let lastApplicationCheckpoint: CareerApplicationCheckpoint | null = null;

const safeProfileKeys = new Set<keyof CareerProfile>([
  "fullName", "firstName", "lastName", "email", "phone", "location", "linkedin", "github", "website", "portfolio", "currentCompany", "currentTitle",
]);
const sensitiveField = /\b(?:password|passcode|otp|verification|social security|ssn|government id|date of birth|dob|race|ethnicity|gender|sex|disability|veteran|military|religion|sexual orientation|citizen|citizenship|work authori[sz]ation|visa|sponsor|sponsorship|salary|compensation|desired pay|eeo|equal employment|self.identif|signature|attest|agree|consent)\b/i;
const careerProfileSetupOrder: CareerProfileSetupField[] = ["fullName", "email", "phone", "location", "linkedin", "github"];
const careerProfileSetupLabels: Record<CareerProfileSetupField, string> = {
  fullName: "full name",
  email: "email address",
  phone: "phone number",
  location: "location",
  linkedin: "LinkedIn profile URL",
  github: "GitHub profile URL",
};

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

export function careerProfileSetupFieldLabel(field: CareerProfileSetupField) {
  return careerProfileSetupLabels[field];
}

export function careerProfileSetupQuestion(field: CareerProfileSetupField) {
  if (field === "fullName") return "What full name should Orbit use on job applications?";
  if (field === "email") return "What email address should Orbit use on job applications?";
  if (field === "phone") return "What phone number should Orbit use on job applications?";
  if (field === "location") return "What city/state or location should Orbit use on job applications?";
  if (field === "linkedin") return "What is your LinkedIn profile URL?";
  return "What is your GitHub profile URL?";
}

export async function missingCareerProfileFields(profile?: CareerProfile) {
  const current = profile || await careerProfile();
  return careerProfileSetupOrder.filter(field => !String(current[field] || "").trim());
}

function fallbackProfileFieldValue(field: CareerProfileSetupField, answer: string) {
  let value = answer.trim().slice(0, 500);
  if (field === "fullName") value = value.replace(/^(?:my\s+)?(?:full\s+)?name\s+(?:is\s+)?/i, "").trim();
  if (field === "location") value = value.replace(/^(?:i\s+(?:live|am)\s+(?:in|at)\s+|my\s+location\s+(?:is\s+)?)/i, "").trim();
  if (field === "email") return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value) ? value : "";
  if (field === "phone") return /^(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}$/.test(value) ? value : "";
  if (field === "linkedin") return /^https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_%.-]+\/?$/i.test(value) ? value : "";
  if (field === "github") return /^https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/?$/i.test(value) ? value : "";
  return value.length >= 2 ? value : "";
}

export async function saveCareerProfileSetupAnswer(field: CareerProfileSetupField, answer: string) {
  const cleanAnswer = String(answer || "").trim().slice(0, 1_000);
  if (!cleanAnswer) return { saved: false, profile: await careerProfile(), missing: await missingCareerProfileFields(), summary: `I still need your ${careerProfileSetupFieldLabel(field)}.` };

  // Parse any explicitly labeled fields first so users can answer one question or
  // provide the entire reusable profile in a single sentence.
  const parsed = profileFromInstruction(cleanAnswer);
  if (!parsed[field]) {
    const fallback = fallbackProfileFieldValue(field, cleanAnswer);
    if (fallback) (parsed as Record<string, string>)[field] = fallback;
  }
  if (!parsed[field]) {
    return {
      saved: false,
      profile: await careerProfile(),
      missing: await missingCareerProfileFields(),
      summary: `That does not look like a complete ${careerProfileSetupFieldLabel(field)}. ${careerProfileSetupQuestion(field)}`,
    };
  }

  // Only the allowlisted reusable fields extracted above are persisted. Sensitive
  // legal/EEO/compensation/visa/authentication answers are never promoted here.
  const profile = await saveCareerProfile(parsed);
  const missing = await missingCareerProfileFields(profile);
  return {
    saved: true,
    profile,
    missing,
    savedFields: Object.keys(parsed),
    summary: missing.length
      ? `Saved ${Object.keys(parsed).join(", ")}. ${careerProfileSetupQuestion(missing[0])}`
      : "Career profile setup is complete. Resuming the task you originally asked Orbit to do.",
  };
}

export async function updateCareerProfileFromInstruction(instruction: string) {
  const update = profileFromInstruction(instruction);
  if (!Object.keys(update).length) {
    return { profile: await careerProfile(), summary: "I did not find a reusable profile field in that request. You can give me name, email, phone, location, LinkedIn, GitHub, portfolio, current title, or current company." };
  }
  const profile = await saveCareerProfile(update);
  return { profile, summary: `Saved ${Object.keys(update).join(", ")} to your local Orbit Career profile. Legal, demographic, compensation, visa, and EEO answers are intentionally not stored by this shortcut.` };
}

export function careerSiteAdapter(url: string): CareerSiteAdapter {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (host.includes("greenhouse.io")) return "greenhouse";
    if (host === "lever.co" || host.endsWith(".lever.co")) return "lever";
    if (host.includes("myworkdayjobs.com") || host.includes("workdayjobs.com")) return "workday";
  } catch {}
  return "generic";
}

function pageSource(url: string) {
  const adapter = careerSiteAdapter(url);
  if (adapter === "linkedin") return "LinkedIn";
  if (adapter === "greenhouse") return "Greenhouse";
  if (adapter === "lever") return "Lever";
  if (adapter === "workday") return "Workday";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("jobright")) return "Jobright";
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

function applicationStep(text: string) {
  const match = text.match(/\bstep\s+(\d+)\s+(?:of|\/)\s+(\d+)\b/i)
    || text.match(/\b(\d+)\s+of\s+(\d+)\s+(?:steps?|sections?)\b/i);
  if (!match) return { stepIndex: 0, stepTotal: undefined as number | undefined };
  const stepIndex = Math.max(1, Number.parseInt(match[1], 10) || 1);
  const stepTotal = Math.max(stepIndex, Number.parseInt(match[2], 10) || stepIndex);
  return { stepIndex, stepTotal };
}

function applicationControls(snapshot: Awaited<ReturnType<typeof browser.actionSnapshot>>) {
  const clickable = snapshot.controls.filter(control => /^(?:button|submit|a|link)$/i.test(control.kind));
  const submit = clickable.find(control => /^(?:submit(?: application)?|send application|finish and submit|apply now)$/i.test(control.label.trim()));
  const next = clickable.find(control => {
    const label = control.label.trim();
    return /^(?:next|continue|save and continue|continue application|review|review application)$/i.test(label)
      && !/\b(?:submit|send|agree|accept|attest|certif)/i.test(label);
  });
  const easyApply = clickable.find(control => /^(?:easy apply|apply|apply now)$/i.test(control.label.trim()) && !/submit/i.test(control.label));
  const manualText = `${snapshot.title}\n${snapshot.text}`;
  const manualLabel = /\bcaptcha\b/i.test(manualText)
    ? "CAPTCHA"
    : /\b(?:verification code|one[- ]?time code|otp|two[- ]factor|2fa|mfa)\b/i.test(manualText)
      ? "MFA or verification code"
      : /\b(?:sign in|log in|login)\b/i.test(manualText) && /\b(?:password|account)\b/i.test(manualText)
        ? "login/password"
        : "";
  return { submit, next, easyApply, manualLabel };
}

function captureApplicationCheckpoint(snapshot: Awaited<ReturnType<typeof browser.actionSnapshot>>, moved = false) {
  const adapter = careerSiteAdapter(snapshot.url);
  const parsed = applicationStep(snapshot.text);
  const controls = applicationControls(snapshot);
  const prior = lastApplicationCheckpoint;
  const sameFlow = Boolean(prior && prior.adapter === adapter);
  const inferredStep = parsed.stepIndex || (sameFlow ? Math.max(1, prior!.stepIndex + (moved ? 1 : 0)) : 1);
  const checkpoint: CareerApplicationCheckpoint = {
    adapter,
    url: snapshot.url,
    title: snapshot.title,
    stepIndex: inferredStep,
    ...(parsed.stepTotal ? { stepTotal: parsed.stepTotal } : {}),
    ...(controls.next?.label ? { nextLabel: controls.next.label } : {}),
    ...(controls.submit?.label ? { submitLabel: controls.submit.label } : {}),
    ...(controls.manualLabel ? { manualLabel: controls.manualLabel } : {}),
    capturedAt: new Date().toISOString(),
  };
  lastApplicationCheckpoint = checkpoint;
  return { checkpoint, controls };
}

export async function currentApplicationCheckpoint() {
  const snapshot = await browser.actionSnapshot();
  return captureApplicationCheckpoint(snapshot).checkpoint;
}

export async function inspectCurrentJob() {
  const snapshot = await browser.actionSnapshot();
  const page = summarizeJob(snapshot);
  const { easyApply } = applicationControls(snapshot);
  const summary = page.isJobPage
    ? `${page.title || "Job"}${page.company ? ` at ${page.company}` : ""}${page.location ? ` · ${page.location}` : ""}${page.salary ? ` · ${page.salary}` : ""}. Source: ${page.source}. ${easyApply ? `“${easyApply.label}” is available.` : page.hasApplyControl ? "An application control is visible." : "No application control is currently visible."}`
    : `This does not look like a job posting yet. Current page: ${page.title || page.url}.`;
  return { ...page, easyApply: easyApply?.label || "", summary };
}

export async function inspectCurrentApplication() {
  const snapshot = await browser.actionSnapshot();
  const { checkpoint, controls } = captureApplicationCheckpoint(snapshot);
  const adapter = checkpoint.adapter;
  const fields = snapshot.controls.filter(control => /^(?:text|email|tel|url|number|input|textarea|select|combobox|file|checkbox|radio)$/i.test(control.kind));
  const sensitive = fields.filter(field => sensitiveField.test(field.label));
  const fileInputs = fields.filter(field => field.kind.toLowerCase() === "file" || /\b(?:resume|cv|cover letter|upload)\b/i.test(field.label));
  const safe = fields.filter(field => !sensitive.includes(field) && !fileInputs.includes(field));
  const multiStep = adapter === "workday" || Boolean(checkpoint.nextLabel) || Boolean(checkpoint.stepTotal && checkpoint.stepTotal > 1);
  const stepText = checkpoint.stepTotal ? ` Step ${checkpoint.stepIndex} of ${checkpoint.stepTotal}.` : multiStep ? ` Current checkpoint: step ${checkpoint.stepIndex}.` : "";
  return {
    url: snapshot.url,
    adapter,
    fields,
    sensitive,
    fileInputs,
    safe,
    multiStep,
    easyApply: controls.easyApply?.label || "",
    checkpoint,
    summary: `${adapter === "generic" ? "Generic" : adapter[0].toUpperCase() + adapter.slice(1)} application adapter active.${stepText} Orbit can see ${fields.length} application field/control(s): ${safe.length} appear safe for profile autofill, ${sensitive.length} require your review, and ${fileInputs.length} look like resume/file uploads.${checkpoint.manualLabel ? ` Manual takeover is currently required for ${checkpoint.manualLabel}.` : ""}${checkpoint.nextLabel ? ` Safe progression control: “${checkpoint.nextLabel}”.` : ""}${checkpoint.submitLabel ? ` Final control “${checkpoint.submitLabel}” remains approval-gated.` : ""} Orbit will not guess legal, demographic, compensation, identity, authentication, visa, sponsorship, or EEO answers and will not submit automatically.`,
  };
}

export async function startCurrentApplication() {
  const before = await browser.actionSnapshot();
  const { controls } = captureApplicationCheckpoint(before);
  const label = controls.easyApply?.label || "";
  if (!label) return { started: false, summary: "Orbit does not see an Apply or Easy Apply control on the current job page." };
  await browser.clickByLabel(label);
  await new Promise(resolve => setTimeout(resolve, 650));
  const after = await browser.actionSnapshot();
  const { checkpoint } = captureApplicationCheckpoint(after, true);
  return {
    started: true,
    checkpoint,
    summary: `Opened “${label}” without submitting anything. ${checkpoint.adapter === "linkedin" ? "LinkedIn Easy Apply" : "The application flow"} is ready at checkpoint step ${checkpoint.stepIndex}.`,
  };
}

export async function attachResumeToCurrentApplication() {
  const application = await inspectCurrentApplication();
  const preferred = application.fileInputs.find(item => /\b(?:resume|curriculum vitae|\bcv\b)\b/i.test(item.label)) || application.fileInputs[0];
  if (!preferred) return { attached: false, summary: "Orbit does not see a resume/CV file input on the current application step." };
  const result = await browser.chooseAndAttachFileByLabel(preferred.label || "resume");
  if (!result.attached) return { ...result, summary: "Resume selection was cancelled. The application was not changed." };
  const checkpoint = await currentApplicationCheckpoint();
  return { ...result, checkpoint, summary: `Attached ${result.fileName} to “${preferred.label}” and verified the browser received that file. Nothing was submitted.` };
}

export async function advanceCurrentApplication() {
  const before = await browser.actionSnapshot();
  const inspected = await inspectCurrentApplication();
  const checkpoint = inspected.checkpoint;
  if (checkpoint.manualLabel) {
    return {
      advanced: false,
      requiresManualTakeover: true,
      manualLabel: checkpoint.manualLabel,
      checkpoint,
      summary: `Application checkpoint ${checkpoint.stepIndex} is waiting for ${checkpoint.manualLabel}. Complete that directly on the site, then say “continue”. Orbit will re-inspect this same application workflow.`,
    };
  }

  const unresolvedSensitive = inspected.sensitive.find(field => !String(field.value || "").trim());
  if (unresolvedSensitive) {
    return {
      advanced: false,
      requiresInput: true,
      inputLabel: unresolvedSensitive.label,
      checkpoint,
      summary: `Application checkpoint ${checkpoint.stepIndex} needs your answer for “${unresolvedSensitive.label}”. Orbit will not guess this field.`,
    };
  }

  if (checkpoint.submitLabel) {
    return {
      advanced: false,
      requiresApproval: true,
      approvalLabel: checkpoint.submitLabel,
      checkpoint,
      summary: `Application checkpoint ${checkpoint.stepIndex} is ready for the final “${checkpoint.submitLabel}” action. Orbit will not click it without exact approval.`,
    };
  }

  if (!checkpoint.nextLabel) {
    return { advanced: false, checkpoint, summary: `Orbit is at application checkpoint ${checkpoint.stepIndex}, but no safe Next/Continue control is currently visible. Review the page or fill the remaining required fields first.` };
  }

  await browser.clickByLabel(checkpoint.nextLabel);
  await new Promise(resolve => setTimeout(resolve, 700));
  const after = await browser.actionSnapshot();
  const next = captureApplicationCheckpoint(after, true).checkpoint;
  return {
    advanced: true,
    checkpoint: next,
    summary: `Completed safe application step ${checkpoint.stepIndex} with “${checkpoint.nextLabel}”. Orbit verified the updated page and saved checkpoint ${next.stepIndex}${next.stepTotal ? ` of ${next.stepTotal}` : ""}. Nothing was submitted.`,
  };
}

const aliases: Array<[keyof CareerProfile, string[]]> = [
  ["firstName", ["first name", "given name"]],
  ["lastName", ["last name", "family name", "surname"]],
  ["fullName", ["full name", "name", "legal name"]],
  ["email", ["email", "email address"]],
  ["phone", ["phone", "phone number", "mobile", "mobile phone"]],
  ["location", ["location", "city", "current location", "address city", "city/state"]],
  ["linkedin", ["linkedin", "linkedin url", "linkedin profile", "linkedin profile url"]],
  ["github", ["github", "github url", "github profile", "github profile url"]],
  ["portfolio", ["portfolio", "portfolio url"]],
  ["website", ["website", "personal website", "website url"]],
  ["currentCompany", ["current company", "company", "current employer"]],
  ["currentTitle", ["current title", "job title", "current position", "current role"]],
];

export async function autofillCurrentApplication() {
  const profile = await careerProfile();
  const missingProfileFields = await missingCareerProfileFields(profile);
  if (missingProfileFields.length) {
    const nextProfileField = missingProfileFields[0];
    return {
      filled: [],
      needsReview: [],
      requiresProfileSetup: true,
      missingProfileFields,
      nextProfileField,
      summary: `Before I autofill this application, I need to finish your reusable Career profile. ${careerProfileSetupQuestion(nextProfileField)} You can answer one field at a time or give several labeled fields in one sentence. I will resume this autofill automatically when setup is complete.`,
    };
  }
  const snapshot = await browser.actionSnapshot();
  const adapter = careerSiteAdapter(snapshot.url);
  const available = snapshot.controls.map(control => ({ ...control, lower: control.label.toLowerCase() }));
  const filled: string[] = [];
  for (const [key, names] of aliases) {
    const value = profile[key];
    if (!value) continue;
    const match = available.find(control => !sensitiveField.test(control.label) && names.some(name => control.lower === name || control.lower.includes(name) || name.includes(control.lower)));
    if (!match || ["file", "password", "checkbox", "radio"].includes(match.kind.toLowerCase())) continue;
    try {
      if (["select", "combobox"].includes(match.kind.toLowerCase())) await browser.selectByLabel(match.label, value);
      else await browser.fillByLabel(match.label, value);
      filled.push(match.label);
    } catch {}
  }
  const application = await inspectCurrentApplication();
  const needsReview = application.sensitive.map(item => item.label);
  const adapterName = adapter === "generic" ? "application" : `${adapter[0].toUpperCase() + adapter.slice(1)} application`;
  return {
    adapter,
    filled,
    needsReview,
    fileInputs: application.fileInputs.map(item => item.label),
    summary: filled.length
      ? `Filled ${filled.length} reusable non-sensitive field(s) in this ${adapterName}: ${filled.join(", ")}. ${needsReview.length ? `${needsReview.length} sensitive/review field(s) were left untouched. ` : ""}${application.fileInputs.length ? "Resume/file upload still requires file selection. " : ""}Orbit did not submit anything.`
      : `No safe form fields matched your saved Career profile in this ${adapterName}. ${needsReview.length ? `${needsReview.length} sensitive/review field(s) were intentionally left untouched.` : ""}`,
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
    id: existing?.id || randomUUID(),
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
  if (/\b(?:show|what(?:'s| is)|view)\b.*\b(?:career|application)\s+profile\b/i.test(command)) {
    const profile = await careerProfile();
    const visible = Object.entries(profile).map(([key, value]) => `${key}: ${value}`).join(" · ");
    return { profile, summary: visible ? `Orbit Career profile: ${visible}` : "Your Orbit Career profile is empty." };
  }
  if (/\b(?:career|application)\s+profile\b/i.test(command) && /\b(?:save|set|update|remember|name|email|phone|linkedin|github|location|portfolio|current\s+title|current\s+company)\b/i.test(command)) return updateCareerProfileFromInstruction(command);
  if (/\b(?:inspect|review|analy[sz]e|read)\b.*\b(?:application|form)\b/i.test(command)) return inspectCurrentApplication();
  if (/\b(?:where|what)\b.*\b(?:application|form)\b.*\b(?:step|checkpoint|am i)\b|\b(?:show|inspect)\b.*\bcheckpoint\b/i.test(command)) {
    const checkpoint = await currentApplicationCheckpoint();
    return { checkpoint, summary: `Current ${checkpoint.adapter} application checkpoint: step ${checkpoint.stepIndex}${checkpoint.stepTotal ? ` of ${checkpoint.stepTotal}` : ""} at ${checkpoint.title || checkpoint.url}.` };
  }
  if (/\b(?:inspect|review|analy[sz]e|read|summari[sz]e)\b.*\b(?:job|role|posting|description)\b/i.test(command)) return inspectCurrentJob();
  if (/\b(?:start|open|begin)\b.*\b(?:easy\s+apply|application)\b|\bapply\s+(?:to\s+)?(?:this|the)\s+(?:job|role)\b/i.test(command)) return startCurrentApplication();
  if (/\b(?:upload|attach|add)\b.*\b(?:resume|cv)\b/i.test(command)) return attachResumeToCurrentApplication();
  if (/\b(?:continue|next|advance|proceed|save\s+and\s+continue)\b.*\b(?:application|form|step)\b|^(?:continue|next)\s+(?:application|form)$/i.test(command)) return advanceCurrentApplication();
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
  return { summary: "Career Mode is ready. I can inspect this job, open Apply/Easy Apply, inspect and autofill the application, attach a resume through a native file picker, advance safe Next/Continue checkpoints, draft recruiter outreach, save your Career profile, and track the application. Final submit/send/post/publish actions remain approval-gated." };
}
