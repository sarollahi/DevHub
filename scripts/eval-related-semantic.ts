import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cosineSimilarity } from "../src/review/analysis";
import { vectorBuckets } from "../src/review/index-algorithms";
import { createEmbeddingProvider } from "../src/review/embedding-provider";

// Explicit labels represent shared engineering intent, not merely overlapping words.
// Closely related but different intents in other groups are hard negatives.
const examples = (JSON.parse(readFileSync(new URL("../tests/fixtures/related-semantic.json",import.meta.url),"utf8")) as
  Array<{label:string;text:string}>).map(x=>[x.label,x.text] as const);

const arg = (name: string, fallback: string) =>
  process.argv.find(x => x.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback;
const mode = arg("mode", "lexical");
if (!["lexical", "provider", "model"].includes(mode)) throw new Error("Unsupported --mode");
const output = arg("output", "reports/related-semantic-" + mode + ".json");
const threshold = Number(arg("threshold", "0.50"));
const modelFile = arg("vectors", "reports/related-semantic-model-vectors.json");
const prepared = mode==="model" ? JSON.parse(readFileSync(modelFile,"utf8")) as
  { provider:string;model:string;modelRevision?:string;vectors:number[][] } : null;
if (!(threshold > 0 && threshold <= 1)) throw new Error("Invalid threshold");
const tokenizer = (text: string) => text.toLowerCase()
  .replace(/([a-z])([A-Z])/g, "$1 $2").match(/[a-z][a-z0-9]+/g) ?? [];
// This offline TF-IDF-style lexical feature map exists only as a reproducible
// baseline. Never describe its metrics as an external semantic model's accuracy.
const words = examples.map(([,text]) => [...new Set(tokenizer(text))]);
const vocabulary = [...new Set(words.flat())].sort();
const lexical = words.map(tokens => {
  const d = new Set(tokens);
  const weights = vocabulary.map(word => {
    const documents = words.reduce((n, line) => n + Number(line.includes(word)), 0);
    return d.has(word) ? Math.log((examples.length + 1) / (documents + 1)) + 1 : 0;
  });
  const norm = Math.hypot(...weights);
  return weights.map(x => norm ? x / norm : 0);
});
const pctl = (values: number[]) => {
  const ordered = [...values].sort((a,b) => a-b);
  return { p50: ordered[Math.ceil(ordered.length*.5)-1]??null,
    p95: ordered[Math.ceil(ordered.length*.95)-1]??null,
    p99: ordered[Math.ceil(ordered.length*.99)-1]??null };
};
async function main() {
  const provider = mode==="provider" ? createEmbeddingProvider() : null;
  if(mode==="provider"&&!provider)throw new Error("Provider evaluation requires a configured embedding endpoint and model");
  const vectors:number[][]=[],latencies:number[]=[];
  let costMicros=0n, tokens=0;
  for(let i=0;i<examples.length;i++){
    const began=performance.now();
    if(prepared) {
      const value=prepared.vectors[i];
      if(!value||!value.length||!value.every(Number.isFinite))throw new Error("Missing or invalid evaluated model vector");
      vectors.push(value);
    } else if(provider){
      const response=await provider.embed(examples[i][1]);
      vectors.push(response.vector);costMicros+=response.costMicros;
      tokens+=response.tokens??0;
    } else vectors.push(lexical[i]);
    latencies.push(performance.now()-began);
  }
  if(prepared && prepared.vectors.length!==examples.length)throw new Error("Embedding count does not match labeled corpus");
  const dimension=vectors[0]?.length;
  if (!dimension || vectors.some(v=>v.length!==dimension))throw new Error("Inconsistent provider dimensions");
  const namespace=provider?(provider.provider+":"+provider.model):
    prepared?(prepared.provider+":"+prepared.model+":"+prepared.modelRevision):"offline-tfidf-baseline";
  const stored=vectors.map(v=>new Set(vectorBuckets(v,namespace)));
  const probe=vectors.map(v=>new Set(vectorBuckets(v,namespace,true)));
  const labels=examples.map(([group])=>group);
  let truePositive=0,falsePositive=0,falseNegative=0,trueNegative=0;
  let foundPositiveCandidates=0,allPositivePairs=0;
  const queryLatencyMs:number[]=[];
  for(let i=0;i<examples.length;i++){
    const began=performance.now();
    for(let j=0;j<examples.length;j++){
      if(i===j)continue;
      const positive=labels[i]===labels[j];
      const candidate=[...probe[i]].some(key=>stored[j].has(key));
      if(positive) {allPositivePairs++;if(candidate)foundPositiveCandidates++;}
      const predicted=candidate&&cosineSimilarity(vectors[i],vectors[j])>=threshold;
      if(predicted&&positive)truePositive++;
      else if(predicted&&!positive)falsePositive++;
      else if(!predicted&&positive)falseNegative++;
      else trueNegative++;
    }
    queryLatencyMs.push(performance.now()-began);
  }
  const precision = truePositive+falsePositive?truePositive/(truePositive+falsePositive):0;
  const recall = truePositive+falseNegative?truePositive/(truePositive+falseNegative):0;
  const report={
    evaluation: "Labeled engineering-intent pairs; ANN multi-probe and cosine threshold",
    mode, provider:provider?.provider??prepared?.provider??null,model:provider?.model??prepared?.model??null,
    modelRevision:prepared?.modelRevision??null,
    samples:examples.length,groups:new Set(labels).size,dimensions:dimension,threshold,
    labels: "human-authored fixed fixture groups with closely related hard negatives",
    truePositive,falsePositive,falseNegative,trueNegative,
    precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0,
    candidateRecall:allPositivePairs?foundPositiveCandidates/allPositivePairs:0,
    embeddingLatencyMs:prepared?null:pctl(latencies),annQueryLatencyMs:pctl(queryLatencyMs),
    reportedProviderTokens:provider?tokens:null,
    providerCostUsd:provider?Number(costMicros)/1e6:null,
    limitations:mode==="lexical"?
      ["This is an offline lexical baseline, not evidence of a neural semantic model.", "Labels comprise only a small fixed engineering-domain fixture."]:
      ["Provider/model accuracy is measured only on the fixed authored examples, not production distributions.",
       "Costs are operator-priced and may omit provider billing outside this run."],
    environment:{commit:process.env.GITHUB_SHA??null,ci:process.env.GITHUB_ACTIONS==="true"},
  };
  await mkdir(output.split("/").slice(0,-1).join("/")||".",{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
