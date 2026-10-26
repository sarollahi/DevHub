import type { ChangesetInput, ChangesetReceipt, TreeEntry } from "./contracts";

// Workspace clients exchange immutable content and conditionally update references.
// All IDs and generation checks are validated again by the server.
export class SourceWorkspace {
  constructor(private baseUrl: string, private repositoryId: string, private token: string) {}
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/repositories/${this.repositoryId}${path}`, {
      ...init, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok) throw new Error(`Source-control API returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.json() as Promise<T>;
  }
  listRefs() { return this.request<{ records: { name: string; changesetId: string; generation: number }[] }>("/refs"); }
  listChangesets() { return this.request<{ records: { id: string; treeId: string; message: string }[] }>("/changesets"); }
  getTree(id: string) { return this.request<{ treeId: string; entries: TreeEntry[] }>(`/changesets/${id}/tree`); }
  async uploadObject(body: BodyInit, expectedId?: string) {
    const response = await fetch(this.baseUrl.replace(/\/$/, "") + "/api/v1/repositories/" +
      this.repositoryId + "/objects", {
      method: "POST", body,
      headers: { authorization: "Bearer " + this.token, "content-type": "application/octet-stream",
        ...(expectedId ? { "x-expected-object-id": expectedId } : {}) },
      duplex: "half",
    } as RequestInit & { duplex: string });
    if (!response.ok) throw new Error("Object upload failed: " + response.status);
    return response.json() as Promise<{ id: string; rawBytes: string; storedBytes: string; deduplicated: boolean }>;
  }
  async downloadObject(id: string) {
    const response = await fetch(this.baseUrl.replace(/\/$/, "") + "/api/v1/repositories/" +
      this.repositoryId + "/objects/" + encodeURIComponent(id) + "/content", {
      headers: { authorization: "Bearer " + this.token },
    });
    if (!response.ok) throw new Error("Object download failed: " + response.status);
    return response;
  }
  getObject(id: string) { return this.request<{ kind: "BLOB" | "TREE"; dataBase64: string }>(`/objects/${id}`); }
  createChangeset(input: ChangesetInput) {
    return this.request<ChangesetReceipt>("/changesets", { method: "POST", body: JSON.stringify(input) });
  }
  approve(id: string) { return this.request<{ approved: boolean }>(`/changesets/${id}/approve`, { method: "POST" }); }
  // Pass the same mutationId across network retries. A different ID denotes a
  // new intention and must carry a freshly observed generation.
  updateRef(name: string, changesetId: string, expectedGeneration: number | null, mutationId: string,
    options: { expectedChangesetId?: string; force?: boolean; reason?: string } = {}) {
    return this.request<{ ref: { name: string; generation: number; changesetId: string | null }; replayed: boolean; eventId: string }>(
      `/refs/${name.split("/").map(encodeURIComponent).join("/")}`,
      { method: "PUT", body: JSON.stringify({ changesetId, expectedGeneration, mutationId, ...options }) },
    );
  }
  deleteRef(name: string, expectedGeneration: number, mutationId: string, expectedChangesetId?: string) {
    return this.request<{ ref: { name: string; generation: number; deleted: boolean }; eventId: string }>(
      `/refs/${name.split("/").map(encodeURIComponent).join("/")}`,
      { method: "DELETE", body: JSON.stringify({ expectedGeneration, expectedChangesetId, mutationId }) },
    );
  }
  restoreRef(name: string, changesetId: string, expectedGeneration: number, mutationId: string) {
    return this.request<{ ref: { name: string; generation: number; deleted: boolean }; eventId: string }>(
      "/refs", { method: "POST", body: JSON.stringify({ name, changesetId, expectedGeneration, mutationId }) },
    );
  }
  refHistory(name: string, beforeGeneration?: number) {
    const params = new URLSearchParams({ name });
    if (beforeGeneration) params.set("beforeGeneration", String(beforeGeneration));
    return this.request<{ records: { mutationId: string; operation: string; newGeneration: number }[] }>(
      `/refs/history?${params.toString()}`);
  }
  refEvents() { return this.request<{ records: { id: string; name: string; operation: string }[] }>("/refs/events"); }
  setRefPolicy(settings: { name: string; protected: boolean; allowForce: boolean; allowDelete: boolean; requireApproval: boolean }) {
    return this.request<{ policy: typeof settings }>("/refs/policy", { method: "PUT", body: JSON.stringify(settings) });
  }
}
