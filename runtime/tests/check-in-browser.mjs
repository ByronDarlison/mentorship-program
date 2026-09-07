import {execFileSync} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {reviewFeedback} from '../feedback.mjs';

const {url}=JSON.parse(execFileSync(process.execPath,['runtime/scripts/seed-review.mjs'],{encoding:'utf8'}));
const browser=await chromium.launch({headless:true,channel:'chrome'});
const directory=await mkdtemp(join(tmpdir(),'mentorship-check-in-'));
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(url);await page.locator('#check-in-form').waitFor({state:'visible'});
  assert.equal(await page.locator('h1').textContent(),'Final mentorship check-in');
  assert.equal(await page.locator('textarea').count(),2);assert.equal(await page.locator('#answer-progress').inputValue(),'');
  await page.getByRole('button',{name:'Save answers'}).click();await page.getByRole('alert').filter({hasText:'Enter at least one answer'}).waitFor();
  await page.locator('#answer-progress').fill('Unapproved private text');await page.getByRole('button',{name:'Save answers'}).click();
  await page.locator('#answer-progress[aria-invalid=true]').waitFor();assert.equal(await page.locator('#answer-progress').inputValue(),'Unapproved private text');
  await page.locator('#answer-progress').fill(reviewFeedback.progress);
  let lost=false;await page.route('**/api/check-in',async route=>{
    if(route.request().method()==='POST'&&!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await page.getByRole('button',{name:'Save answers'}).click();await page.getByRole('alert').filter({hasText:'We couldn’t confirm'}).waitFor();
  assert.equal(await page.locator('#answer-progress').inputValue(),reviewFeedback.progress);
  await page.getByRole('button',{name:'Save answers'}).click();await page.getByRole('heading',{name:'Answers saved'}).waitFor();
  await page.screenshot({path:join(directory,'partial-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Add more answers'}).click();assert.equal(await page.locator('#answer-progress').inputValue(),'');
  await page.locator('#answer-meetings').fill('3');await page.locator('#answer-value').fill(reviewFeedback.value);await page.getByRole('radio',{name:'No',exact:true}).check();
  await page.screenshot({path:join(directory,'form-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(directory,'form-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Save answers'}).click();await page.getByRole('heading',{name:'Check-in complete'}).waitFor();
  await page.reload();await page.locator('#check-in-form').waitFor({state:'visible'});assert.equal(await page.locator('#answer-value').inputValue(),'');assert.equal(await page.locator('#answer-progress').inputValue(),'');
  lost=false;await page.locator('#answer-value').fill(reviewFeedback.value);
  await page.getByRole('button',{name:'Save answers'}).click();await page.getByRole('alert').filter({hasText:'We couldn’t confirm'}).waitFor();
  await page.getByRole('radio',{name:'Yes',exact:true}).check();
  await page.getByRole('button',{name:'Save answers'}).click();await page.getByRole('heading',{name:'Check-in complete'}).waitFor();
  await page.goto('http://127.0.0.1:8787/check-in#invalid');await page.getByRole('alert').filter({hasText:'unavailable'}).waitFor();
  assert.equal(await page.locator('#check-in-form').isVisible(),false);
  console.log(JSON.stringify({result:'PASS',checks:['blank private GET','empty save','field error','lost response retry','lost response with edited retry','Chair contact yes','partial then complete','no prior answers on reopen','mobile overflow','unavailable link'],screenshots:directory}));
}finally{await browser.close();}
