import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBackblazeBucket} from '../backblaze.mjs';

const KEY_ID='00512eab3aef1230000000001';
const APP_KEY='fictional-backblaze-application-key';
const BUCKET_ID='7c88f1d182b1506446ff0b16';
const BUCKET_NAME='eo-mentorship-backups';
const API_HOST='https://api005.backblazeb2.com';
const DOWNLOAD_HOST='https://f005.backblazeb2.com';
const UPLOAD_URL='https://pod-000-1007-13.backblaze.com/b2api/v4/b2_upload_file/7c88f1d182b1506446ff0b16/c001';
const SNAPSHOT_KEY='snapshots/2026-09-07T12-00-00.000Z-3f9c1a2b.json';
const FILE_ID='4_z7c88f1d182b1506446ff0b16_f1004ba650fe24e6b_d20260907_m120000_c005_v0001_t0000';
const BODY='{"format":"eo-mentorship","version":6}';
const DIGEST='a'.repeat(64);
const UPLOADED_AT='2026-09-07T12:00:00.000Z';
const UPLOADED_MS=Date.parse(UPLOADED_AT);
const EARLIER_MS=Date.parse('2026-09-06T12:00:00.000Z');

const sha1Of=text=>createHash('sha1').update(text).digest('hex');
const jsonReply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

function authorization({storage={},allowed={}}={}) {
  return {authorizationToken:'account-token',apiInfo:{storageApi:{
    apiUrl:API_HOST,downloadUrl:DOWNLOAD_HOST,absoluteMinimumPartSize:5000000,recommendedPartSize:100000000,
    allowed:{capabilities:['listFiles','readFiles','writeFiles','deleteFiles'],buckets:[{id:BUCKET_ID,name:BUCKET_NAME}],namePrefix:null,...allowed},
    ...storage
  }}};
}
function downloadReply(text,{key=SNAPSHOT_KEY,fileId=FILE_ID,sha1,metadata={sha256:DIGEST},status=200}={}) {
  const headers=new Headers({'x-bz-file-id':fileId,'x-bz-file-name':encodeURIComponent(key).replaceAll('%2F','/'),'x-bz-content-sha1':sha1??sha1Of(text),'x-bz-upload-timestamp':String(UPLOADED_MS),'content-type':'application/json'});
  for(const [field,value] of Object.entries(metadata))headers.set('x-bz-info-'+field,encodeURIComponent(value));
  return new Response(new TextEncoder().encode(text),{status,headers});
}
function uploadedReply({key=SNAPSHOT_KEY,fileId=FILE_ID,text=BODY,sha1,encryption={mode:'SSE-B2',algorithm:'AES256'}}={}) {
  return jsonReply({fileId,fileName:key,contentSha1:sha1??sha1Of(text),contentLength:text.length,contentType:'application/json',fileInfo:{sha256:DIGEST},bucketId:BUCKET_ID,uploadTimestamp:UPLOADED_MS,...(encryption?{serverSideEncryption:encryption}:{})});
}
function fakeFetch(routes) {
  const calls=[];
  const fetcher=async(url,init={})=>{
    const address=String(url),method=init.method??'GET';
    calls.push({url:address,method,headers:new Headers(init.headers??{}),body:init.body,redirect:init.redirect});
    for(const route of routes) {
      if(!address.includes(route.match)||(route.method??method)!==method)continue;
      if(route.once&&route.used)continue;
      route.used=true;
      return await route.reply(address,init);
    }
    throw new Error(`unexpected request: ${method} ${address}`);
  };
  fetcher.calls=calls;
  return fetcher;
}
const authorizeRoute=options=>({match:'b2_authorize_account',reply:()=>jsonReply(authorization(options))});
const bucketFor=fetcher=>createBackblazeBucket({keyId:KEY_ID,applicationKey:APP_KEY,bucketId:BUCKET_ID,bucketName:BUCKET_NAME,fetcher});

