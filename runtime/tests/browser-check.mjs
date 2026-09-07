// Run against `npm run dev:connected`. No real information or email is used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {examples} from '../fixtures.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const failures=[];
  page.on('pageerror',e=>failures.push(e.message));
  for(const role of ['mentee','mentor']) {
    await page.goto(`http://127.0.0.1:8787/apply/${role}`);
    const form=page.locator('.application-form');
    await page.waitForFunction(()=>!document.querySelector('[type=submit]').disabled);
    const original=await form.locator('[name=name]').inputValue();
    assert.ok(original.endsWith('Example'));
    await form.locator('[name=acknowledgement]').check();
    await form.locator('[name=name]').fill('Changed fictional example');
    await form.locator('[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('[name=name]').getAttribute('aria-invalid')==='true');
    assert.equal(await form.locator('[name=name]').inputValue(),'Changed fictional example');
    await form.locator('[name=name]').fill(original);
    // Simulate a lost response after the real server has saved. Retrying must
    // recover the same stored application, not create another one.
    let firstReference, retryReference;
    await page.route('**/api/applications',async route=>{
      const response=await route.fetch(); firstReference=(await response.json()).reference;
      await route.abort('failed');
    },{times:1});
    await form.locator('[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('couldn’t confirm'));
    assert.equal(await form.locator('[name=name]').inputValue(),original);
    assert.equal(await form.locator('[name=acknowledgement]').isChecked(),true);
    const responsePromise=page.waitForResponse('**/api/applications');
    await form.locator('[type=submit]').click();
    retryReference=(await (await responsePromise).json()).reference;
    assert.equal(retryReference,firstReference);
    await page.getByRole('heading',{name:'Application saved',exact:true}).waitFor();
    assert.equal(await form.isVisible(),false);
    assert.ok(await page.locator('body').innerText().then(s=>s.includes('No email was sent.')));
    await page.locator('[data-preview-again]').click();
    assert.equal(await form.locator('[name=acknowledgement]').isChecked(),false);
    assert.equal(await form.locator('[name=name]').inputValue(),original);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      if(process.env.SCREENSHOT_DIR)await page.screenshot({path:`${process.env.SCREENSHOT_DIR}/${role}-${width}.png`,fullPage:true});
    }
    console.log(`${role}: invalid input, lost response, retry, confirmation, repeat and widths passed`);
  }
  assert.deepEqual(failures,[]);
  const unavailable=await browser.newPage();
  await unavailable.route('**/application.js',route=>route.abort());
  for(const role of ['mentee','mentor']) {
    await unavailable.goto(`http://127.0.0.1:8787/apply/${role}`);
    const form=unavailable.locator('.application-form');
    for(const [name,value] of Object.entries(examples[role]))await form.locator(`[name="${name}"]`).fill(value);
    await form.locator('[type=checkbox]').check();
    assert.equal(await form.locator('[type=submit]').isDisabled(),true);
    const url=unavailable.url();
    await form.locator('[name=name]').press('Enter');
    assert.equal(unavailable.url(),url);
    assert.equal(await form.locator('[name=name]').inputValue(),examples[role].name);
    console.log(`${role}: unavailable script cannot submit or discard answers`);
  }
} finally {await browser.close();}
