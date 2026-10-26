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
  getObject(id: string) { return this.request<{ kind: "BLOB" | "TREE"; dataBase64: string }>(`/objects/${id}`); }
  createChangeset(input: ChangesetInput) {
    return this.request<ChangesetReceipt>("/changesets", { method: "POST", body: JSON.stringify(input) });
  }
  approve(id: string) { return this.request<{ approved: boolean }>(`/changesets/${id}/approve`, { method: "POST" }); }
  updateRef(name: string, changesetId: string, expectedGeneration: number | null) {
    return this.request<{ ref: { name: string; generation: number; changesetId: string } }>(
      `/refs/${name.split("/").map(encodeURIComponent).join("/")}`,
      { method: "PUT", body: JSON.stringify({ changesetId, expectedGeneration }) },
    );
  }
}
