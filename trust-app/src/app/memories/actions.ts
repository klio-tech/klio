"use server";

import { api, type Entry, type EntryKind } from "@/lib/api";

export type RecallResult = { entries: Entry[] };

export async function runRecall(args: {
  spaceId: string;
  query: string;
  kind?: EntryKind;
  limit?: number;
}): Promise<RecallResult> {
  const entries = await api.recall(args.spaceId, {
    query: args.query,
    kind: args.kind,
    limit: args.limit,
  });
  return { entries };
}
