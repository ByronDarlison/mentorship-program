import {sourceMetadata} from '../../release-origin.mjs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import path from 'node:path';
import MarkdownIt from 'markdown-it';

// Maintainer reference only. Output is outside website/dist and never deployed.
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=await readFile(path.join(root,'program/program-manual.md'),'utf8');
const digest=createHash('sha256').update(source).digest('hex');
const revision=sourceMetadata(root).commit;
const dirty=sourceMetadata(root).dirty;
const md=new MarkdownIt({html:false,linkify:false});
const body=md.render(source.replace(/^<!-- internal-note:(?:start|end) -->\s*$/gm,''));
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Mentorship Program Manual: maintainer copy</title><style>
body{font:16px/1.5 system-ui,sans-serif;color:#17132f;margin:2rem auto;padding:0 1.5rem;max-width:70rem}h1,h2,h3{line-height:1.2}h2{margin-top:2rem}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid #bbb;padding:.45rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit}blockquote{border-left:3px solid #777;margin-left:0;padding-left:1rem}.provenance{font-size:.8rem;overflow-wrap:anywhere;border-bottom:1px solid #bbb;padding-bottom:1rem}@page{size:A4;margin:18mm}@media print{body{font-size:10pt;max-width:none;margin:0;padding:0}h1,h2,h3,h4,p:has(+ul),p:has(+ol){break-after:avoid}p,li{orphans:3;widows:3}tr,blockquote,li{break-inside:avoid}thead{display:table-header-group}a{text-decoration:none}}
</style></head><body><p class="provenance">Complete maintainer reference, including internal notes. Not a participant page. Source revision ${revision}${dirty?' (working changes present)':''}. Manual SHA-256 ${digest}.</p><main>${body}</main></body></html>`;
const directory=path.join(root,'runtime/private');await mkdir(directory,{recursive:true});
const output=path.join(directory,'program-manual-print.html');await writeFile(output,html);
let pdf;
if(process.argv.includes('--pdf')){
  // Optional local print verification. Chrome and Playwright are development
  // tools, not another production service or a participant-facing route.
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();await page.goto(pathToFileURL(output).href);
    const folder=path.join(directory,'output/pdf');await mkdir(folder,{recursive:true});pdf=path.join(folder,'program-manual.pdf');
    await page.pdf({path:pdf,preferCSSPageSize:true,printBackground:true,tagged:true,outline:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'});
  }finally{await browser.close();}
}
console.log(JSON.stringify({output,...(pdf?{pdf}:{}),revision,dirty,manualSHA256:digest}));
