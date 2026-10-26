import type { SourceActor, ChangesetReceipt, TreeEntry } from "./contracts";
import {
  createChangeset, getChangeset, listChangesets, approveChangeset, advanceReference, getObject, getTree,
} from "./service";

// These are contracts implemented by the production PostgreSQL service, not mocks.
export interface ChangesetStore {
  create(repositoryId: string, actor: SourceActor, input: unknown): Promise<ChangesetReceipt>;
  get(repositoryId: string, changesetId: string): ReturnType<typeof getChangeset>;
  list(repositoryId: string, limit?: number): ReturnType<typeof listChangesets>;
}
export interface ImmutableObjectStore {
  read(repositoryId: string, objectId: string): Promise<{ id: string; kind: "BLOB" | "TREE"; byteSize: number; dataBase64: string }>;
  tree(repositoryId: string, changesetId: string): Promise<{ changesetId: string; treeId: string | null; entries: (TreeEntry & { mode?: string })[] }>;
}
export interface ReferenceManager {
  compareAndSwap(repositoryId: string, name: string, changesetId: string, expectedGeneration: number | null, actorId: string):
    ReturnType<typeof advanceReference>;
}
export interface ReviewApprovalStore {
  approve(repositoryId: string, changesetId: string, ownerId: string): ReturnType<typeof approveChangeset>;
}

export const changesetStore: ChangesetStore = {
  create: createChangeset,
  get: getChangeset,
  list: listChangesets,
};
export const immutableObjectStore: ImmutableObjectStore = {
  read: getObject,
  tree: getTree,
};
export const referenceManager: ReferenceManager = {
  compareAndSwap: advanceReference,
};
export const reviewApprovalStore: ReviewApprovalStore = {
  approve: approveChangeset,
};