test('stores and reads a snapshot through the native B2 endpoints',async()=>{
  const fetcher=fakeFetch([
    authorizeRoute(),
    {match:'b2_get_upload_url',reply:()=>jsonReply({bucketId:BUCKET_ID,uploadUrl:UPLOAD_URL,authorizationToken:'upload-token'})},
    {match:'b2_upload_file',method:'POST',reply:()=>uploadedReply()},
    {match:'/file/',reply:()=>downloadReply(BODY)}
  ]);
  const bucket=bucketFor(fetcher);
  const saved=await bucket.put(SNAPSHOT_KEY,BODY,{customMetadata:{sha256:DIGEST}});
  assert.deepEqual(saved,{key:SNAPSHOT_KEY,fileId:FILE_ID,size:BODY.length,contentSha1:sha1Of(BODY),encryption:{mode:'SSE-B2',algorithm:'AES256'},customMetadata:{sha256:DIGEST}});

  const [authorizeCall,uploadUrlCall,uploadCall]=fetcher.calls;
  assert.equal(authorizeCall.url,'https://api.backblazeb2.com/b2api/v4/b2_authorize_account');
  assert.equal(authorizeCall.headers.get('authorization'),'Basic '+btoa(`${KEY_ID}:${APP_KEY}`));
  assert.equal(authorizeCall.redirect,'manual');
  assert.equal(uploadUrlCall.url,`${API_HOST}/b2api/v4/b2_get_upload_url?bucketId=${BUCKET_ID}`);
  assert.equal(uploadCall.url,UPLOAD_URL);
  assert.equal(uploadCall.headers.get('authorization'),'upload-token');
  assert.equal(uploadCall.headers.get('x-bz-file-name'),SNAPSHOT_KEY);
  assert.equal(uploadCall.headers.get('x-bz-content-sha1'),sha1Of(BODY));
  assert.equal(uploadCall.headers.get('content-type'),'application/json');
  assert.equal(uploadCall.headers.get('x-bz-server-side-encryption'),'AES256');
  assert.equal(uploadCall.headers.get('x-bz-info-sha256'),DIGEST);

  const object=await bucket.get(SNAPSHOT_KEY);
  assert.equal(await object.text(),BODY);
  assert.equal(object.fileId,FILE_ID);
  assert.equal(object.customMetadata.sha256,DIGEST);
  assert.equal(object.uploadedAt,UPLOADED_AT);
  assert.equal(fetcher.calls.at(-1).url,`${DOWNLOAD_HOST}/file/${BUCKET_NAME}/${SNAPSHOT_KEY}`);
  assert.equal(fetcher.calls.filter(call=>call.url.includes('b2_authorize_account')).length,1,'one authorization is reused across calls');
});

test('refuses a credential that is not scoped to this bucket with the needed capabilities',async()=>{
  const cases=[
    {allowed:{buckets:[{id:'0000000000000000000000ff',name:'another-bucket'}]}},
    {allowed:{buckets:[{id:BUCKET_ID,name:'another-bucket'}]}},
    {allowed:{buckets:null}},
    {allowed:{buckets:[{id:BUCKET_ID,name:BUCKET_NAME},{id:'0000000000000000000000ff',name:'second-bucket'}]}},
    {allowed:{capabilities:['listFiles','readFiles','writeFiles']}},
    {allowed:{namePrefix:'snapshots/'}}
  ];
  for(const options of cases) {
    const fetcher=fakeFetch([authorizeRoute(options)]);
    await assert.rejects(bucketFor(fetcher).get(SNAPSHOT_KEY),/credential/);
    assert.equal(fetcher.calls.length,1,'no request may follow a refused credential');
  }
});

test('refuses non-HTTPS and foreign hosts before any token is transmitted',async()=>{
  for(const storage of [{apiUrl:'http://api005.backblazeb2.com'},{apiUrl:'https://api005.backblazeb2.com.attacker.example'},{downloadUrl:'https://backups.attacker.example'},{downloadUrl:'https://user:pass@f005.backblazeb2.com'}]) {
    const fetcher=fakeFetch([authorizeRoute({storage})]);
    await assert.rejects(bucketFor(fetcher).get(SNAPSHOT_KEY),/unusable (API|download) address/);
    assert.equal(fetcher.calls.length,1);
  }
  for(const uploadUrl of ['http://pod-000-1007-13.backblaze.com/upload','https://uploads.attacker.example/b2api/v4/b2_upload_file']) {
    const fetcher=fakeFetch([
      authorizeRoute(),
      {match:'b2_get_upload_url',reply:()=>jsonReply({bucketId:BUCKET_ID,uploadUrl,authorizationToken:'upload-token'})}
    ]);
    await assert.rejects(bucketFor(fetcher).put(SNAPSHOT_KEY,BODY),/unusable upload address/);
    assert.equal(fetcher.calls.length,2,'the upload token must not leave the Worker');
  }
});

