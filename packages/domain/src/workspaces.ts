export type WorkspaceType = 'PLATFORM' | 'SCHOOL';

/** A resolved administration workspace. School workspaces always carry their tenant. */
export type WorkspaceRef =
  | { type: 'PLATFORM'; workspaceId: string; schoolId: null }
  | { type: 'SCHOOL'; workspaceId: string; schoolId: string };

export function workspaceChainKey(ref: Pick<WorkspaceRef, 'type' | 'workspaceId'>): string {
  return `${ref.type}:${ref.workspaceId}`;
}
