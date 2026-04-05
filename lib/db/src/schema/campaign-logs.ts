import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";

export const campaignLogsTable = pgTable("campaign_logs", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  type: text("type").notNull(), // 'success' | 'warning' | 'error'
  message: text("message").notNull(),
  details: text("details"),
  suggestion: text("suggestion"),
  channelId: text("channel_id"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export type CampaignLog = typeof campaignLogsTable.$inferSelect;