test('refuses redirected responses',async()=>{
  const fetcher=fakeFetch([
    authorizeRoute(),
    {match:'/file/',reply:()=>new Response(null,{status:302,headers:{location:'https://backups.attacker.example/copy'}})}
  ]);
  await assert.rejects(bucketFor(fetcher).get(SNAPSHOT_KEY),/unsupported redirect/);
});

test('returns null for a missing object and fails for every other error',async()=>{
  const missing=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>new Response(null,{status:404})}]);
  assert.equal(await bucketFor(missing).get(SNAPSHOT_KEY),null);
  for(const status of [403,409,500,503]) {
    const fetcher=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>new Response(null,{status})}]);
    await assert.rejects(bucketFor(fetcher).get(SNAPSHOT_KEY),/could not return the object/);
  }
});

test('rejects a damaged or substituted download',async()=>{
  const damaged=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>downloadReply(BODY,{sha1:sha1Of('tampered')})}]);
  await assert.rejects(bucketFor(damaged).get(SNAPSHOT_KEY),/damaged object/);
  const missingSha=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>downloadReply(BODY,{sha1:'none'})}]);
  await assert.rejects(bucketFor(missingSha).get(SNAPSHOT_KEY),/damaged object/);
  const swapped=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>downloadReply(BODY,{key:'snapshots/other.json'})}]);
  await assert.rejects(bucketFor(swapped).get(SNAPSHOT_KEY),/unexpected object/);
  const badId=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>downloadReply(BODY,{fileId:'4_z bad id'})}]);
  await assert.rejects(bucketFor(badId).get(SNAPSHOT_KEY),/unexpected object/);
});

test('lists exact versions and pages with the cursor it returned',async()=>{
  const second='snapshots/2026-09-06T12-00-00.000Z-11112222.json';
  const fetcher=fakeFetch([
    authorizeRoute(),
    {match:'b2_list_file_versions',once:true,reply:()=>jsonReply({files:[
      {fileName:SNAPSHOT_KEY,fileId:FILE_ID,action:'upload',uploadTimestamp:UPLOADED_MS,contentLength:37,fileInfo:{sha256:DIGEST}},
      {fileName:SNAPSHOT_KEY,fileId:FILE_ID+'x',action:'hide',uploadTimestamp:UPLOADED_MS+1000,contentLength:0,fileInfo:{}}
    ],nextFileName:second,nextFileId:FILE_ID+'y'})},
    {match:'b2_list_file_versions',reply:()=>jsonReply({files:[
      {fileName:second,fileId:FILE_ID+'y',action:'upload',uploadTimestamp:EARLIER_MS,contentLength:37,fileInfo:{}}
    ],nextFileName:null,nextFileId:null})}
  ]);
  const bucket=bucketFor(fetcher);
  const first=await bucket.listVersions({prefix:'snapshots/',limit:2});
  assert.deepEqual(first.versions.map(v=>[v.key,v.fileId,v.action,v.uploadedAt]),[
    [SNAPSHOT_KEY,FILE_ID,'upload',UPLOADED_AT],
    [SNAPSHOT_KEY,FILE_ID+'x','hide','2026-09-07T12:00:01.000Z']
  ]);
  assert.equal(first.versions[0].customMetadata.sha256,DIGEST);
  assert.deepEqual(first.cursor,{startFileName:second,startFileId:FILE_ID+'y'});

  const last=await bucket.listVersions({prefix:'snapshots/',limit:2,cursor:first.cursor});
  assert.equal(last.cursor,null);
  const query=new URL(fetcher.calls.at(-1).url).searchParams;
  assert.equal(query.get('bucketId'),BUCKET_ID);
  assert.equal(query.get('prefix'),'snapshots/');
  assert.equal(query.get('maxFileCount'),'2');
  assert.equal(query.get('startFileName'),second);
  assert.equal(query.get('startFileId'),FILE_ID+'y');
});

