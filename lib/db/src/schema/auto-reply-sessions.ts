import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const autoReplySessionsTable = pgTable("auto_reply_sessions", {
  userId: text("user_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  token: text("token").notNull().default(""),
  persona: text("persona").notNull().default(""),
  fixedMessage: text("fixed_message").notNull().default(""),
  triggerKeywords: text("trigger_keywords").notNull().default(""),
  maxRepliesPerUser: integer("max_replies_per_user").notNull().default(0),
  maxRepliesPerCycle: integer("max_replies_per_cycle").notNull().default(2),
  activeHoursStart: integer("active_hours_start").notNull().default(9),
  activeHoursEnd: integer("active_hours_end").notNull().default(23),
  sentCountsByChannel: text("sent_counts_by_channel").notNull().default("{}"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
