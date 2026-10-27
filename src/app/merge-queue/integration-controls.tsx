"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
type Props={repositoryId:string;refs?:string[];jobId?:string;status?:string;resultId?:string;compact?:boolean};
export default function IntegrationControls({repositoryId,refs=[],jobId,status,compact}:Props){
 const router=useRouter();
 const [source,setSource]=useState("");
 const [target,setTarget]=useState(refs[0]??"");
 const [resolution,setResolution]=useState("");
 const [environment,setEnvironment]=useState("production");
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const api="/api/v2/repositories/"+repositoryId+"/integrations";
 async function send(url:string,body?:unknown){
  setBusy(true);setMessage("");
  try{
   const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
     body:JSON.stringify(body??{})});
   const data=await response.json() as {error?:string;message?:string;ready?:boolean;validationState?:string};
   if(!response.ok)throw new Error(data.message??data.error??"Request failed");
   setMessage(data.ready===false?"Deployment checks queued; no deployment authorized":"Request accepted");
   router.refresh();
  }catch(error){setMessage(error instanceof Error?error.message:"Request failed");}
  finally{setBusy(false);}
 }
 if(compact&&jobId) return <div className="integration-actions">
  {["WAITING_CHECKS","WAITING_APPROVAL","FAILED","RETRY"].includes(status??"")?
   <button disabled={busy} onClick={()=>void send(api+"/"+jobId+"/retry")}>Retry / reauthorize</button>:null}
  {status==="INTEGRATED"?<>
   <button disabled={busy} onClick={()=>void send(api+"/"+jobId+"/deployment")}>Pre-deploy checks</button>
   <div className="integration-resolution">
    <input aria-label="Deployment environment" placeholder="Environment"
      value={environment} onChange={e=>setEnvironment(e.target.value)}/>
    <button disabled={busy||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(environment)}
      onClick={()=>void send("/api/v2/repositories/"+repositoryId+"/deployments",{
        integrationId:jobId,environment,requestKey:"deploy-"+crypto.randomUUID()})}>Deploy via controller</button>
   </div>
   <button disabled={busy} onClick={()=>void send(api+"/"+jobId+"/revert")}>Create revert</button>
  </>:null}
  {status==="CONFLICTED"?<div className="integration-resolution">
   <input aria-label="Revised immutable changeset ID" placeholder="Resolved changeset SHA-256"
    value={resolution} onChange={e=>setResolution(e.target.value)}/>
   <button disabled={busy||!/^[a-f0-9]{64}$/.test(resolution)}
    onClick={()=>void send(api+"/"+jobId+"/resolve",{sourceChangesetId:resolution,requestKey:"resolution-"+crypto.randomUUID()})}>Submit resolution</button>
  </div>:null}
  {message?<small className="integration-feedback" role="status">{message}</small>:null}
 </div>;
 return <form className="integration-submit" onSubmit={e=>{
  e.preventDefault();void send(api,{sourceChangesetId:source,targetRef:target,requestKey:"merge-"+crypto.randomUUID()});
 }}>
  <div><label htmlFor="integration-source">Immutable changeset ID</label>
   <input id="integration-source" placeholder="64-character SHA-256 revision" value={source}
     onChange={e=>setSource(e.target.value)} required pattern="[a-f0-9]{64}"/></div>
  <div><label htmlFor="integration-target">Target branch</label>
   <select id="integration-target" value={target} onChange={e=>setTarget(e.target.value)}>
    {refs.map(r=><option key={r} value={r}>{r}</option>)}</select></div>
  <button disabled={busy||!/^[a-f0-9]{64}$/.test(source)||!target} type="submit">Queue integration</button>
  {message?<span role="status">{message}</span>:null}
 </form>;
}
