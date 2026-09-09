import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseGeneratedEmail, emailVerificationScript } from '../src/main/email-drafting.ts';
import { emailFailureReason } from '../src/main/email-drafting.ts';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// Load the real provider functions without starting Electron or making network calls.
const moduleUrl = async (name, replacements = {}) => {
  const source = await readFile(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8');
  let code = stripTypeScriptTypes(source);
  for (const [specifier, url] of Object.entries(replacements)) code = code.replaceAll(`"${specifier}"`, JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
};
const draftingUrl = await moduleUrl('email-drafting');
const ollamaUrl = await moduleUrl('ollama', {'./email-drafting.js':draftingUrl});
const {emailWithOllama} = await import(ollamaUrl);
const {emailWithGemini} = await import(await moduleUrl('gemini', {'./email-drafting.js':draftingUrl,'./ollama.js':ollamaUrl,electron:'data:text/javascript,export const app = {}'}));

test('Gemini email uses structured generation without the conversational wrapper', async()=>{
  const result = await emailWithGemini('Write the requested email', async(parts,config)=>{
    assert.deepEqual(parts,[{text:'Write the requested email'}]);
    assert.equal(config.responseMimeType,'application/json');
    assert.deepEqual(config.responseJsonSchema.required,['subject','body']);
    return {candidates:[{content:{parts:[{text:'{"subject":"Meeting","body":"Hi Sai, would Friday work?"}'}]}}]};
  });
  assert.equal(result.subject,'Meeting');
  await assert.rejects(emailWithGemini('Draft',async()=>({candidates:[]})),/JSON/);
});

test('Ollama email enforces schema and reports HTTP and truncated output failures', async()=>{
  const draft = {subject:'Meeting',body:'Hi Sai, would Friday work?'};
  assert.deepEqual(await emailWithOllama('Draft',async(url,options)=>{
    const request=JSON.parse(options.body);
    assert.deepEqual(request.format.required,['subject','body']);
    assert.equal(request.messages.length,2);
    assert.equal(request.think,false);
    return Response.json({message:{content:JSON.stringify(draft)}});
  }),draft);
  await assert.rejects(emailWithOllama('Draft',async()=>new Response('',{status:429})),/429/);
  await assert.rejects(emailWithOllama('Draft',async()=>Response.json({done_reason:'length',message:{content:'{}'}})),/truncated/);
});

test('email diagnostics explain failures without exposing provider payloads',()=>{
  assert.match(emailFailureReason(new Error('429 private payload')),/quota/);
  assert.match(emailFailureReason(new Error('403 api key secret-value')),/authentication/);
  assert.match(emailFailureReason(new Error('request timed out')),/timed out/);
  assert.match(emailFailureReason(new Error('invalid JSON containing private email')),/invalid/);
  assert.doesNotMatch(emailFailureReason(new Error('secret-value')),/secret-value/);
});

test('generated email requires complete structured content', () => {
  assert.deepEqual(parseGeneratedEmail('```json\n{"subject":"Meeting time","body":"Hi Sai,\\nWould Friday work?"}\n```'), {subject:'Meeting time',body:'Hi Sai,\nWould Friday work?'});
  for(const output of ['plain text', '{}', '{"subject":"Hello","body":""}', '{"subject":"Hello","body":"Open it in Gmail, but do not send it."}']) assert.throws(()=>parseGeneratedEmail(output));
});

const element = (properties={}) => ({getBoundingClientRect:()=>({width:100,height:30}),...properties});
const compose = (recipient, subject, body) => element({querySelectorAll: selector => selector.startsWith('input') ? [element({value:subject})] : selector.startsWith('[contenteditable') ? [element({innerText:body})] : [element({getAttribute:()=>recipient})]});
const script = emailVerificationScript('gmail','sai@example.com','Meeting','Hi Sai,\nWould Friday work?');
const verify = (roots,hostname='mail.google.com') => runInNewContext(script,{location:{hostname},document:{querySelectorAll:()=>roots}});

test('verification requires exact recipient, subject and full body in one compose window',()=>{
  assert.equal(verify([compose('sai@example.com','Meeting','Hi Sai,\nWould Friday work?')]),'VERIFIED');
  assert.equal(verify([compose('wrong@example.com','Meeting','Hi Sai,\nWould Friday work?')]),'UNVERIFIED');
  assert.equal(verify([compose('sai@example.com','Meeting','Hi Sai,')]),'UNVERIFIED');
  assert.equal(verify([compose('sai@example.com','Wrong','Hi Sai,\nWould Friday work?'),compose('wrong@example.com','Meeting','Hi Sai,\nWould Friday work?')]),'UNVERIFIED');
  assert.equal(verify([compose('sai@example.com','Meeting','Hi Sai,\nWould Friday work?')],'example.com'),'UNVERIFIED');
  assert.equal(verify([]),'UNVERIFIED');
});
