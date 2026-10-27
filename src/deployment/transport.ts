import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { SourceControlError } from "../source-control/contracts";

export type Controller = { url: string; secretEnv: string; repositories: string[] };
export type Receipt = { deploymentId: string; revisionId: string; environment: string;
  state: "ACCEPTED" | "SUCCEEDED" | "FAILED"; receiptId: string };

export function getController(repositoryId: string, environment: string): { url: URL; secret: string } {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(environment))
    throw new SourceControlError(422, "INVALID_ENVIRONMENT", "Invalid environment");
  let input: Record<string,Controller>;
  try { input = JSON.parse(process.env.DEPLOYMENT_CONTROLLERS_JSON || "{}") as Record<string,Controller>; }
  catch { throw new SourceControlError(503, "DEPLOYMENT_CONFIG", "Deployment controller configuration is invalid"); }
  const config = Object.hasOwn(input, environment) ? input[environment] : undefined;
  if (!config || !Array.isArray(config.repositories) || !config.repositories.includes(repositoryId) ||
      !/^DEPLOYMENT_[A-Z0-9_]+_KEY$/.test(config.secretEnv ?? "")) {
    throw new SourceControlError(403, "DEPLOYMENT_NOT_CONFIGURED", "Environment is not enabled for repository");
  }
  let url: URL;
  try { url = new URL(config.url); }
  catch { throw new SourceControlError(503, "DEPLOYMENT_CONFIG", "Invalid controller URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      url.port && url.port !== "443" || !url.hostname.includes(".") || isIP(url.hostname) ||
      url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) {
    throw new SourceControlError(503, "DEPLOYMENT_CONFIG", "Deployment controller requires a public HTTPS hostname");
  }
  const secret = process.env[config.secretEnv];
  if (!secret || secret.length < 32) throw new SourceControlError(503, "DEPLOYMENT_CONFIG", "Deployment signing key is not configured");
  return { url, secret };
}
export const signature = (secret: string, bytes: string) =>
  createHmac("sha256",secret).update(bytes).digest("hex");
export function authenticSignature(secret: string, bytes: string, received: string | null): boolean {
  if (!received || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(signature(secret,bytes),"hex"),Buffer.from(received,"hex"));
}
function publicIp(ip: string): boolean {
  const version = isIP(ip);
  if (!version) return false;
  if (version === 6) {
    const low = ip.toLowerCase();
    return !(low === "::1" || low === "::" || low.startsWith("fe80:") ||
      low.startsWith("fc") || low.startsWith("fd") || low.startsWith("2001:db8:") ||
      low.startsWith("::ffff:"));
  }
  const n = ip.split(".").map(Number);
  return !(n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224 ||
    (n[0] === 100 && n[1] >= 64 && n[1] <= 127) ||
    (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
    (n[0] === 192 && n[1] === 168) || (n[0] === 192 && n[1] === 0) ||
    (n[0] === 198 && [18,19].includes(n[1])) || (n[0] === 192 && n[1] === 0) ||
    (n[0] === 192 && n[1] === 0 && n[2] === 2) ||
    (n[0] === 198 && n[1] === 51 && n[2] === 100) ||
    (n[0] === 203 && n[1] === 0 && n[2] === 113));
}
export function assertPublicAddress(ip: string) {
  if (!publicIp(ip)) throw new SourceControlError(503, "CONTROLLER_ADDRESS_REJECTED",
    "Controller address is non-public or unsupported");
}
export function validateReceipt(value: unknown, expected: { id:string; revisionId:string; environment:string }): Receipt {
  if (!value || typeof value !== "object") throw new SourceControlError(502,"INVALID_RECEIPT","Missing controller receipt");
  const v = value as Partial<Receipt>;
  if (v.deploymentId !== expected.id || v.revisionId !== expected.revisionId ||
      v.environment !== expected.environment || !["ACCEPTED","SUCCEEDED","FAILED"].includes(v.state ?? "") ||
      typeof v.receiptId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(v.receiptId)) {
    throw new SourceControlError(502,"INVALID_RECEIPT","Receipt does not match exact deployment identity");
  }
  return v as Receipt;
}

export async function sendDeployment(controller: {url:URL;secret:string}, command: string): Promise<{
  httpStatus:number; body:string; receiptSignature:string|null
}> {
  const addresses = await lookup(controller.url.hostname, { all:true });
  if (!addresses.length) throw new SourceControlError(503,"CONTROLLER_DNS","Controller DNS has no addresses");
  // Fail closed if *any* returned address is private, not just the first.
  for (const address of addresses) assertPublicAddress(address.address);
  const destination=addresses[0];
  return await new Promise((resolve,reject)=>{
    const req=https.request(controller.url,{
      method:"POST", rejectUnauthorized:true, timeout:15000, maxHeaderSize:8192,
      lookup: (_hostname, _options, callback) => callback(null,destination.address,destination.family),
      headers:{
        "content-type":"application/json",
        "content-length":Buffer.byteLength(command),
        "x-devhub-signature":signature(controller.secret,command),
        "x-devhub-protocol":"1",
      },
    },res=>{
      const bytes:Buffer[]=[];let size=0;
      res.on("data",(piece:Buffer)=>{
        size+=piece.byteLength;
        if(size>16_384){req.destroy(new Error("Oversized controller receipt"));return;}
        bytes.push(piece);
      });
      res.on("end",()=>resolve({
        httpStatus:res.statusCode??502,body:Buffer.concat(bytes).toString("utf8"),
        receiptSignature:String(res.headers["x-devhub-receipt-signature"]??""),
      }));
    });
    req.on("timeout",()=>req.destroy(new Error("Controller timeout")));
    req.on("error",reject);
    req.end(command);
  });
}
