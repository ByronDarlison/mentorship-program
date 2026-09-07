import {InputError} from './applications.mjs';

// Backblaze B2 native API (v4). This module is deliberately small and closed:
// it stores only JSON under snapshots/ and recovery/, it deletes exact file
// versions rather than hiding them, and it offers no conditional or
// compare-and-set write, because B2 does not support conditional puts. The
// single-current-pointer guarantee lives in the database, not in the bucket.
// Sources: b2_authorize_account, b2_get_upload_url, b2_upload_file,
// b2_download_file_by_name, b2_list_file_versions, b2_delete_file_version.
const AUTHORIZE_URL='https://api.backblazeb2.com/b2api/v4/b2_authorize_account';
const API_PREFIX='/b2api/v4/';
// B2 returns api/download hosts under backblazeb2.com and upload pods under backblaze.com.
const ALLOWED_HOSTS=['backblazeb2.com','backblaze.com'];
const REQUIRED_CAPABILITIES=['listFiles','readFiles','writeFiles','deleteFiles'];
const KEY_PREFIXES=['snapshots/','recovery/'];
const KEY_PATTERN=/^(?:snapshots|recovery)\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,80}\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
const PREFIX_PATTERN=/^[A-Za-z0-9._/-]+$/;
const FILE_ID_PATTERN=/^[A-Za-z0-9_-]{1,250}$/;
const BUCKET_ID_PATTERN=/^[A-Fa-f0-9]{8,64}$/;
const BUCKET_NAME_PATTERN=/^[a-z0-9][a-z0-9-]{4,48}$/;
const CREDENTIAL_PATTERN=/^[\x21-\x7e]{1,256}$/;
const METADATA_NAME_PATTERN=/^[a-z][a-z0-9-]{0,30}$/;
const METADATA_VALUE_PATTERN=/^[\x20-\x7e]{1,256}$/;
const HEX40=/^[0-9a-f]{40}$/;
const MAX_TIMESTAMP_MS=8640000000000000;
const LIST_ACTIONS=['upload','hide','start'];
const REQUEST_TIMEOUT_MS=20000;
const MAX_JSON_BYTES=1<<20;
const MAX_OBJECT_BYTES=16<<20;
const MAX_METADATA_BYTES=1024;
const MAX_METADATA_FIELDS=10;
const MAX_KEY_LENGTH=900;
const MAX_PAGE=1000;
const REAUTHORIZE=Symbol('reauthorize');

// Storage faults never carry a provider payload, host, token or error code.
class StorageFailure extends Error {}

