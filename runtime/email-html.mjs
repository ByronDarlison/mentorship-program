// One presentation for browser previews and the HTML part of outgoing mail.
// Message wording stays in the existing templates. All dynamic text is escaped.
export const escapeHTML=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function inline(text){
  const pattern=/\[([^\]\n]+)\]\((https:\/\/[^\s<>"')]+)\)|https:\/\/[^\s<>"']+/g;
  let result='',position=0;
  for(const match of text.matchAll(pattern)){
    const url=match[2]||match[0].replace(/[.,;!?)]+$/,'');
    result+=escapeHTML(text.slice(position,match.index));
    result+=`<a href="${escapeHTML(url)}" style="color:#3d46f2;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word">${escapeHTML(match[1]||url)}</a>`;
    position=match.index+(match[2]?match[0].length:url.length);
  }
  return result+escapeHTML(text.slice(position));
}
export function renderEmailHTML({subject,body}){
  const blocks=String(body).split(/\n\s*\n/).map(block=>{
    const lines=block.split('\n');
    if(lines.every(line=>/^\d+\. /.test(line)))return `<ol style="margin:0 0 20px;padding-left:24px">${lines.map(line=>`<li style="padding-left:4px;margin:0 0 12px">${inline(line.replace(/^\d+\. /,''))}</li>`).join('')}</ol>`;
    return `<p style="margin:0 0 20px">${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f3f9;color:#0c0c31;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f3f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff"><tr><td style="padding:24px;border-top:4px solid #3d46f2">
<p style="margin:0 0 28px;font-size:15px;line-height:22px;font-weight:bold;color:#0c0c31">Example Chapter Mentorship Program</p>
<div style="font-size:18px;line-height:28px;color:#0c0c31">${blocks}</div>
</td></tr></table></td></tr></table></body></html>`;
}
