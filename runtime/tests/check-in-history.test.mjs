import test from 'node:test';
import assert from 'node:assert/strict';
import {checkInHistory} from '../check-in-history.mjs';
import {messageRenderer} from '../templates.mjs';
import {renderEmailHTML} from '../email-html.mjs';

test('history query is scoped and preserves partial, zero and false answers without classifications',async()=>{
  const rows=[{period:6,sent_at:'2026-07-01',answers:'{}',answer_times:'{}'},
    {period:3,replied_at:'2026-04-15',answers:'{"meetings":0,"value":"Exact feedback","contact":false}',answer_times:'{"meetings":"2026-04-15"}',classifications:'{"value":"Significant"}'}];
  const db={prepare(sql){return {bind(...args){return {async first(){return {actual_date:'2026-01-01'};},async all(){
    assert.match(sql,/pair_id=\? AND application_id=\? AND role=\?/);
    assert.match(sql,/superseded=0 AND reviewed_at IS NULL/);
    assert.deepEqual(args,['pair','mentee','mentee',9]);return {results:rows};
  }}}}}};
  const request={pair_id:'pair',application_id:'mentee',role:'mentee',kind:'quarterly',period:9};
  const history=await checkInHistory(db,request);
  assert.equal(history.lastReport.answers.meetings,0);assert.equal(history.lastReport.answers.contact,false);
  assert.equal(history.countFrom,'2026-04-15');assert.equal(history.previousUnanswered.period,6);
  assert.ok(!JSON.stringify(history).includes('Significant'));
  const render=messageRenderer('https://example.invalid'),first=render({...request,history},'initial',null);
  assert.match(first.body,/How many times have you met since April 15, 2026\?/);
  assert.match(first.body,/do not have answers to your month-6/);
  assert.deepEqual(render(request,'reminder-7',null,first).history,history);
  rows[1].answers='{"value":"Partial feedback"}';rows[1].answer_times='{}';
  assert.equal((await checkInHistory(db,request)).countFrom,'2026-01-01');
  rows.length=0;
  const empty=await checkInHistory(db,request);
  assert.equal(empty.lastReport,null);assert.equal(empty.fromStart,true);
});

test('quoted past feedback is literal, not an actionable link or HTML',()=>{
  const html=renderEmailHTML({subject:'Example',body:'You wrote:\n> [old text](https://example.invalid/) <script>example</script>'});
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="https://example.invalid/"'));
});
