type ConversationMessage = {
  id: string;
  replyToId: string | null;
  createdAtISO: string;
};

type ResponseMessage = ConversationMessage & {
  responseStatus: "saved" | "pending" | "completed" | "failed";
};

export function sortConversationMessages<T extends ConversationMessage>(messages: T[]): T[] {
  const byId = new Map(messages.map((message) => [message.id, message]));

  return [...messages].sort((a, b) => {
    const aRoot = a.replyToId ? byId.get(a.replyToId) : undefined;
    const bRoot = b.replyToId ? byId.get(b.replyToId) : undefined;
    const aRootTime = new Date(aRoot?.createdAtISO ?? a.createdAtISO).getTime();
    const bRootTime = new Date(bRoot?.createdAtISO ?? b.createdAtISO).getTime();

    if (aRootTime !== bRootTime) return aRootTime - bRootTime;

    const aThreadId = a.replyToId ?? a.id;
    const bThreadId = b.replyToId ?? b.id;
    if (aThreadId !== bThreadId) return aThreadId.localeCompare(bThreadId);

    if (a.replyToId == null && b.replyToId != null) return -1;
    if (a.replyToId != null && b.replyToId == null) return 1;

    const aTime = new Date(a.createdAtISO).getTime();
    const bTime = new Date(b.createdAtISO).getTime();
    return aTime - bTime || a.id.localeCompare(b.id);
  });
}

export function isRetryableFailedResponse<T extends ResponseMessage>(
  target: T,
  messages: T[]
) {
  if (target.responseStatus !== "failed" || !target.replyToId) return false;
  const siblings = messages.filter(
    (message) =>
      message.id !== target.id && message.replyToId === target.replyToId
  );
  if (
    siblings.some(
      (message) =>
        message.responseStatus === "pending" ||
        message.responseStatus === "completed"
    )
  ) {
    return false;
  }
  const failedAttempts = [...siblings, target]
    .filter((message) => message.responseStatus === "failed")
    .sort(
      (a, b) =>
        new Date(a.createdAtISO).getTime() -
          new Date(b.createdAtISO).getTime() || a.id.localeCompare(b.id)
    );
  return failedAttempts.at(-1)?.id === target.id;
}
