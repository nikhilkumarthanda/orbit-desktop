import { spawnSync } from "node:child_process";

export interface ResolvedRecipient { id: string; name: string; emails: string[]; phones: string[] }
const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function rankRecipients(query: string, contacts: ResolvedRecipient[]) {
  const wanted = normalize(query); const words = wanted.split(" ").filter(Boolean);
  return contacts.map(contact => { const name = normalize(contact.name);
    let score = name === wanted ? 100 : name.startsWith(wanted) ? 92 : name.includes(wanted) ? 84 : 0;
    if (!score && words.length) score = Math.round(words.filter(word => name.includes(word)).length / words.length * 70);
    return { ...contact, score };
  }).filter(contact => contact.score >= 45).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 6);
}

export function contactsForName(query: string) {
  if (process.platform !== "darwin" || !query.trim()) return [];
  const script = `function run(argv) { const q=String(argv[0]||'').toLowerCase(), app=Application('Contacts'), out=[];
    for (const person of app.people()) { const name=String(person.name()||''); if(!name.toLowerCase().includes(q)&&!q.split(/\\s+/).every(w=>name.toLowerCase().includes(w))) continue;
      const read=xs=>{try{return xs().map(x=>String(x.value())).filter(Boolean)}catch(_){return[]}}; out.push({id:String(person.id()),name,emails:read(person.emails),phones:read(person.phones)}); if(out.length>=20)break; } return JSON.stringify(out); }`;
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, query], { encoding: "utf8", timeout: 8_000 });
  if (result.status !== 0) return [];
  try { return rankRecipients(query, JSON.parse(result.stdout || "[]") as ResolvedRecipient[]); } catch { return []; }
}
