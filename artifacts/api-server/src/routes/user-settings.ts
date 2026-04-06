import { Router } from "express";
import { db, userSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuth } from "@clerk/express";

const router = Router();

function getUserId(req: any): string | null {
  try {
    const auth = getAuth(req);
    return auth?.userId ?? null;
  } catch {
    return null;
  }
}

router.get("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.json({ aiToken: "", aiPersona: "" });
    return;
  }

  const [row] = await db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, userId)).limit(1);
  if (!row) {
    res.json({ aiToken: "", aiPersona: "" });
    return;
  }
  res.json({ aiToken: row.aiToken, aiPersona: row.aiPersona });
});

router.put("/", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const aiToken = typeof body.aiToken === "string" ? body.aiToken : "";
  const aiPersona = typeof body.aiPersona === "string" ? body.aiPersona : "";

  await db
    .insert(userSettingsTable)
    .values({ userId, aiToken, aiPersona })
    .onConflictDoUpdate({
      target: userSettingsTable.userId,
      set: { aiToken, aiPersona, updatedAt: new Date() },
    });

  res.json({ success: true, aiToken, aiPersona });
});

export default router;
