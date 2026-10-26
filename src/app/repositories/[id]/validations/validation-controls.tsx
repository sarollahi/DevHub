"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
export default function ValidationControls({repositoryId}:{repositoryId:string}){
  const router=useRouter();
  const [changeset,setChangeset]=useState("");
  const [target,setTarget]=useState("");
  const [message,setMessage]=useState("");
  const [busy,start]=useTransition();
  function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    start(async()=>{
      try{
        const response=await fetch("/api/v2/repositories/"+repositoryId+"/validations",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({changesetId:changeset.trim(),targetChangesetId:target.trim()||null,
            idempotencyKey:crypto.randomUUID()})});
        const result=await response.json();
        if(!response.ok)throw new Error(result.message||result.error||"Validation rejected");
        setMessage("Queued "+result.id);router.refresh();
      }catch(error){setMessage(error instanceof Error?error.message:"Request failed");}
    });
  }
  return <form onSubmit={submit} className="login-form">
    <label>Changeset SHA-256<input aria-label="Native changeset" value={changeset}
      onChange={e=>setChangeset(e.target.value)} minLength={64} maxLength={64} required/></label>
    <label>Target changeset (optional)<input aria-label="Target changeset" value={target}
      onChange={e=>setTarget(e.target.value)} maxLength={64}/></label>
    <button className="primary-button" disabled={busy} type="submit">{busy?"Submitting…":"Run isolated checks"}</button>
    {message&&<p role="status">{message}</p>}
  </form>;
}
