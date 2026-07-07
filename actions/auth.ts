"use server"

import { auth, currentUser } from "@clerk/nextjs/server"
import { db } from "@/db"
import { users, stations } from "@/db/schema"
import { eq, and } from "drizzle-orm"
import { z } from "zod"
import { sendUserInvitation } from "@/lib/clerk-admin"

// Input validation schemas
const createUserSchema = z.object({
  stationId: z.string().uuid(),
  username: z.string().min(3).max(50),
  role: z.enum(["staff", "manager"]),
  email: z.string().email(),
  sendInvitation: z.boolean().optional().default(true)
})

const roleValidationSchema = z.object({
  requiredRole: z.enum(["staff", "manager"])
})

// Response type for consistent API responses
type ActionResponse<T = unknown> = {
  isSuccess: boolean
  data?: T
  error?: string
}

/**
 * Get the current user's station-specific profile
 */
export async function getCurrentUserProfile(): Promise<ActionResponse<{
  user: typeof users.$inferSelect
  station: typeof stations.$inferSelect
}>> {
  try {
    const { userId } = await auth()
    
    if (!userId) {
      return { isSuccess: false, error: "Not authenticated" }
    }

    const userWithStation = await db
      .select({
        user: users,
        station: stations
      })
      .from(users)
      .innerJoin(stations, eq(users.stationId, stations.id))
      .where(eq(users.clerkUserId, userId))
      .limit(1)

    if (userWithStation.length === 0) {
      return { isSuccess: false, error: "User profile not found" }
    }

    return { 
      isSuccess: true, 
      data: {
        user: userWithStation[0].user,
        station: userWithStation[0].station
      }
    }
  } catch (error) {
    console.error("Error getting user profile:", error)
    return { isSuccess: false, error: "Failed to get user profile" }
  }
}

/**
 * Get user role for authorization checks
 */
export async function getUserRole(clerkUserId?: string): Promise<ActionResponse<"staff" | "manager">> {
  try {
    const { userId } = await auth()
    const targetUserId = clerkUserId || userId
    
    if (!targetUserId) {
      return { isSuccess: false, error: "Not authenticated" }
    }

    const user = await db.query.users.findFirst({
      where: eq(users.clerkUserId, targetUserId),
      columns: { role: true, isActive: true }
    })

    if (!user) {
      return { isSuccess: false, error: "User not found" }
    }

    if (!user.isActive) {
      return { isSuccess: false, error: "User account is inactive" }
    }

    return { isSuccess: true, data: user.role }
  } catch (error) {
    console.error("Error getting user role:", error)
    return { isSuccess: false, error: "Failed to get user role" }
  }
}

/**
 * Validate if current user has required role
 */
export async function validateUserRole(requiredRole: "staff" | "manager"): Promise<ActionResponse<boolean>> {
  try {
    const validatedInput = roleValidationSchema.parse({ requiredRole })
    
    const roleResult = await getUserRole()
    if (!roleResult.isSuccess || !roleResult.data) {
      return { isSuccess: false, error: roleResult.error }
    }

    const userRole = roleResult.data
    
    // Manager has access to all staff functions
    const hasAccess = userRole === validatedInput.requiredRole || 
                     (validatedInput.requiredRole === "staff" && userRole === "manager")

    if (!hasAccess) {
      return { isSuccess: false, error: "Insufficient permissions" }
    }

    return { isSuccess: true, data: true }
  } catch (error) {
    console.error("Error validating user role:", error)
    return { isSuccess: false, error: "Failed to validate permissions" }
  }
}

/**
 * Create a new station user (Manager only)
 */
