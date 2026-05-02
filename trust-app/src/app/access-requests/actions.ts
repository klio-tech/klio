"use server";

import { revalidatePath } from "next/cache";

import { api } from "@/lib/api";

export async function decideAction(requestId: string, action: "approve" | "deny") {
  if (action === "approve") {
    await api.approveAccessRequest(requestId);
  } else {
    await api.denyAccessRequest(requestId);
  }
  revalidatePath("/access-requests");
}
