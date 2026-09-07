import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewAI,reviewModel} from '../review-ai.mjs';
import {reviewFeedback,reviewLowValue} from '../feedback.mjs';
import {examples} from '../fixtures.mjs';
import {codedMatchingFacts} from '../administration.mjs';
import {classificationCases,classificationInstructions} from '../classification-rules.mjs';
import {ratings,returnRatings} from '../feedback.mjs';
const response=value=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
test('review AI is disabled without verified spending and rejects unscreened text before a network call',async()=>{
  let calls=0;const fetcher=async()=>{calls++;throw new Error('must not call');};
  await createReviewAI({apiKey:'fake',fetcher}).classify('value',reviewFeedback.value);
  await createReviewAI({apiKey:'fake',spendingVerified:true,fetcher}).classify('value','Private raw feedback');
  await createReviewAI({apiKey:'fake',spendingVerified:true,fetcher}).recommend([{name:'Private raw profile'}]);
  assert.equal(calls,0);
});
test('bounded provider request sends only the approved fictional answer without storage or hidden retries',async()=>{
  let sent;const ai=createReviewAI({apiKey:'fake-test-only',spendingVerified:true,fetcher:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);return response({classification:'Meaningful',conditions:''});}});
  assert.equal((await ai.classify('progress',reviewFeedback.progress)).classification,'Meaningful');
  assert.equal(sent.model,reviewModel);assert.equal(sent.store,false);assert.equal(sent.text.format.strict,true);
  assert.deepEqual(JSON.parse(sent.input),{field:'progress',answer:reviewFeedback.progress});
});
test('refusal, exhausted budget, invalid categories and incomplete output leave interpretation pending',async()=>{
  for(const makeResponse of [()=>new Response('',{status:429}),()=>response({classification:'Great',conditions:''}),()=>Response.json({status:'incomplete'}),()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]})]){
    let calls=0;const ai=createReviewAI({apiKey:'fake',spendingVerified:true,fetcher:async()=>{calls++;return makeResponse();}});
    assert.equal((await ai.classify('value',reviewFeedback.value)).status,'pending');assert.equal(calls,1);
  }
});
test('matching sends coded fixture facts only and rejects an invented participant',async()=>{
  const records=['mentee','mentor'].map(role=>({id:crypto.randomUUID(),role,decision:'approved',retention:'keep',answers:examples[role]}));
  const facts=codedMatchingFacts(records);let sent;
  const suggestion={mentee:facts[0].code,mentor:facts[1].code,reasons:['Both describe distribution and delegation.'],gaps:[],risks:[],questions:['Can both schedule the meetings?']};
  const ai=createReviewAI({apiKey:'fake',spendingVerified:true,fetcher:async(url,options)=>{sent=JSON.parse(options.body);return response({suggestions:[suggestion]});}});
  assert.equal((await ai.recommend(records)).status,'recommended');
  assert.equal(sent.input.includes('Alex Example'),false);assert.equal(sent.input.includes('example.test'),false);assert.equal(sent.input.includes('linkedin'),false);
  suggestion.mentor='invented';assert.equal((await ai.recommend(records)).status,'pending');
});
test('the provider adapter can evaluate the explicit low-value example but not other raw prose',async()=>{
  let calls=0;const ai=createReviewAI({apiKey:'fake',spendingVerified:true,fetcher:async()=>{calls++;return response({classification:'Little or none',conditions:''});}});
  assert.equal((await ai.classify('value',reviewLowValue)).classification,'Little or none');
  assert.equal((await ai.classify('progress',reviewLowValue)).status,'pending');assert.equal(calls,1);
});
test('fixed classification corpus covers every approved category and passes only answer text, never labels',async()=>{
  assert.equal(new Set(classificationCases.map(c=>c.id)).size,20);
  for(const field of ['progress','value','returnInterest'])assert.deepEqual(new Set(classificationCases.filter(c=>c.field===field).map(c=>c.expected)),new Set(field==='returnInterest'?returnRatings:ratings));
  let calls=0;
  for(const example of classificationCases){
    const ai=createReviewAI({apiKey:'fake',spendingVerified:true,fetcher:async(url,options)=>{
      calls++;const sent=JSON.parse(options.body);
      assert.equal(sent.instructions,classificationInstructions);
      assert.deepEqual(JSON.parse(sent.input),{field:example.field,answer:example.answer});
      return response({classification:example.expected,conditions:example.condition??''});
    }});
    const result=await ai.classify(example.field,example.answer);
    assert.equal(result.classification,example.expected);assert.equal(result.conditions,example.condition??'');
  }
  assert.equal(calls,20); // Fake provider only. This is not an accuracy evaluation.
});