test('refuses a listing it cannot fully validate',async()=>{
  const listings=[
    {files:[{fileName:SNAPSHOT_KEY,fileId:'',action:'upload',uploadTimestamp:UPLOADED_MS}]},
    {files:[{fileName:SNAPSHOT_KEY,fileId:FILE_ID,action:'upload'}]},
    {files:[{fileName:'private/other.json',fileId:FILE_ID,action:'upload',uploadTimestamp:UPLOADED_MS}]},
    {files:[{fileName:'snapshots/notes.txt',fileId:FILE_ID,action:'upload',uploadTimestamp:UPLOADED_MS}]},
    {files:[{fileName:SNAPSHOT_KEY,fileId:FILE_ID,action:'folder',uploadTimestamp:UPLOADED_MS}]},
    {files:'all'},
    {files:[],nextFileName:'recovery/current.json'},
    {files:[],nextFileName:SNAPSHOT_KEY,nextFileId:'not a file id'},
    {files:[],nextFileName:null,nextFileId:FILE_ID},
    {files:[{fileName:SNAPSHOT_KEY,fileId:FILE_ID,action:'upload',uploadTimestamp:Number.MAX_SAFE_INTEGER}]}
  ];
  for(const listing of listings) {
    const fetcher=fakeFetch([authorizeRoute(),{match:'b2_list_file_versions',reply:()=>jsonReply(listing)}]);
    await assert.rejects(bucketFor(fetcher).listVersions({prefix:'snapshots/',limit:2}),/unusable listing/);
  }
  const oversized=fakeFetch([authorizeRoute(),{match:'b2_list_file_versions',reply:()=>jsonReply({files:[
    {fileName:SNAPSHOT_KEY,fileId:FILE_ID,action:'upload',uploadTimestamp:UPLOADED_MS},
    {fileName:SNAPSHOT_KEY,fileId:FILE_ID+'x',action:'upload',uploadTimestamp:UPLOADED_MS+1000}
  ],nextFileName:null})}]);
  await assert.rejects(bucketFor(oversized).listVersions({prefix:'snapshots/',limit:1}),/unusable listing/);
  const repeating=fakeFetch([authorizeRoute(),{match:'b2_list_file_versions',reply:()=>jsonReply({files:[],nextFileName:SNAPSHOT_KEY,nextFileId:FILE_ID})}]);
  await assert.rejects(repeating.calls&&bucketFor(repeating).listVersions({prefix:'snapshots/',limit:2,cursor:{startFileName:SNAPSHOT_KEY,startFileId:FILE_ID}}),/repeating listing cursor/);
});

test('deletes the exact version and never hides a file',async()=>{
  const fetcher=fakeFetch([
    authorizeRoute(),
    {match:'b2_delete_file_version',method:'POST',reply:()=>jsonReply({fileId:FILE_ID,fileName:SNAPSHOT_KEY})}
  ]);
  const result=await bucketFor(fetcher).deleteVersion({key:SNAPSHOT_KEY,fileId:FILE_ID});
  assert.deepEqual(result,{key:SNAPSHOT_KEY,fileId:FILE_ID,deleted:true});
  const call=fetcher.calls.at(-1);
  assert.equal(call.url,`${API_HOST}/b2api/v4/b2_delete_file_version`);
  assert.deepEqual(JSON.parse(call.body),{fileName:SNAPSHOT_KEY,fileId:FILE_ID});
  assert.ok(!fetcher.calls.some(entry=>entry.url.includes('b2_hide_file')));

  const wrong=fakeFetch([authorizeRoute(),{match:'b2_delete_file_version',method:'POST',reply:()=>jsonReply({fileId:FILE_ID+'x',fileName:SNAPSHOT_KEY})}]);
  await assert.rejects(bucketFor(wrong).deleteVersion({key:SNAPSHOT_KEY,fileId:FILE_ID}),/removed a different version/);
  for(const request of [{key:SNAPSHOT_KEY},{key:SNAPSHOT_KEY,fileId:'has spaces'},{key:SNAPSHOT_KEY,fileId:FILE_ID,bypassGovernance:true}]) {
    const guarded=fakeFetch([authorizeRoute()]);
    await assert.rejects(bucketFor(guarded).deleteVersion(request),/exact version id/);
    assert.equal(guarded.calls.length,0);
  }
});

