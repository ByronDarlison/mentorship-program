// A dedicated program mailbox only. This is not connected by default and
// never falls back to an existing personal Gmail session or organization access.
import {renderEmailHTML} from './email-html.mjs';
const base64=text=>btoa(Array.from(new TextEncoder().encode(text),byte=>String.fromCharCode(byte)).join(''));
export function encodeSubject(subject){
  if(typeof subject!=='string'||!subject.trim()||subject.length>250||/[\r\n]/.test(subject))throw new Error('Invalid message subject.');
  // RFC 2047: encoded words <=75 characters and header lines <=76.
  // 39 UTF-8 bytes leave space for the first line's "Subject: " prefix.
  const parts=[];let part='';
  for(const character of subject){
    if(new TextEncoder().encode(part+character).length>39){parts.push(part);part='';}
    part+=character;
  }
  if(part)parts.push(part);
  return parts.map(text=>`=?UTF-8?B?${base64(text)}?=`).join('\r\n ');
}
export const messageReferenceHeader='X-EO-Mentorship-Reference';
export function rfc5322Date(date=new Date()){
  return date.toUTCString().replace(/GMT$/,'+0000');
}
function rfcMessageId(value){
  return typeof value==='string'&&value.length>2&&value.length<=300&&/^<[^<>\s]+@[^<>\s]+>$/.test(value);
}
function headerValues(list){
  const headers={};
  for(const header of list??[]){
    const name=header.name.toLowerCase();
    if(['message-id','x-eo-mentorship-reference','from','to'].includes(name)&&name in headers)headers[name]=null;
    else if(!(name in headers))headers[name]=header.value;
  }
  return headers;
}
export function createProgramMailbox({mailbox,chairEmail,clientId,clientSecret,refreshToken,connectionVerified=false,deliveryVerified=false,reviewRecipient,mode='review',fetcher=fetch}={}){
  const fail=()=>{throw new Error('Program mailbox access is unavailable. Follow-ups must wait for a successful sync.');};
  const address=v=>typeof v==='string'&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(v);
  async function connect(){
    if(!connectionVerified||!address(mailbox)||mailbox.toLowerCase()===chairEmail?.toLowerCase()||![clientId,clientSecret,refreshToken].every(v=>typeof v==='string'&&v))return fail();
    const tokenResponse=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.timeout(20000)});
    if(!tokenResponse.ok)return fail();
    const token=await tokenResponse.json();if(!token.access_token)return fail();
    async function request(path,body){
      const r=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token.access_token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
      if(!r.ok)return fail();return r.json();
    }
    const profile=await request('profile');
    if(profile.emailAddress?.toLowerCase()!==mailbox.toLowerCase())return fail();
    return request;
  }
  let session;const api=()=>session??=(connect().catch(error=>{session=null;throw error;}));
  function validateDelivery(message){
    if(!deliveryVerified||!['review','operating'].includes(mode)||!address(message?.to)||(mode==='review'&&(!address(reviewRecipient)||message.to.toLowerCase()!==reviewRecipient.toLowerCase()))||
      !/^<eom\.[A-Za-z0-9_-]+@mentorship\.invalid>$/.test(message.reference)||typeof message.subject!=='string'||!message.subject.trim()||message.subject.length>250||/[\r\n]/.test(message.subject)||typeof message.body!=='string'||!message.body.trim()||message.body.length>20000)return fail();
  }
  function receiptFromSaved(saved,message){
    if(typeof saved?.id!=='string'||!saved.id)return null;
    const headers=headerValues(saved.payload?.headers);
    const from=headers.from?.match(/<([^>]+)>$/)?.[1]??headers.from;
    const rfc=typeof headers['message-id']==='string'?headers['message-id'].trim():'';
    const internal=typeof headers['x-eo-mentorship-reference']==='string'?headers['x-eo-mentorship-reference'].trim():'';
    const sentAt=new Date(Number(saved.internalDate));
    if(internal!==message.reference||headers.to?.toLowerCase()!==message.to.toLowerCase()||from?.toLowerCase()!==mailbox.toLowerCase()||!saved.labelIds?.includes('SENT')||!rfcMessageId(rfc)||!Number.isFinite(sentAt.getTime()))return null;
    return {id:saved.id,reference:internal,rfcMessageId:rfc,to:headers.to,sentAt:sentAt.toISOString()};
  }
  async function sentMetadata(request,id){
    if(typeof id!=='string'||!id)return fail();
    return request('messages/'+encodeURIComponent(id)+'?format=metadata&metadataHeaders=Message-ID&metadataHeaders=To&metadataHeaders=From&metadataHeaders='+messageReferenceHeader);
  }
  async function deliveryReceipt(request,id,message){
    const receipt=receiptFromSaved(await sentMetadata(request,id),message);
    if(!receipt)return fail();
    return receipt;
  }
  return {async readMessages(){
    const get=await api();
    const messages=[],seen=new Set();let pageToken;
    // The first version has one small program mailbox. Scan all received mail,
    // not just unread mail, so reading/archiving cannot hide a response.
    // Any incomplete scan holds deadline processing. No silent cutoff.
    do{
      const query=new URLSearchParams({q:'-in:sent -in:drafts',maxResults:'100'});if(pageToken)query.set('pageToken',pageToken);
      const page=await get('messages?'+query);
      for(const entry of page.messages??[]){
        if(typeof entry.id!=='string'||seen.has(entry.id))continue;
        seen.add(entry.id);messages.push(await get('messages/'+encodeURIComponent(entry.id)+'?format=full'));
      }
      if(page.nextPageToken&&page.nextPageToken===pageToken)return fail();
      pageToken=page.nextPageToken;
      if(pageToken&&messages.length>=500)return fail();
    }while(pageToken);
    return messages;
  },async send(message){
    validateDelivery(message);const request=await api();
    const boundary='mentorship-'+crypto.randomUUID();
    const part=(type,body)=>[`--${boundary}`,`Content-Type: ${type}; charset=UTF-8`,'Content-Transfer-Encoding: base64','',base64(body).match(/.{1,76}/g).join('\r\n')].join('\r\n');
    const mime=[`From: Example Chapter Mentorship <${mailbox}>`,`To: ${message.to}`,`Date: ${rfc5322Date()}`,`Message-ID: ${message.reference}`,`${messageReferenceHeader}: ${message.reference}`,
      `Subject: ${encodeSubject(message.subject)}`,'MIME-Version: 1.0',`Content-Type: multipart/alternative; boundary="${boundary}"`,'',part('text/plain',message.body),part('text/html',renderEmailHTML(message)),`--${boundary}--`,''].join('\r\n');
    const response=await request('messages/send',{raw:base64(mime).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')});
    return deliveryReceipt(request,response.id,message);
  },async findSent(message){
    validateDelivery(message);const request=await api();
    let pageToken,seen=0,match=null;
    do{
      const query=new URLSearchParams({q:`in:sent from:${mailbox} to:${message.to}`,maxResults:'20'});
      if(pageToken)query.set('pageToken',pageToken);
      const listed=await request('messages?'+query);
      for(const entry of listed.messages??[]){
        if(typeof entry.id!=='string'||seen>=50)continue;
        seen++;
        const receipt=receiptFromSaved(await sentMetadata(request,entry.id),message);
        if(!receipt)continue;
        if(match)return null;
        match=receipt;
      }
      if(listed.nextPageToken&&listed.nextPageToken===pageToken)return fail();
      pageToken=listed.nextPageToken;
    }while(pageToken&&seen<50);
    return match;
  }};
}
