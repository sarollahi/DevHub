import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

export class ObjectStorageError extends Error {
  constructor(message: string, readonly status = 503) { super(message); this.name = "ObjectStorageError"; }
}
export type StoredPart = { number: number; etag: string };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const uriEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, x => "%" + x.charCodeAt(0).toString(16).toUpperCase());
const xmlValue = (xml: string, tag: string) => {
  const match = new RegExp("<(?:[A-Za-z0-9]+:)?" + tag + ">([^<]*)</(?:[A-Za-z0-9]+:)?" + tag + ">").exec(xml);
  if (!match) throw new ObjectStorageError("Invalid object storage XML: missing " + tag, 502);
  return match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
};
const consumeText = async (response: IncomingMessage, max = 65536) => {
  let body = "";
  for await (const part of response) {
    body += Buffer.from(part).toString("utf8");
    if (body.length > max) throw new ObjectStorageError("Object storage response exceeded XML limit", 502);
  }
  return body;
};

export interface ObjectBackend {
  initiate(key: string): Promise<string>;
  part(key: string, uploadId: string, number: number, bytes: Buffer): Promise<StoredPart>;
  complete(key: string, uploadId: string, parts: StoredPart[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  get(key: string): Promise<IncomingMessage>;
  head(key: string): Promise<number | null>;
  copy(sourceKey: string, destinationKey: string, size: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class S3Backend implements ObjectBackend {
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly timeout: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (!env.OBJECT_STORE_ENDPOINT || !env.OBJECT_STORE_BUCKET ||
        !env.OBJECT_STORE_ACCESS_KEY || !env.OBJECT_STORE_SECRET_KEY) {
      throw new ObjectStorageError("S3 object storage is not configured", 503);
    }
    this.endpoint = new URL(env.OBJECT_STORE_ENDPOINT);
    if (!["http:", "https:"].includes(this.endpoint.protocol) || this.endpoint.search || this.endpoint.hash) {
      throw new ObjectStorageError("Invalid S3 endpoint", 503);
    }
    this.bucket = env.OBJECT_STORE_BUCKET;
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket)) throw new ObjectStorageError("Invalid S3 bucket", 503);
    this.region = env.OBJECT_STORE_REGION || "us-east-1";
    this.accessKey = env.OBJECT_STORE_ACCESS_KEY;
    this.secretKey = env.OBJECT_STORE_SECRET_KEY;
    this.timeout = Math.max(1000, Math.min(120000, Number(env.OBJECT_STORE_TIMEOUT_MS || 30000)));
  }

  private async call(method: string, key: string, query: Record<string, string> = {},
    extraHeaders: Record<string, string> = {}, body?: Buffer, retry = true): Promise<IncomingMessage> {
    const prefix = this.endpoint.pathname.replace(/\/+$/, "");
    const path = prefix + "/" + uriEncode(this.bucket) + "/" + key.split("/").map(uriEncode).join("/");
    const queryString = Object.keys(query).sort().map(k => uriEncode(k) + "=" + uriEncode(query[k])).join("&");
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8);
    const payloadHash = digest(body || Buffer.alloc(0));
    const headers: Record<string, string> = {
      host: this.endpoint.host,
      "x-amz-date": date,
      "x-amz-content-sha256": payloadHash,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const names = Object.keys(headers).sort();
    const canon = names.map(k => k + ":" + headers[k].trim().replace(/\s+/g, " ") + "\n").join("");
    const signed = names.join(";");
    const scope = day + "/" + this.region + "/s3/aws4_request";
    const canonical = [method, path, queryString, canon, signed, payloadHash].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", date, scope, digest(canonical)].join("\n");
    const signature = createHmac("sha256",
      hmac(hmac(hmac(hmac("AWS4" + this.secretKey, day), this.region), "s3"), "aws4_request"))
      .update(toSign).digest("hex");
    headers.authorization = "AWS4-HMAC-SHA256 Credential=" + this.accessKey + "/" + scope +
      ", SignedHeaders=" + signed + ", Signature=" + signature;
    if (body) headers["content-length"] = String(body.length);
    const attempts = retry ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          const fn = this.endpoint.protocol === "https:" ? httpsRequest : httpRequest;
          const req = fn(this.endpoint, {
            method, path: path + (queryString ? "?" + queryString : ""), headers,
            timeout: this.timeout,
          }, resolve);
          req.on("timeout", () => req.destroy(new Error("Object storage timeout")));
          req.on("error", reject);
          req.end(body);
        });
        if ((response.statusCode || 500) < 300) return response;
        const status = response.statusCode || 502;
        const detail = (await consumeText(response, 4096)).slice(0, 200);
        if (attempt < attempts - 1 && [408, 429, 500, 502, 503, 504].includes(status)) {
          await delay(150 * 2 ** attempt);
          continue;
        }
        throw new ObjectStorageError("S3 " + method + " failed (" + status + "): " + detail, status);
      } catch (e) {
        if (e instanceof ObjectStorageError && ![408, 429, 500, 502, 503, 504].includes(e.status)) throw e;
        if (attempt === attempts - 1) throw e;
        await delay(150 * 2 ** attempt);
      }
    }
    throw new ObjectStorageError("Unreachable S3 retry state");
  }

  async initiate(key: string) {
    return xmlValue(await consumeText(await this.call("POST", key, { uploads: "" })), "UploadId");
  }
  async part(key: string, uploadId: string, number: number, bytes: Buffer): Promise<StoredPart> {
    if (number < 1 || number > 10000) throw new ObjectStorageError("S3 part count exceeded", 413);
    const reply = await this.call("PUT", key, { partNumber: String(number), uploadId }, {}, bytes);
    const etag = reply.headers.etag;
    reply.resume();
    if (typeof etag !== "string") throw new ObjectStorageError("S3 omitted part ETag", 502);
    return { number, etag };
  }
  async complete(key: string, uploadId: string, parts: StoredPart[]) {
    const xml = "<CompleteMultipartUpload>" + parts.map(p =>
      "<Part><PartNumber>" + p.number + "</PartNumber><ETag>" + p.etag.replace(/&/g, "&amp;") +
      "</ETag></Part>").join("") + "</CompleteMultipartUpload>";
    const response = await this.call("POST", key, { uploadId },
      { "content-type": "application/xml" }, Buffer.from(xml));
    const result = await consumeText(response);
    if (/<Error>/.test(result)) throw new ObjectStorageError("S3 failed multipart completion: " + result.slice(0, 300), 502);
  }
  async abort(key: string, uploadId: string) {
    (await this.call("DELETE", key, { uploadId })).resume();
  }
  async get(key: string) { return this.call("GET", key); }
  async head(key: string) {
    try {
      const response = await this.call("HEAD", key);
      response.resume();
      const length = Number(response.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length < 0) throw new ObjectStorageError("S3 omitted object length", 502);
      return length;
    } catch (error) {
      if (error instanceof ObjectStorageError && error.status === 404) return null;
      throw error;
    }
  }
  async copy(sourceKey: string, destinationKey: string, size: number) {
    const source = "/" + uriEncode(this.bucket) + "/" + sourceKey.split("/").map(uriEncode).join("/");
    if (size <= 5_000_000_000) {
      const response = await this.call("PUT", destinationKey, {}, { "x-amz-copy-source": source });
      const result = await consumeText(response);
      if (/<Error>/.test(result)) throw new ObjectStorageError("S3 copy failed: " + result.slice(0, 300), 502);
      return;
    }
    const uploadId = await this.initiate(destinationKey);
    const parts: StoredPart[] = [];
    try {
      const partSize = 512 * 1024 * 1024;
      for (let start = 0, n = 1; start < size; start += partSize, n++) {
        const end = Math.min(size, start + partSize) - 1;
        const response = await this.call("PUT", destinationKey, { uploadId, partNumber: String(n) }, {
          "x-amz-copy-source": source,
          "x-amz-copy-source-range": "bytes=" + start + "-" + end,
        });
        const result = await consumeText(response);
        parts.push({ number: n, etag: xmlValue(result, "ETag") });
      }
      await this.complete(destinationKey, uploadId, parts);
    } catch (error) {
      await this.abort(destinationKey, uploadId).catch(() => {});
      throw error;
    }
  }
  async delete(key: string) { (await this.call("DELETE", key)).resume(); }
}

export const objectKey = (id: string) => "sha256/" + id.slice(0, 2) + "/" + id;
export const s3 = () => new S3Backend();
