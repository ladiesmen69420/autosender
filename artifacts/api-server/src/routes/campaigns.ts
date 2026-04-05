import { Router } from "express";
import { db, campaignsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { startCampaignSchedule, stopCampaignSchedule, isRunning } from "../scheduler";

const router = Router();

function parseCampaignBody(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const channels = Array.isArray(body.channels) ? (body.channels as string[]).filter(Boolean) : [];
  const message = typeof body.message === "string" ? body.message : "";
  const delay = typeof body.delay === "number" ? Math.max(1, body.delay) : 15;
  const jitter = typeof body.jitter === "number" ? Math.min(100, Math.max(0, body.jitter)) : 0;
  const running = typeof body.running === "boolean" ? body.running : undefined;
  return { name, token, channels, message, delay, jitter, running };
}

function serializeCampaign(row: typeof campaignsTable.$inferSelect) {
  return {
    ...row,
    running: isRunning(row.id) || row.running,
    createdAt: row.createdAt.toISOString(),
    lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
  };
}

router.get("/", async (req, res) => {
  const rows = await db.select().from(campaignsTable).orderBy(campaignsTable.createdAt);
  res.json(rows.map(serializeCampaign));
});

router.post("/", async (req, res) => {
  const data = parseCampaignBody(req.body as Record<string, unknown>);
  if (!data.name || !data.token || !data.message) {
    res.status(400).json({ error: "name, token, and message are required" });
    return;
  }

  const [row] = await db
    .insert(campaignsTable)
    .values({
      name: data.name,
      token: data.token,
      channels: data.channels,
      message: data.message,
      delay: data.delay,
      jitter: data.jitter,
    })
    .returning();

  res.status(201).json(serializeCampaign(row));
});

router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const data = parseCampaignBody(req.body as Record<string, unknown>);
  const update: Partial<typeof data> = {};
  if (data.name) update.name = data.name;
  if (data.token) update.token = data.token;
  update.channels = data.channels;
  if (data.message) update.message = data.message;
  update.delay = data.delay;
  update.jitter = data.jitter;

  const [row] = await db
    .update(campaignsTable)
    .set(update)
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeCampaign(row));
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  stopCampaignSchedule(id);
  await db.update(campaignsTable).set({ running: false }).where(eq(campaignsTable.id, id));
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  res.json({ success: true });
});

router.post("/:id/start", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .update(campaignsTable)
    .set({ running: true })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  startCampaignSchedule(id);
  res.json(serializeCampaign(row));
});

router.post("/:id/stop", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  stopCampaignSchedule(id);

  const [row] = await db
    .update(campaignsTable)
    .set({ running: false })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeCampaign(row));
});

router.post("/:id/reset-stats", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .update(campaignsTable)
    .set({ sentCount: 0, failedCount: 0, rateLimitBonus: 0 })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeCampaign(row));
});

export default router;
