import test from 'node:test';
import assert from 'node:assert/strict';
import {messageRenderer} from '../templates.mjs';
import {historyDate} from '../check-in-history.mjs';
import content from '../../website/dist/check-in-config.json' with {type:'json'};
const render=messageRenderer('https://review.example');
const laterHistory={countFrom:'2026-06-15',fromStart:false,lastReport:{date:'2026-06-15',answers:{meetings:3,value:'Fictional feedback.'}}};
test('forms and messages use the same canonical questions and templates',()=>{
  for(const role of ['mentee','mentor'])for(const period of [3,6,9,12,0]){
    const kind=[0,12].includes(period)?'final':'quarterly';
    const history=[6,9,12].includes(period)?laterHistory:undefined;
    const message=render({id:'fictional',role,period,kind,history},'initial','test-token');
    const questions=[...content.questions[kind==='final'?role:'quarterly']];
    if(kind==='final')questions.splice(questions.length-1,0,content.copy.improvementQuestion);
    if(period===3)questions[0]=content.copy.firstMeetingQuestion;
    if(period===0)questions[0]=content.copy.earlyMeetingQuestion;
    if([6,9,12].includes(period))questions[0]=`How many times have you met since ${historyDate(history.countFrom)}?`;
    if([6,9].includes(period))questions[1]=content.copy.laterValueQuestion;
    for(const question of questions)assert.equal(message.body.includes(question),true,question);
    assert.doesNotMatch(message.body,/\[link\]|\[three|If the relationship ends early/);
    if(period===0){assert.match(message.body,/As your relationship in the \[Example Chapter Mentorship Program\]/);assert.doesNotMatch(message.body,/Your twelve months in the \[Example Chapter Mentorship Program\] are complete/);}
    assert.equal(message.link,undefined);
  }
});
test('first-meeting reminders use the actual canonical confirmation and contain no invented date proof',()=>{
  const message=render({id:'fictional',kind:'first',mentor_name:'Alex Mentor',first_meeting_date:'2026-02-10'},'reminder-7',null);
  assert.match(message.body,/Alex Mentor/);
  assert.match(message.body,/2026-02-10/);
  assert.match(message.body,/Did you meet as planned\?/);
  assert.doesNotMatch(message.body,/Did your first mentoring meeting take place as planned\? If it was rescheduled/);
});
test('reminders retain the same link, fail without one and allow no unapproved template',()=>{
  const request={id:'fictional',role:'mentor',kind:'quarterly',period:3};
  for(const day of [7,14]){
    const message=render(request,'reminder-'+day,null);
    assert.doesNotMatch(message.body,/#same|\/check-in#/);
    assert.match(message.body,/Please reply with your answers to these questions:/);
  }
  assert.throws(()=>render(request,'reminder-4','token'));
  assert.throws(()=>render({...request,period:6},'reminder-7',null));
});
