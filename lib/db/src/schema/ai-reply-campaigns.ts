import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

export const aiReplyCampaignsTable = pgTable("ai_reply_campaigns", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  name: text("name").notNull(),
  token: text("token").notNull().default(""),
  persona: text("persona").notNull().default(""),
  mode: text("mode").notNull().default("ai"),
  fixedMessage: text("fixed_message").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AiReplyCampaign = typeof aiReplyCampaignsTable.$inferSelect;