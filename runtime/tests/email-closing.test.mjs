import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {messageRenderer} from '../templates.mjs';
import {renderEmailHTML} from '../email-html.mjs';

const closing='If you have any questions, reply to this email and the Mentorship Chair will get back to you.';
const guidance='There is no need to share the details of your mentoring conversations.';
const directory=new URL('../../emails/',import.meta.url);

test('each of the 25 email examples has the closing appropriate to its action',async()=>{
  const files=(await readdir(directory)).filter(f=>f.endsWith('.html')&&f!=='index.html');
  assert.equal(files.length,25,'Review new email types before extending this coverage.');
  const contactClosing=new Set(['applications-open.html','moving-to-matching.html','mentor-invitation.html']);
  for(const file of files){
    const html=await readFile(new URL(file,directory),'utf8');
    const copy=await readFile(new URL(file.replace(/\.html$/,'.md'),directory),'utf8');
    const separator=copy.indexOf('\n\n');
    assert.equal(html,renderEmailHTML({subject:copy.slice(2,separator),body:copy.slice(separator+2).trimEnd()}),file+' must match its readable copy');
    assert.equal(html.includes(closing),contactClosing.has(file),file);
    if(file.startsWith('check-in-')||file.startsWith('final-'))assert.ok(html.includes(guidance),file);
    assert.ok(!html.includes('Please answer briefly without confidential details.'),file);
    assert.ok(!html.includes('Please keep your answers brief.'),file);
    assert.ok(!html.includes('Please keep confidential mentoring details out of your reply.'),file);
  }
});

test('month 3 exactly matches the approved conversational example',()=>{
  const message=messageRenderer('https://example.invalid')({kind:'quarterly',role:'mentee',period:3},'initial',null);
  assert.equal(message.body,'It’s been three months since your first mentoring meeting. We’d like to hear how things are going.\n\nPlease reply with your answers to these questions:\n\n1. How many times have you met since your mentorship began?\n2. What value, if any, have you received from the mentorship?\n3. Would you like the Mentorship Chair to contact you?\n\nThere is no need to share the details of your mentoring conversations.\n\nThank you for being part of the program and helping us make it better.');
});

test('all check-in and reminder variants retain questions and guidance without adding a reply closing',()=>{
  const render=messageRenderer('https://example.invalid');
  for(const role of ['mentee','mentor'])for(const period of [0,3,6,9,12])for(const phase of ['initial','reminder-7','reminder-14']){
    const kind=[0,12].includes(period)?'final':'quarterly';
    const history=[6,9,12].includes(period)?{countFrom:'2026-06-15',fromStart:false,lastReport:{date:'2026-06-15',answers:{meetings:3,value:'Fictional feedback.',contact:false}}}:undefined;
    const message=render({id:'fictional',kind,role,period,history},phase,null);
    const label=`${role}/${period}/${phase}`;
    assert.ok(!message.body.includes(closing),label);
    assert.match(message.body,/reply.*answers/i,label);
    assert.match(message.body,/1\. How many/,label);
    assert.match(message.body,/Would you like the Mentorship Chair to contact you\?/,label);
    assert.ok(!message.body.includes('Yes or no'),label);
    assert.equal(message.body.includes('What could we do to improve the program?'),kind==='final',label);
    if(period===3)assert.match(message.body,/How many times have you met since your mentorship began\?/,label);
    if(period===0)assert.match(message.body,/Enter 0 if you have not begun meeting\./,label);
    if(phase==='initial')assert.ok(message.body.includes(guidance),label);
    const expected=phase!=='initial'?'Thank you for taking a moment to share your feedback.':kind==='final'?'Thank you for the time and thought you brought to the relationship.':'Thank you for being part of the program and helping us make it better.';
    assert.ok(message.body.endsWith(expected),label);
    assert.equal((message.body.match(/Thank you/g)??[]).length,1,label);
  }
});
