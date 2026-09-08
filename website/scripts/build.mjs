import {sourceMetadata} from '../../release-origin.mjs';
import { readFile, mkdir, writeFile, copyFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderDesignReview } from '../design-review/render.mjs';
import {checkInContent} from '../src/check-in-content.mjs';
import { examples, fields } from '../../runtime/fixtures.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export async function build(configPath = 'website/config/review.json') {
  const config = JSON.parse(await readFile(path.resolve(root, configPath), 'utf8'));
  const source = await readFile(path.join(root, 'program/program-manual.md'), 'utf8');
  const metadata = {
    commit: sourceMetadata(root).commit,
    dirty: sourceMetadata(root).dirty,
    updated: sourceMetadata(root).updated
  };
  const operating=config.mode==='operating';
  if(!['review','operating'].includes(config.mode)||config.applicationsOpen!==operating||config.externalServicesEnabled!==operating)throw new Error('Application mode and service settings must agree.');
  const result = renderDesignReview(source, {connected:true,mode:config.mode});
  const checkIn=checkInContent(source);
  if(operating)checkIn.copy.review='';
  if (!/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(config.contactEmail)) throw new Error('Set a valid contactEmail in the operator configuration.');
  for (const [route, html] of result.pages) result.pages.set(route, html.replaceAll('mailto:chair@example.invalid', `mailto:${config.contactEmail}`).replaceAll('>chair@example.invalid</a>', `>${config.contactEmail}</a>`).replaceAll('mailto:mentorship@example.invalid', `mailto:${config.contactEmail}`).replaceAll('>mentorship@example.invalid</a>', `>${config.contactEmail}</a>`));
  const reviewSection = source.split(`## Application ${operating?'operating':'review'} messages\n`)[1]?.split('\n## ')[0];
  const copy = JSON.parse(reviewSection?.match(/```json\n([\s\S]*?)\n```/)?.[1] || 'null');
  if (!copy?.savedTitle || !copy?.saved || !copy?.failed || !copy?.saving) throw new Error('Missing canonical application review messages');
  const receipt = source.split('#### Application received\n')[1]?.split('\n#### ')[0];
  copy.receiptSubject = receipt?.match(/\*\*Subject:\*\* ([^\n]+)/)?.[1];
  copy.receiptBody = receipt?.split(/\*\*Subject:\*\* [^\n]+\n/)[1]?.trim();
  if (!copy.receiptSubject || !copy.receiptBody) throw new Error('Missing canonical application receipt');
  const destination = path.join(root, 'website/dist');
  // Remove obsolete generated pages before upload; keep their source documentation in Git.
  for (const page of ['program','mentees','mentors','contact','manual','licensing','check-in','owners-outcome']) {
    await rm(path.join(destination,page,'index.html'), {force:true});
  }
  await mkdir(path.join(destination, 'assets'), {recursive:true});
  for (const [route, html] of result.pages) {
    const output = route === '/404' ? path.join(destination, '404.html') : path.join(destination, route, 'index.html');
    await mkdir(path.dirname(output), {recursive:true});
    await writeFile(output, html);
  }
  for (const name of ['design.css', 'review.js']) await copyFile(path.join(root,'website/design-review',name), path.join(destination,name));
  await cp(path.join(root,'website/design-review/assets'), path.join(destination,'assets'), {recursive:true});
  await copyFile(path.join(root,'website/src/application.js'), path.join(destination,'application.js'));
  await writeFile(path.join(destination,'check-in-config.json'),JSON.stringify(checkIn));
  await writeFile(path.join(destination,'application-config.json'), JSON.stringify({mode:config.mode,fields,...(!operating?{examples}:{}),copy,termsVersion:result.manualSHA256,privacyVersion:result.manualSHA256}));
  await writeFile(path.join(destination,'robots.txt'), 'User-agent: *\nDisallow: /\n');
  const report = {...metadata,manualSHA256:result.manualSHA256,mode:config.mode,routes:[...result.pages.keys()],externalServicesEnabled:operating};
  await writeFile(path.join(destination,'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(destination,'_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store\n  Content-Security-Policy: default-src \'self\'; frame-ancestors \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'self\'\n');
  console.log(`Built ${result.pages.size - 1} ${config.mode} pages and a 404 page.`);
  return { ...result, report, config, destination };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await build(process.argv[2]);
