import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { userRole } from "./enums"
import { stations } from "./stations"

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  stationId: uuid("station_id")
    .references(() => stations.id)
    .notNull(),
  clerkUserId: text("clerk_user_id").unique().notNull(),
  email: text("email").unique(),
  username: text("username").unique().notNull(),
  role: userRole("role").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull()
})

export type InsertUser = typeof users.$inferInsert
export type SelectUser = typeof users.$inferSelect
