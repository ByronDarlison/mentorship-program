import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFeedback,feedbackStatus,finalContribution} from '../feedback.mjs';

test('month 12 and early-ending recommendations are accepted without adding outcome or completion requirements',()=>{
  for(const role of ['mentee','mentor'])for(const period of [0,12]){
    const answers={meetings:3,value:'Useful conversations.',contact:false,...(role==='mentee'?{progress:'Made an important decision.'}:{returnInterest:'Yes'})};
    const request={kind:'final',period,role,answers,classifications:{value:'Meaningful',progress:'Meaningful',returnInterest:'Interested'},deadline:'2026-12-31',superseded:0};
    assert.deepEqual(validateFeedback(request,{recommendations:'More practice in training.'}),{recommendations:'More practice in training.'});
    assert.equal(feedbackStatus(request,'2026-12-01').complete,true);
    assert.deepEqual(finalContribution(request,'2026-12-01'),finalContribution({...request,answers:{...answers,recommendations:'More practice in training.'}},'2026-12-01'));
    assert.throws(()=>validateFeedback({...request,kind:'quarterly',period:3},{recommendations:'More practice.'}));
  }
});
