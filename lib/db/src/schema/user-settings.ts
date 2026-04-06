import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const userSettingsTable = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  aiToken: text("ai_token").notNull().default(""),
  aiPersona: text("ai_persona").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserSettings = typeof userSettingsTable.$inferSelect;