export async function createStationUser(input: z.infer<typeof createUserSchema>): Promise<ActionResponse<typeof users.$inferSelect>> {
  try {
    // Validate input
    const validatedInput = createUserSchema.parse(input)
    
    // Check if current user is a manager
    const roleCheck = await validateUserRole("manager")
    if (!roleCheck.isSuccess) {
      return { isSuccess: false, error: "Only managers can create user accounts" }
    }

    // Get current user's station to ensure they can only create users for their station
    const currentUserProfile = await getCurrentUserProfile()
    if (!currentUserProfile.isSuccess || !currentUserProfile.data) {
      return { isSuccess: false, error: "Failed to verify user permissions" }
    }

    // Ensure manager can only create users for their own station
    if (currentUserProfile.data.user.stationId !== validatedInput.stationId) {
      return { isSuccess: false, error: "Cannot create users for other stations" }
    }

    // Check if username already exists
    const existingUser = await db.query.users.findFirst({
      where: eq(users.username, validatedInput.username)
    })

    if (existingUser) {
      return { isSuccess: false, error: "Username already exists" }
    }

    // Step 1: Send invitation email first
    const invitationResult = await sendUserInvitation({
      email: validatedInput.email,
      username: validatedInput.username,
      role: validatedInput.role,
      stationId: validatedInput.stationId,
      redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/login`
    })

    if (!invitationResult.success) {
      return { isSuccess: false, error: `Failed to send invitation: ${invitationResult.error}` }
    }

    // Step 2: Create database user record with temporary Clerk ID
    const tempClerkUserId = `temp_${Date.now()}_${validatedInput.email}`

    const [newUser] = await db.insert(users).values({
      stationId: validatedInput.stationId,
      clerkUserId: tempClerkUserId,
      email: validatedInput.email.toLowerCase().trim(),
      username: validatedInput.username,
      role: validatedInput.role,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning()

    return { isSuccess: true, data: newUser }

  } catch (error) {
    console.error("Error creating station user:", error)
    if (error instanceof z.ZodError) {
      return { isSuccess: false, error: `Invalid input: ${error.issues.map(e => e.message).join(", ")}` }
    }
    return { isSuccess: false, error: "Failed to create user" }
  }
}

/**
 * Update user status (activate/deactivate) - Manager only
 */
export async function updateUserStatus(userId: string, isActive: boolean): Promise<ActionResponse<typeof users.$inferSelect>> {
  try {
    // Check if current user is a manager
    const roleCheck = await validateUserRole("manager")
    if (!roleCheck.isSuccess) {
      return { isSuccess: false, error: "Only managers can update user status" }
    }

    // Get current user's station
    const currentUserProfile = await getCurrentUserProfile()
    if (!currentUserProfile.isSuccess || !currentUserProfile.data) {
      return { isSuccess: false, error: "Failed to verify user permissions" }
    }

    // Get target user to ensure they're from the same station
    const targetUser = await db.query.users.findFirst({
      where: eq(users.id, userId)
    })

    if (!targetUser) {
      return { isSuccess: false, error: "User not found" }
    }

    // Ensure manager can only update users from their own station
    if (targetUser.stationId !== currentUserProfile.data.user.stationId) {
      return { isSuccess: false, error: "Cannot update users from other stations" }
    }

    // Prevent managers from deactivating themselves
    if (targetUser.clerkUserId === currentUserProfile.data.user.clerkUserId && !isActive) {
      return { isSuccess: false, error: "Cannot deactivate your own account" }
    }

    // Update user status
    const [updatedUser] = await db.update(users)
      .set({ 
        isActive,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning()

    return { isSuccess: true, data: updatedUser }
  } catch (error) {
    console.error("Error updating user status:", error)
    return { isSuccess: false, error: "Failed to update user status" }
  }
}

/**
 * Get all users for a station (Manager only)
 */
export async function getStationUsers(): Promise<ActionResponse<typeof users.$inferSelect[]>> {
  try {
    // Check if current user is a manager
    const roleCheck = await validateUserRole("manager")
    if (!roleCheck.isSuccess) {
      return { isSuccess: false, error: "Only managers can view all users" }
    }

    // Get current user's station
    const currentUserProfile = await getCurrentUserProfile()
    if (!currentUserProfile.isSuccess || !currentUserProfile.data) {
      return { isSuccess: false, error: "Failed to verify user permissions" }
    }

    // Get all users for the station
    const stationUsers = await db.query.users.findMany({
      where: eq(users.stationId, currentUserProfile.data.user.stationId),
      orderBy: (users, { desc }) => [desc(users.createdAt)]
    })

    return { isSuccess: true, data: stationUsers }
  } catch (error) {
    console.error("Error getting station users:", error)
    return { isSuccess: false, error: "Failed to get station users" }
  }
}