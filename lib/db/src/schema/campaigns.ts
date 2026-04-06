import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  name: text("name").notNull(),
  token: text("token").notNull(),
  channels: text("channels").array().notNull(),
  message: text("message").notNull(),
  delay: integer("delay").notNull().default(15),
  jitter: integer("jitter").notNull().default(0),
  running: boolean("running").notNull().default(false),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  rateLimitBonus: integer("rate_limit_bonus").notNull().default(0),
  rateLimitProtection: boolean("rate_limit_protection").notNull().default(true),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastSentAt: timestamp("last_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true, sentCount: true, failedCount: true, rateLimitBonus: true, lastSentAt: true, createdAt: true, consecutiveFailures: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
