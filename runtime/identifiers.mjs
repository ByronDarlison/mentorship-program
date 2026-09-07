// Minimize direct identifiers before routine provider calls. This is not
// anonymization: business context may still identify a participant.
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function sanitizeForProvider(text,identity={}){
  if(typeof text!=='string'||text.length>6000)return {refused:true};
  const name=identity?.name??'';
  const known=[identity?.email,identity?.['linkedin-url'],name,...name.split(/\s+/).filter(part=>part.length>=2)]
    .filter(value=>typeof value==='string'&&value.trim()).sort((a,b)=>b.length-a.length);
  let cleaned=text;
  for(const value of new Set(known))cleaned=cleaned.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(value)}(?=[^\\p{L}\\p{N}]|$)`,'giu'),'$1[removed]');
  // Dates are ordinary first-meeting answers, not telephone numbers.
  const checked=cleaned.replace(/\b\d{4}-\d{2}-\d{2}\b/g,'[date]');
  if(/[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\b|\/)|(?:^|\s)@[\w-]+/i.test(checked)||/(?:\+?\d[\s().-]*){10,}|\b\d{3}[-. ]?\d{4}\b/.test(checked))return {refused:true};
  return {text:cleaned};
}
