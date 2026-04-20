import { Router } from "express";
import { getAuth } from "@clerk/express";
import { and, eq, isNull, or } from "drizzle-orm";
import { aiReplyCampaignsTable, db } from "@workspace/db";

const router = Router();

function getUserId(req: any): string | null {
  try {
    const auth = getAuth(req);
    return auth?.userId ?? null;
  } catch {
    return null;
  }
}

function userFilter(userId: string | null) {
  if (!userId) return isNull(aiReplyCampaignsTable.userId);
  return or(eq(aiReplyCampaignsTable.userId, userId), isNull(aiReplyCampaignsTable.userId));
}

function parseBody(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const persona = typeof body.persona === "string" ? body.persona : "";
  const fixedMessage = typeof body.fixedMessage === "string" ? body.fixedMessage : "";
  const mode = body.mode === "fixed" ? "fixed" : "ai";
  return { name, token, persona, fixedMessage, mode };
}

function serialize(row: typeof aiReplyCampaignsTable.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  const userId = getUserId(req);
  const rows = await db
    .select()
    .from(aiReplyCampaignsTable)
    .where(userFilter(userId))
    .orderBy(aiReplyCampaignsTable.createdAt);
  res.json(rows.map(serialize));
});

router.post("/", async (req, res) => {
  const userId = getUserId(req);
  const data = parseBody(req.body as Record<string, unknown>);
  if (!data.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (data.mode === "fixed" && !data.fixedMessage.trim()) {
    res.status(400).json({ error: "fixedMessage is required for fixed mode" });
    return;
  }

  const [row] = await db
    .insert(aiReplyCampaignsTable)
    .values({ userId, ...data })
    .returning();
  res.status(201).json(serialize(row));
});

router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const userId = getUserId(req);
  const data = parseBody(req.body as Record<string, unknown>);
  if (!data.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (data.mode === "fixed" && !data.fixedMessage.trim()) {
    res.status(400).json({ error: "fixedMessage is required for fixed mode" });
    return;
  }

  const [row] = await db
    .update(aiReplyCampaignsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(aiReplyCampaignsTable.id, id), userFilter(userId)))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json(serialize(row));
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const userId = getUserId(req);
  await db
    .delete(aiReplyCampaignsTable)
    .where(and(eq(aiReplyCampaignsTable.id, id), userFilter(userId)));
  res.json({ success: true });
});

export default router;