"use server"

import { auth } from "@clerk/nextjs/server"
import { createClerkClient } from "@clerk/backend"
import { db } from "@/db"
import { users } from "@/db/schema"
import { eq } from "drizzle-orm"
import { z } from "zod"

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!
})

const setupStaffProfileSchema = z.object({
  clerkUserId: z.string()
})

type ActionResponse<T = unknown> = {
  isSuccess: boolean
  data?: T
  error?: string
}

export async function setupStaffProfile(
  input: z.infer<typeof setupStaffProfileSchema>
): Promise<ActionResponse<{ user: typeof users.$inferSelect }>> {
  try {
    // Validate input
    const validatedInput = setupStaffProfileSchema.parse(input)

    // Verify authentication
    const { userId } = await auth()
    if (!userId || userId !== validatedInput.clerkUserId) {
      return { isSuccess: false, error: "Authentication failed" }
    }

    // Get user email from Clerk
    const clerkUser = await clerkClient.users.getUser(userId)
    const userEmail = clerkUser.primaryEmailAddress?.emailAddress

    if (!userEmail) {
      return { isSuccess: false, error: "User email not found" }
    }

    // Find the pending user record created during invitation
    const pendingUser = await db.query.users.findFirst({
      where: eq(users.email, userEmail.toLowerCase().trim())
    })

    if (!pendingUser || pendingUser.role !== "staff") {
      return {
        isSuccess: false,
        error: "No valid invitation found for this email"
      }
    }

    // Update the pending user record with actual Clerk ID
    const [updatedUser] = await db
      .update(users)
      .set({
        clerkUserId: validatedInput.clerkUserId,
        updatedAt: new Date()
      })
      .where(eq(users.id, pendingUser.id))
      .returning()

    return { isSuccess: true, data: { user: updatedUser } }
  } catch (error) {
    console.error("Error setting up staff profile:", error)

    if (error instanceof z.ZodError) {
      return { isSuccess: false, error: error.issues[0].message }
    }

    return { isSuccess: false, error: "Failed to setup profile" }
  }
}
