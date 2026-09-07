import test from 'node:test';
import assert from 'node:assert/strict';
import {addDays,addMonths,validateFeedback,feedbackStatus,finalContribution,summarizeResults,classifyReview,reviewFeedback,validateInterpretation} from '../feedback.mjs';
const request=(role='mentee',patch={})=>({id:'one',role,kind:'final',sent_at:'2026-01-01T12:00:00.000Z',deadline:'2026-01-22T12:00:00.000Z',answers:{},classifications:{},...patch});
const before='2026-01-20T12:00:00.000Z',after='2026-01-22T12:00:00.000Z';
test('month dates clamp to actual month end, not overflow',()=>{
  assert.equal(addMonths('2026-01-31',3),'2026-04-30');assert.equal(addMonths('2024-02-29',12),'2025-02-28');
  assert.equal(addDays('2026-01-01T12:00:00.000Z',21),after);
});
test('partial answers do not invent zeroes or erase prior answers',()=>{
  const prior={progress:'A useful decision',meetings:3};
  const merged={...prior,...validateFeedback(request(),{contact:false,progress:null,meetings:''})};
  assert.deepEqual(merged,{progress:'A useful decision',meetings:3,contact:false});
});
test('validate only the request fields and preserve zero/false',()=>{
  assert.deepEqual(validateFeedback(request(),{meetings:0,contact:false,progress:''}),{meetings:0,contact:false});
  for(const patch of [{meetings:-1},{meetings:1.5},{contact:'no'},{returnInterest:'yes'},{approved:true},{value:' '}])assert.throws(()=>validateFeedback(request(),patch));
});
test('all outcomes or original deadline controls entry for the whole relationship-role',()=>{
  const r=request('mentee',{answers:{progress:'Useful decision'},classifications:{progress:'Meaningful'},replied_at:before});
  assert.equal(finalContribution(r,before).included,false);
  const c=finalContribution(r,after);assert.equal(c.included,true);assert.equal(c.metrics.progress.positive,true);assert.equal(c.metrics.value.missing,true);
  assert.deepEqual(feedbackStatus(r,after).missingOutcomes,['value']);assert.equal(feedbackStatus(r,after).noResponseFailure,false);
  r.answers.value='Helpful';r.classifications.value='Meaningful';assert.equal(finalContribution(r,before).included,true);
  assert.equal(feedbackStatus(r,before).complete,false); // Meeting count/contact are still absent.
});
test('Unclear/Unsure are received answers and never positive',()=>{
  const r=request('mentor',{answers:{value:'Not sure',returnInterest:'Maybe'},classifications:{value:'Unclear',returnInterest:'Unsure'}});
  const c=finalContribution(r,before);assert.equal(c.included,true);assert.equal(c.metrics.value.positive,false);assert.equal(c.metrics.returnInterest.missing,false);
});
test('same mentor in two relationships counts twice; no combined success score',()=>{
  const rows=[request('mentor',{id:'one',answers:{value:'Good',returnInterest:'Yes'},classifications:{value:'Meaningful',returnInterest:'Interested'}}),request('mentor',{id:'two'})];
  const report=summarizeResults(rows,after);assert.equal(report.metrics.mentorReturn.included,2);assert.equal(report.metrics.mentorReturn.percent,50);assert.equal(report.metrics.mentorValue.missing,1);assert.equal(Object.hasOwn(report,'overall'),false);
});
test('superseded requests do not count completion; replacement does',()=>{
  const report=summarizeResults([request('mentee',{kind:'quarterly',superseded:1}),request()],after);
  assert.deepEqual(report.completion,{required:1,complete:0});
});
test('reporting-only deletion exception stays pending for the full window',()=>{
  const r=request('mentee',{reporting_only:1,answers:{progress:'Good',value:'Good'},classifications:{progress:'Meaningful',value:'Meaningful'}});
  assert.equal(finalContribution(r,before).included,false);assert.equal(finalContribution(r,after).included,true);
});
test('review classification preserves the important decision and conditional return rules without guessing',async()=>{
  assert.equal((await classifyReview('progress',reviewFeedback.progress)).classification,'Meaningful');
  assert.equal((await classifyReview('returnInterest',reviewFeedback.returnInterest)).conditions,'if the timing works');
  assert.equal((await classifyReview('value','I enjoyed the conversations')).status,'pending');
  assert.throws(()=>validateInterpretation('value',{status:'classified',classification:'Interested'}));
});