test('limits keys to snapshot and recovery JSON before any request',async()=>{
  const rejected=['private/applications.json','snapshots/notes.txt','snapshots/../secrets.json','snapshots//double.json','/snapshots/x.json','snapshots/.hidden.json','recovery/'+'a'.repeat(400)+'.json',''];
  for(const key of rejected) {
    const fetcher=fakeFetch([authorizeRoute()]);
    const bucket=bucketFor(fetcher);
    await assert.rejects(bucket.get(key),/snapshot and recovery JSON/);
    await assert.rejects(bucket.put(key,BODY),/snapshot and recovery JSON/);
    await assert.rejects(bucket.deleteVersion({key,fileId:FILE_ID}),/snapshot and recovery JSON/);
    assert.equal(fetcher.calls.length,0);
  }
  for(const prefix of ['private/','snapshots/../','/snapshots/',undefined]) {
    const fetcher=fakeFetch([authorizeRoute()]);
    await assert.rejects(bucketFor(fetcher).listVersions({prefix}),/snapshot and recovery prefixes/);
    assert.equal(fetcher.calls.length,0);
  }
  const badMetadata=fakeFetch([authorizeRoute()]);
  await assert.rejects(bucketFor(badMetadata).put(SNAPSHOT_KEY,BODY,{customMetadata:{SHA256:DIGEST}}),/named text values/);
  await assert.rejects(bucketFor(badMetadata).put(SNAPSHOT_KEY,BODY,{customMetadata:{sha256:12}}),/named text values/);
  await assert.rejects(bucketFor(badMetadata).put(SNAPSHOT_KEY,BODY,{httpMetadata:{}}),/Unexpected private backup option/);
  assert.equal(badMetadata.calls.length,0);
});

test('refuses oversized objects and oversized provider responses',async()=>{
  const tooLarge=fakeFetch([authorizeRoute()]);
  await assert.rejects(bucketFor(tooLarge).put(SNAPSHOT_KEY,'a'.repeat((16<<20)+1)),/larger than the supported object size/);
  assert.equal(tooLarge.calls.length,0);

  const declared=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>new Response(new Uint8Array(4),{status:200,headers:{'content-length':String((16<<20)+1)}})}]);
  await assert.rejects(bucketFor(declared).get(SNAPSHOT_KEY),/oversized response/);

  const streamed=fakeFetch([{match:'b2_authorize_account',reply:()=>new Response(new ReadableStream({start(controller) {
    for(let index=0;index<12;index++)controller.enqueue(new TextEncoder().encode('x'.repeat(100000)));
    controller.close();
  }}),{status:200})}]);
  await assert.rejects(bucketFor(streamed).get(SNAPSHOT_KEY),/oversized response/);
});

test('never repeats provider error text and re-authorizes at most once',async()=>{
  const leaky=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>new Response(JSON.stringify({status:500,code:'internal_error',message:`key ${APP_KEY} for bucket ${BUCKET_ID} failed`}),{status:500})}]);
  const failure=await bucketFor(leaky).get(SNAPSHOT_KEY).then(()=>null,error=>error);
  assert.match(failure.message,/^Private backup storage could not return the object\.$/);
  assert.ok(!failure.message.includes(APP_KEY)&&!failure.message.includes(BUCKET_ID)&&!failure.message.includes('internal_error'));

  const expired=fakeFetch([
    authorizeRoute(),
    {match:'/file/',once:true,reply:()=>new Response(null,{status:401})},
    {match:'/file/',reply:()=>downloadReply(BODY)}
  ]);
  assert.equal(await (await bucketFor(expired).get(SNAPSHOT_KEY)).text(),BODY);
  assert.equal(expired.calls.filter(call=>call.url.includes('b2_authorize_account')).length,2);

  const alwaysExpired=fakeFetch([authorizeRoute(),{match:'/file/',reply:()=>new Response(null,{status:401})}]);
  await assert.rejects(bucketFor(alwaysExpired).get(SNAPSHOT_KEY),/refused the authorized request/);
  assert.equal(alwaysExpired.calls.length,4);
});

test('refuses an unconfigured or unusable storage binding',async()=>{
  for(const encryption of [null,{mode:'none'},{mode:'SSE-B2',algorithm:'AES128'},{mode:'SSE-C',algorithm:'AES256'}]) {
    const fetcher=fakeFetch([
      authorizeRoute(),
      {match:'b2_get_upload_url',reply:()=>jsonReply({bucketId:BUCKET_ID,uploadUrl:UPLOAD_URL,authorizationToken:'upload-token'})},
      {match:'b2_upload_file',method:'POST',reply:()=>uploadedReply({encryption})}
    ]);
    await assert.rejects(bucketFor(fetcher).put(SNAPSHOT_KEY,BODY),/did not confirm managed encryption/);
  }
  for(const override of [{keyId:''},{applicationKey:'has spaces'},{bucketId:'not-hex'},{bucketName:'Not_A_Bucket'},{fetcher:null}]) {
    assert.throws(()=>createBackblazeBucket({keyId:KEY_ID,applicationKey:APP_KEY,bucketId:BUCKET_ID,bucketName:BUCKET_NAME,fetcher:fakeFetch([]),...override}),/not configured/);
  }
});