function requireSafeUrl(value,label) {
  let url;
  try { url=new URL(String(value)); } catch { throw new StorageFailure(`Private backup storage returned an unusable ${label} address.`); }
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!ALLOWED_HOSTS.some(domain=>host===domain||host.endsWith('.'+domain)))throw new StorageFailure(`Private backup storage returned an unusable ${label} address.`);
  return url;
}
function requireKey(key) {
  if(typeof key!=='string'||key.length>MAX_KEY_LENGTH||!KEY_PATTERN.test(key))throw new InputError('Private backups store only snapshot and recovery JSON objects.');
  return key;
}
function requirePrefix(prefix) {
  if(typeof prefix!=='string'||prefix.length>MAX_KEY_LENGTH||!PREFIX_PATTERN.test(prefix)||prefix.includes('..')||prefix.includes('//')||!KEY_PREFIXES.some(root=>prefix.startsWith(root)))throw new InputError('Private backup listings cover only the snapshot and recovery prefixes.');
  return prefix;
}
function requireCursor(cursor,prefix) {
  if(cursor===undefined||cursor===null)return null;
  if(typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).some(field=>!['startFileName','startFileId'].includes(field)))throw new InputError('Continue a private backup listing with the cursor it returned.');
  const startFileName=cursor.startFileName,startFileId=cursor.startFileId??null;
  if(typeof startFileName!=='string'||startFileName.length>MAX_KEY_LENGTH||!startFileName.startsWith(prefix)||(startFileId!==null&&!FILE_ID_PATTERN.test(startFileId)))throw new InputError('Continue a private backup listing with the cursor it returned.');
  return {startFileName,startFileId};
}
const encodePath=value=>value.split('/').map(encodeURIComponent).join('/');
function decodeHeader(value) {
  if(typeof value!=='string')return null;
  try { return decodeURIComponent(value); } catch { return null; }
}
function decodeText(bytes) {
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { throw new StorageFailure('Private backup storage returned unreadable text.'); }
}
async function sha1Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
// A provider timestamp outside the representable Date range throws on
// conversion, so it is treated as absent rather than allowed to escape.
function timestampToIso(value) {
  if(!/^\d{1,16}$/.test(String(value??'')))return null;
  const milliseconds=Number(value);
  return Number.isSafeInteger(milliseconds)&&milliseconds>=0&&milliseconds<=MAX_TIMESTAMP_MS?new Date(milliseconds).toISOString():null;
}
function readMetadataHeaders(headers) {
  const metadata={};
  headers.forEach((value,name)=>{
    const field=String(name).toLowerCase();
    if(!field.startsWith('x-bz-info-'))return;
    const decoded=decodeHeader(value);
    if(METADATA_NAME_PATTERN.test(field.slice(10))&&decoded!==null&&decoded.length<=MAX_METADATA_BYTES)metadata[field.slice(10)]=decoded;
  });
  return metadata;
}
function readMetadataObject(fileInfo) {
  const metadata={};
  if(!fileInfo||typeof fileInfo!=='object'||Array.isArray(fileInfo))return metadata;
  for(const [field,value] of Object.entries(fileInfo))if(METADATA_NAME_PATTERN.test(field)&&typeof value==='string'&&value.length<=MAX_METADATA_BYTES)metadata[field]=value;
  return metadata;
}
function buildMetadataHeaders(customMetadata) {
  if(customMetadata===undefined||customMetadata===null)return {};
  if(typeof customMetadata!=='object'||Array.isArray(customMetadata))throw new InputError('Private backup metadata must be named text values.');
  const headers={};let total=0;
  for(const [field,value] of Object.entries(customMetadata)) {
    if(!METADATA_NAME_PATTERN.test(field)||typeof value!=='string'||!METADATA_VALUE_PATTERN.test(value))throw new InputError('Private backup metadata must be named text values.');
    const encoded=encodeURIComponent(value);
    total+=field.length+encoded.length+12;
    headers['X-Bz-Info-'+field]=encoded;
  }
  if(total>MAX_METADATA_BYTES||Object.keys(headers).length>MAX_METADATA_FIELDS)throw new InputError('Private backup metadata is too large.');
  return headers;
}

// Every read is bounded and every response is refused before its body is used
// if it declares or streams more than the limit for that call.
async function readBytes(response,limit) {
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d{1,15}$/.test(declared)||Number(declared)>limit))throw new StorageFailure('Private backup storage returned an oversized response.');
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader();
  const chunks=[];let total=0;
  try {
    for(;;) {
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>limit) { await reader.cancel(); throw new StorageFailure('Private backup storage returned an oversized response.'); }
      chunks.push(value);
    }
  } catch(error) {
    if(error instanceof StorageFailure)throw error;
    throw new StorageFailure('Private backup storage response could not be read.');
  }
  const bytes=new Uint8Array(total);let at=0;
  for(const chunk of chunks) { bytes.set(chunk,at); at+=chunk.byteLength; }
  return bytes;
}
async function readJson(response,limit=MAX_JSON_BYTES) {
  const text=decodeText(await readBytes(response,limit));
  try { return JSON.parse(text); } catch { throw new StorageFailure('Private backup storage returned an unusable response.'); }
}

