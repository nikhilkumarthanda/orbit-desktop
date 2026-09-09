import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseGeneratedEmail, emailVerificationScript } from '../src/main/email-drafting.ts';

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
