"use client";
import { useEffect, useState } from "react";
export default function LogViewer({endpoint}:{endpoint:string}){
  const [open,setOpen]=useState(false),[logs,setLogs]=useState("");
  useEffect(()=>{
    if(!open)return;
    const connection=new EventSource(endpoint+"?stream=1");
    const receive=(event:Event)=>{
      const entry=JSON.parse((event as MessageEvent).data) as {content:string};
      setLogs(before=>(before+entry.content).slice(-200000));
    };
    connection.addEventListener("log",receive);
    connection.addEventListener("done",()=>connection.close());
    return ()=>connection.close();
  },[endpoint,open]);
  return <div>
    <button type="button" className="text-link" onClick={()=>setOpen(v=>!v)}>
      {open?"Hide execution log":"Stream execution log"}</button>
    {open&&<pre className="diff" aria-live="polite">{logs||"No output available."}</pre>}
  </div>;
}
