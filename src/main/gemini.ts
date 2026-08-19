import { spawnSync } from "node:child_process";
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserTaskAction, ConversationTurn, ResearchSource } from "../shared/contracts.js";
import { finalAnswerOnly } from "./ollama.js";

const KEYCHAIN_SERVICE = "com.orbit.desktop.gemini";
// Prefer the