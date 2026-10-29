type EmbeddingResult = { vector:number[];tokens:number|null;costMicros:bigint;provider:string;model:string };
export interface EmbeddingProvider {
  readonly provider:string;
  readonly model:string;
  embed(input:string):Promise<EmbeddingResult>;
}
export function createEmbeddingProvider():EmbeddingProvider|null {
  const endpoint=process.env.DEVHUB_EMBEDDING_ENDPOINT ?? process.env.DEVHUB_REVIEW_EMBEDDING_ENDPOINT;
  const model=process.env.DEVHUB_EMBEDDING_MODEL ?? process.env.DEVHUB_REVIEW_EMBEDDING_MODEL;
  if(!endpoint && !model)return null;
  if(!endpoint||!model)throw new Error("Both embedding endpoint and model are required");
  const url=new URL(endpoint);
  if(url.protocol!=="https:" && !(process.env.NODE_ENV!=="production" &&
    url.protocol==="http:" && ["localhost","127.0.0.1","::1"].includes(url.hostname)))
    throw new Error("Embedding endpoint requires HTTPS");
  const adapter=process.env.DEVHUB_EMBEDDING_PROVIDER ?? "openai-compatible";
  if(adapter!=="openai-compatible") throw new Error("Unknown embedding adapter: "+adapter);
  const cost=Number(process.env.DEVHUB_EMBEDDING_USD_PER_MILLION_TOKENS ?? "0");
  if(!Number.isFinite(cost)||cost<0)throw new Error("Invalid embedding price");
  const key=process.env.DEVHUB_EMBEDDING_API_KEY ?? process.env.DEVHUB_REVIEW_API_KEY;
  return {provider:adapter+":"+url.host,model,async embed(input) {
    const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",
      ...(key?{authorization:"Bearer "+key}:{})},
      body:JSON.stringify({model,input:input.slice(0,16000)}),signal:AbortSignal.timeout(18000)});
    if(!response.ok) throw new Error("Embedding provider HTTP "+response.status);
    const body=await response.text();
    if(body.length>250000)throw new Error("Oversized embedding response");
    const parsed=JSON.parse(body) as {data?:Array<{embedding?:number[]}>;usage?:{total_tokens?:number}};
    const vector=parsed.data?.[0]?.embedding;
    if(!Array.isArray(vector)||!vector.length||vector.length>4096||
      !vector.every(x=>typeof x==="number"&&Number.isFinite(x))||vector.every(x=>x===0))
      throw new Error("Invalid embedding vector");
    const tokens=parsed.usage?.total_tokens;
    const consumed=typeof tokens==="number"&&Number.isFinite(tokens)&&tokens>=0?Math.floor(tokens):null;
    return {vector,tokens:consumed,costMicros:BigInt(Math.round((consumed??0)*cost)),
      provider:adapter+":"+url.host,model};
  }};
}
