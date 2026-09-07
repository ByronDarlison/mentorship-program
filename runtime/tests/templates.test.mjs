import test from 'node:test';
import assert from 'node:assert/strict';
import {messageRenderer} from '../templates.mjs';
import content from '../../website/dist/check-in-config.json' with {type:'json'};
const render=messageRenderer('https://review.example');
test('forms and messages use the same canonical questions and templates',()=>{
  for(const role of ['mentee','mentor'])for(const period of [3,6,9,12,0]){
    const kind=[0,12].includes(period)?'final':'quarterly';
    const message=render({id:'fictional',role,period,kind},'initial','test-token');
    for(const question of content.questions[kind==='final'?role:'quarterly'])assert.equal(message.body.includes(question),true);
    assert.doesNotMatch(message.body,/\[link\]|\[three|If the relationship ends early/);
    if(period===0){assert.match(message.body,/As your mentorship relationship comes to an end/);assert.doesNotMatch(message.body,/Your twelve-month mentorship cycle is complete/);}
    assert.equal(message.link,'https://review.example/check-in#test-token');
  }
});
test('first-meeting reminders use the actual canonical confirmation and contain no invented date proof',()=>{
  const message=render({id:'fictional',kind:'first'},'reminder-7',null);
  assert.equal(message.body,'Did your first mentoring meeting take place as planned? If it was rescheduled, please let us know the new date.');
});
test('reminders retain the same link, fail without one and allow no unapproved template',()=>{
  const request={id:'fictional',role:'mentor',kind:'quarterly',period:3};
  for(const day of [7,14])assert.match(render(request,'reminder-'+day,null,{link:'https://review.example/check-in#same'}).body,/#same/);
  assert.throws(()=>render(request,'reminder-7',null));assert.throws(()=>render(request,'reminder-4','token'));
});
