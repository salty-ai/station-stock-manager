import { auth } from "@clerk/nextjs/server"
import { redirect } from "next/navigation"
import { SetupProfileForm } from "./_components/setup-profile-form"
import { createClerkClient } from "@clerk/backend"
import { db } from "@/db"
import { users } from "@/db/schema"
import { eq } from "drizzle-orm"

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!
})

export default async function SetupProfilePage() {
  const { userId } = await auth()

  if (!userId) {
    redirect("/login")
  }

  // Get user details from Clerk
  const user = await clerkClient.users.getUser(userId)
  const userEmail = user.primaryEmailAddress?.emailAddress

  // Check if there's a pending invitation for this email
  if (userEmail) {
    const pendingUser = await db.query.users.findFirst({
      where: eq(users.email, userEmail.toLowerCase().trim())
    })

    // If it's a staff invitation, complete setup automatically and redirect
    if (pendingUser?.role === "staff") {
      // Update the pending user record with actual Clerk ID
      await db
        .update(users)
        .set({
          clerkUserId: userId,
          updatedAt: new Date()
        })
        .where(eq(users.id, pendingUser.id))

      // Redirect directly to staff dashboard
      redirect("/staff")
    }
  }

  // Only managers need the setup profile process
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Complete Your Profile
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Set up your station account to get started
          </p>
        </div>
        <SetupProfileForm />
      </div>
    </div>
  )
}