export function createBackblazeBucket({keyId,applicationKey,bucketId,bucketName,fetcher=fetch}={}) {
  if(!CREDENTIAL_PATTERN.test(String(keyId??''))||!CREDENTIAL_PATTERN.test(String(applicationKey??''))||!BUCKET_ID_PATTERN.test(String(bucketId??''))||!BUCKET_NAME_PATTERN.test(String(bucketName??''))||typeof fetcher!=='function')throw new InputError('Private backup storage is not configured.',503);
  const bucket={id:bucketId,name:bucketName};
  const basic='Basic '+btoa(`${keyId}:${applicationKey}`);
  let session=null;

  async function send(url,init) {
    let response;
    try {
      response=await fetcher(String(url),{...init,redirect:'manual',signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
    } catch { throw new StorageFailure('Private backup storage did not respond.'); }
    if(!response||typeof response.status!=='number'||!response.headers||typeof response.headers.get!=='function')throw new StorageFailure('Private backup storage did not respond.');
    if(response.redirected||(response.status>=300&&response.status<400))throw new StorageFailure('Private backup storage attempted an unsupported redirect.');
    return response;
  }

  // The credential must already be restricted to this one bucket, and must carry
  // at least the four capabilities used here. Extra capabilities are accepted;
  // a missing one is not. An account-wide key is refused outright: it could
  // reach every other bucket, and this Worker never needs that reach.
  async function authorize() {
    const response=await send(AUTHORIZE_URL,{method:'GET',headers:{Authorization:basic}});
    if(!response.ok)throw new InputError('Private backup storage did not accept the stored credential.',503);
    const body=await readJson(response);
    const storage=body?.apiInfo?.storageApi;
    if(typeof body?.authorizationToken!=='string'||!body.authorizationToken||!storage||typeof storage!=='object')throw new StorageFailure('Private backup storage returned an unusable authorization.');
    const apiUrl=requireSafeUrl(storage.apiUrl,'API');
    const downloadUrl=requireSafeUrl(storage.downloadUrl,'download');
    const allowed=storage.allowed;
    const buckets=Array.isArray(allowed?.buckets)?allowed.buckets:null;
    if(!buckets||buckets.length!==1||buckets[0]?.id!==bucket.id||buckets[0]?.name!==bucket.name)throw new InputError('The private backup credential is not restricted to the mentorship bucket.',503);
    if(allowed.namePrefix!==null&&allowed.namePrefix!==undefined&&allowed.namePrefix!=='')throw new InputError('The private backup credential is restricted to a different name prefix.',503);
    const capabilities=Array.isArray(allowed.capabilities)?allowed.capabilities:[];
    if(!REQUIRED_CAPABILITIES.every(capability=>capabilities.includes(capability)))throw new InputError('The private backup credential is missing a required storage permission.',503);
    return {token:body.authorizationToken,apiUrl,downloadUrl};
  }

  // One bounded retry. An expired 24-hour token is ordinary; a second refusal is not.
  async function useSession(run) {
    session??=await authorize();
    let outcome=await run(session);
    if(outcome===REAUTHORIZE) {
      session=null;
      session=await authorize();
      outcome=await run(session);
    }
    if(outcome===REAUTHORIZE)throw new StorageFailure('Private backup storage refused the authorized request.');
    return outcome;
  }

  function apiUrlFor(current,operation,parameters={}) {
    const url=new URL(API_PREFIX+operation,current.apiUrl.origin);
    for(const [name,value] of Object.entries(parameters))if(value!==null&&value!==undefined)url.searchParams.set(name,String(value));
    return url;
  }

  async function requestUploadLocation(current) {
    const response=await send(apiUrlFor(current,'b2_get_upload_url',{bucketId:bucket.id}),{method:'GET',headers:{Authorization:current.token}});
    if(response.status===401)return REAUTHORIZE;
    if(!response.ok)throw new StorageFailure('Private backup storage did not provide an upload location.');
    const body=await readJson(response);
    if(body?.bucketId!==bucket.id||typeof body?.authorizationToken!=='string'||!body.authorizationToken)throw new StorageFailure('Private backup storage returned an unusable upload location.');
    // Validate the returned host before the upload token leaves this Worker.
    return {url:requireSafeUrl(body.uploadUrl,'upload'),token:body.authorizationToken};
  }

  async function get(key) {
    const name=requireKey(key);
    return useSession(async current=>{
      const url=new URL(`/file/${encodePath(bucket.name)}/${encodePath(name)}`,current.downloadUrl.origin);
      const response=await send(url,{method:'GET',headers:{Authorization:current.token}});
      if(response.status===401)return REAUTHORIZE;
      if(response.status===404)return null;
      if(!response.ok)throw new StorageFailure('Private backup storage could not return the object.');
      const bytes=await readBytes(response,MAX_OBJECT_BYTES);
      const fileId=response.headers.get('x-bz-file-id')??'';
      if(!FILE_ID_PATTERN.test(fileId)||decodeHeader(response.headers.get('x-bz-file-name'))!==name)throw new StorageFailure('Private backup storage returned an unexpected object.');
      const contentSha1=String(response.headers.get('x-bz-content-sha1')??'').replace(/^unverified:/,'').toLowerCase();
      if(!HEX40.test(contentSha1)||await sha1Hex(bytes)!==contentSha1)throw new StorageFailure('Private backup storage returned a damaged object.');
      return {key:name,fileId,size:bytes.byteLength,contentSha1,uploadedAt:timestampToIso(response.headers.get('x-bz-upload-timestamp')),customMetadata:readMetadataHeaders(response.headers),text:async()=>decodeText(bytes)};
    });
  }

  async function put(key,text,options={}) {
    const name=requireKey(key);
    if(typeof text!=='string')throw new InputError('Private backup contents must be text.');
    if(options===null||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(field=>field!=='customMetadata'))throw new InputError('Unexpected private backup option.');
    const bytes=new TextEncoder().encode(text);
    if(bytes.byteLength>MAX_OBJECT_BYTES)throw new InputError('This private backup is larger than the supported object size.',413);
    const metadata=buildMetadataHeaders(options.customMetadata);
    const contentSha1=await sha1Hex(bytes);
    return useSession(async current=>{
      const upload=await requestUploadLocation(current);
      if(upload===REAUTHORIZE)return REAUTHORIZE;
      // The runtime sets Content-Length from this fixed-length byte body, which
      // b2_upload_file requires; chunked uploads are not supported.
      const response=await send(upload.url,{method:'POST',headers:{
        Authorization:upload.token,
        'X-Bz-File-Name':encodePath(name),
        'Content-Type':'application/json',
        'X-Bz-Content-Sha1':contentSha1,
        'X-Bz-Server-Side-Encryption':'AES256',
        ...metadata
      },body:bytes});
      // B2 asks callers to take a fresh upload location for these statuses.
      if([401,408,429,503].includes(response.status))return REAUTHORIZE;
      if(!response.ok)throw new StorageFailure('Private backup storage did not accept the object.');
      const saved=await readJson(response);
      if(saved?.fileName!==name||!FILE_ID_PATTERN.test(String(saved?.fileId??''))||String(saved?.contentSha1??'').toLowerCase()!==contentSha1)throw new StorageFailure('Private backup storage confirmed a different object.');
      // Managed encryption is requested on upload and confirmed from the
      // receipt, so an unencrypted store is refused rather than reported.
      if(saved.serverSideEncryption?.mode!=='SSE-B2'||saved.serverSideEncryption?.algorithm!=='AES256')throw new StorageFailure('Private backup storage did not confirm managed encryption.');
      return {key:name,fileId:saved.fileId,size:bytes.byteLength,contentSha1,encryption:{mode:'SSE-B2',algorithm:'AES256'},customMetadata:readMetadataObject(saved.fileInfo)};
    });
  }

  // Versions, not names. Retention has to delete every historical version, and
  // a listing that cannot be fully validated is refused rather than trimmed.
  async function listVersions({prefix,cursor,limit=MAX_PAGE}={}) {
    const scope=requirePrefix(prefix);
    if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_PAGE)throw new InputError('Private backup listings request between 1 and 1000 versions.');
    const start=requireCursor(cursor,scope);
    return useSession(async current=>{
      const url=apiUrlFor(current,'b2_list_file_versions',{bucketId:bucket.id,prefix:scope,maxFileCount:limit,startFileName:start?.startFileName??null,startFileId:start?.startFileId??null});
      const response=await send(url,{method:'GET',headers:{Authorization:current.token}});
      if(response.status===401)return REAUTHORIZE;
      if(!response.ok)throw new StorageFailure('Private backup storage could not list stored versions.');
      const body=await readJson(response);
      if(!body||!Array.isArray(body.files)||body.files.length>limit)throw new StorageFailure('Private backup storage returned an unusable listing.');
      const versions=body.files.map(file=>{
        const name=file?.fileName;
        if(typeof name!=='string'||!name.startsWith(scope)||name.length>MAX_KEY_LENGTH||!KEY_PATTERN.test(name)||!FILE_ID_PATTERN.test(String(file?.fileId??''))||!LIST_ACTIONS.includes(file?.action)||!Number.isSafeInteger(file?.uploadTimestamp)||file.uploadTimestamp<0||file.uploadTimestamp>MAX_TIMESTAMP_MS)throw new StorageFailure('Private backup storage returned an unusable listing.');
        return {key:name,fileId:file.fileId,action:file.action,uploadedAt:new Date(file.uploadTimestamp).toISOString(),size:Number.isSafeInteger(file.contentLength)?file.contentLength:null,customMetadata:readMetadataObject(file.fileInfo)};
      });
      const nextName=body.nextFileName??null,nextId=body.nextFileId??null;
      if(nextName!==null&&(typeof nextName!=='string'||!nextName.startsWith(scope)||nextName.length>MAX_KEY_LENGTH))throw new StorageFailure('Private backup storage returned an unusable listing.');
      if(nextId!==null&&!FILE_ID_PATTERN.test(String(nextId)))throw new StorageFailure('Private backup storage returned an unusable listing.');
      // A finished listing carries no continuation at all, and a continuation that
      // repeats the request would page forever. Both are refused, not followed.
      if(nextName===null&&nextId!==null)throw new StorageFailure('Private backup storage returned an unusable listing.');
      if(nextName!==null&&start&&nextName===start.startFileName&&(nextId??null)===(start.startFileId??null))throw new StorageFailure('Private backup storage returned a repeating listing cursor.');
      return {versions,cursor:nextName?{startFileName:nextName,startFileId:nextId}:null};
    });
  }

  // Exact version removal. This module never calls b2_hide_file, because a hide
  // marker leaves the participant data in place while appearing to remove it.
  async function deleteVersion(request={}) {
    if(request===null||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(field=>!['key','fileId'].includes(field)))throw new InputError('Removing a private backup version requires its key and exact version id.');
    const name=requireKey(request.key);
    const fileId=request.fileId;
    if(typeof fileId!=='string'||!FILE_ID_PATTERN.test(fileId))throw new InputError('Removing a private backup version requires its key and exact version id.');
    return useSession(async current=>{
      const response=await send(apiUrlFor(current,'b2_delete_file_version'),{method:'POST',headers:{Authorization:current.token,'Content-Type':'application/json'},body:JSON.stringify({fileName:name,fileId})});
      if(response.status===401)return REAUTHORIZE;
      if(!response.ok)throw new StorageFailure('Private backup storage did not remove the requested version.');
      const body=await readJson(response);
      if(body?.fileName!==name||body?.fileId!==fileId)throw new StorageFailure('Private backup storage removed a different version.');
      return {key:name,fileId,deleted:true};
    });
  }

  return {get,put,listVersions,deleteVersion};
}
