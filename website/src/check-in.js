(() => {
  const form=document.querySelector('#check-in-form');if(!form)return;
  const status=document.querySelector('#check-in-status'),confirmation=document.querySelector('#check-in-confirmation'),button=form.querySelector('button');
  const token=location.hash.slice(1);let id=crypto.randomUUID(),lastPayload=null,config,fields=[];
  async function api(method,body){
    const response=await fetch('/api/check-in',{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(!response.ok){const error=new Error(data.error);error.userMessage=true;error.fields=data.fields;throw error;}return data;
  }
  function showError(message){status.textContent=message;status.setAttribute('role','alert');}
  Promise.all([fetch('/check-in-config.json').then(r=>r.json()),api('GET')]).then(([content,request])=>{
    config=content;fields=request.fields;
    document.querySelector('#check-in-title').textContent=request.kind==='final'?config.copy.finalTitle:config.copy.title;
    if(request.period===3){const p=document.createElement('p');p.textContent=config.copy.firstPeriod;form.before(p);}
    const questions=config.questions[request.kind==='final'?request.role:'quarterly'];
    fields.forEach((name,i)=>{
      const li=document.createElement('li');
      if(name==='contact'){
        const group=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=questions[i];group.append(legend);
        for(const [value,text] of [['true','Yes'],['false','No']]){
          const label=document.createElement('label'),input=document.createElement('input');input.type='radio';input.name=name;input.value=value;label.append(input,document.createTextNode(' '+text));group.append(label);
        }li.append(group);
      }else{
        const label=document.createElement('label'),input=document.createElement(name==='meetings'?'input':'textarea');
        input.name=name;input.id='answer-'+name;label.htmlFor=input.id;label.textContent=questions[i];
        if(name==='meetings'){input.type='number';input.min='0';input.step='1';}else{input.rows=4;input.maxLength=6000;}
        li.append(label,input);
      }
      document.querySelector('#check-in-questions').append(li);
    });
    status.textContent='';form.hidden=false;button.disabled=false;
  }).catch(()=>showError('This check-in link is unavailable. Please contact the Mentorship Chair.'));
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(button.disabled||!form.reportValidity())return;
    for(const error of form.querySelectorAll('[data-field-error]'))error.remove();
    for(const input of form.querySelectorAll('[aria-invalid]')){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}
    const answers={};for(const name of fields){const value=new FormData(form).get(name);if(value===null||value.trim()==='')continue;answers[name]=name==='meetings'?Number(value):name==='contact'?value==='true':value;}
    const payload=JSON.stringify(answers);
    // Retry identical answers with the original key. Edited answers are a new
    // correction, including after a successful save whose response was lost.
    if(lastPayload!==null&&lastPayload!==payload)id=crypto.randomUUID();
    lastPayload=payload;
    button.disabled=true;status.setAttribute('role','status');status.textContent=config.copy.saving;
    try{
      const result=await api('POST',{id,answers});
      if(!result.saved)throw new Error(config.copy.failed);
      confirmation.querySelector('h2').textContent=result.complete?config.copy.completeTitle:config.copy.partialTitle;
      confirmation.querySelector('p').textContent=result.complete?config.copy.complete:config.copy.partial;
      confirmation.querySelector('button').hidden=result.complete;
      form.hidden=true;confirmation.hidden=false;status.textContent='';confirmation.querySelector('h2').focus();
    }catch(error){
      showError(error.userMessage?error.message:config.copy.failed);
      let first;for(const [name,message] of Object.entries(error.fields??{})){
        const input=form.elements.namedItem(name);if(!(input instanceof HTMLElement))continue;
        const note=document.createElement('p');note.dataset.fieldError='';note.id='error-'+name;note.textContent=message;input.after(note);input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',note.id);first??=input;
      }first?.focus();
    }finally{button.disabled=false;}
  });
  confirmation.querySelector('button').addEventListener('click',()=>{id=crypto.randomUUID();lastPayload=null;form.reset();confirmation.hidden=true;form.hidden=false;form.querySelector('input,textarea')?.focus();});
})();
