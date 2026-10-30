/**
 * Creates a disposable, authorized repository seeded with real, distinct
 * verified BLOB objects. No pre-existing production repository is mutated.
 * The output contains UUIDs, not raw login credentials or bearer tokens.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "../../src/lib/prisma";
import { tokenHash } from "../../src/lib/auth";
import { stageCanonicalBlob } from "../../src/source-control/canonical";

const output = process.argv.find(x => x.startsWith("--output="))?.slice(9);
if (!output || !process.env.DEVHUB_QUALIFICATION_ISOLATED ||
    process.env.DEVHUB_QUALIFICATION_ISOLATED !== "YES")
  throw new Error("Require --output and DEVHUB_QUALIFICATION_ISOLATED=YES");
const suffix = randomBytes(8).toString("hex");
const user = await db.user.create({data:{handle:"qual-"+suffix,email:"qual-"+suffix+"@example.invalid"}});
const session = await db.humanSession.create({data:{userId:user.id,
  tokenHash:tokenHash(randomBytes(32).toString("hex")),expiresAt:new Date(Date.now()+72*3600000)}});
const repository = await db.repository.create({data:{ownerId:user.id,slug:"qual-"+suffix,name:"Isolated qualification "+suffix,
  requireHumanApproval:false,maxStoredBytes:BigInt(10*1024*1024*1024)}});
const scopes = ["changeset:write","source:read","ref:update"];
const agent = await db.agentIdentity.create({data:{ownerId:user.id,name:"scale-"+suffix,scopes}});
const raw = randomBytes(32).toString("hex");
const expiresAt = new Date(Date.now()+72*3600000);
const credential = await db.agentCredential.create({data:{agentId:agent.id,
  tokenHash:tokenHash(raw),label:"ephemeral-scale",scopes,expiresAt}});
await db.agentDelegation.create({data:{repositoryId:repository.id,agentId:agent.id,
  delegatedBy:user.id,scopes,expiresAt}});
const human = {type:"HUMAN" as const,id:user.id,sessionId:session.id};
const objectIds: string[] = [];
try {
  for (let i = 0; i < 16; i++) {
    const bytes = Buffer.concat([Buffer.from("qualification-content-"+suffix+"-"+i+"\n"),randomBytes(512)]);
    const blob = await stageCanonicalBlob(repository.id,human,bytes.toString("base64"));
    objectIds.push(blob.id);
  }
  const seed = {repositoryId:repository.id,actorId:agent.id,credentialId:credential.id,
    objectIds,createdAt:new Date().toISOString(),disposable:true};
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(seed,null,2)+"\n",{mode:0o600,flag:"wx"});
  process.stdout.write(JSON.stringify({repositoryId:repository.id,objectsStaged:objectIds.length,
    seedPath:output})+"\n");
} catch(error) {
  console.error("Fixture setup failed; repository preserved for investigation:",repository.id);
  throw error;
} finally {
  await db.$disconnect();
}
