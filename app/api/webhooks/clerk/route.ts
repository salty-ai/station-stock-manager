import { headers } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { Webhook } from "svix"
import { db } from "@/db"
import { users } from "@/db/schema"
import { eq } from "drizzle-orm"

export const dynamic = "force-dynamic"

const webhookSecret = process.env.CLERK_WEBHOOK_SECRET

export async function POST(req: NextRequest) {
  if (!webhookSecret) {
    console.error("Missing CLERK_WEBHOOK_SECRET")
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    )
  }

  const headerPayload = await headers()
  const svixId = headerPayload.get("svix-id")
  const svixTimestamp = headerPayload.get("svix-timestamp")
  const svixSignature = headerPayload.get("svix-signature")

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 })
  }

  const payload = await req.json()
  const body = JSON.stringify(payload)

  const wh = new Webhook(webhookSecret)
  let evt

  try {
    evt = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature
    })
  } catch (err) {
    console.error("Error verifying webhook:", err)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  const { type, data } = evt as { type: string; data: Record<string, unknown> }

  // Handle user creation - link existing database records
  if (type === "user.created") {
    try {
      const emailAddresses = data.email_addresses as
        | Array<{ email_address: string }>
        | undefined
      const email = emailAddresses?.[0]?.email_address
      console.log(`Processing user.created webhook for email: ${email}`)

      if (email) {
        const clerkUserId = data.id as string

        // Find user record by exact email match
        const existingUser = await db.query.users.findFirst({
          where: eq(users.email, email.toLowerCase().trim())
        })

        if (existingUser) {
          console.log(
            `Found existing user record for ${email}, username: ${existingUser.username}`
          )

          // Update the user record with the real Clerk ID
          await db
            .update(users)
            .set({
              clerkUserId: clerkUserId,
              updatedAt: new Date()
            })
            .where(eq(users.id, existingUser.id))

          console.log(`Linked user ${email} with Clerk ID ${data.id}`)

          // Update Clerk user profile with username from database
          try {
            const { updateClerkUserProfile, updateClerkUserMetadata } =
              await import("@/lib/clerk-admin")

            // Set username in Clerk profile
            const profileResult = await updateClerkUserProfile(clerkUserId, {
              username: existingUser.username,
              firstName: existingUser.username
            })

            if (profileResult.success) {
              console.log(
                `Successfully updated Clerk username to: ${existingUser.username}`
              )
            } else {
              console.error(
                `Failed to update Clerk username: ${profileResult.error}`
              )
            }

            // Set role and other metadata
            const metadataResult = await updateClerkUserMetadata(clerkUserId, {
              role: existingUser.role,
              stationId: existingUser.stationId
            })

            if (metadataResult.success) {
              console.log(`Successfully updated Clerk metadata for ${email}`)
            } else {
              console.error(
                `Failed to update Clerk metadata: ${metadataResult.error}`
              )
            }
          } catch (error) {
            console.error("Error updating Clerk user profile:", error)
          }
        } else {
          console.log(`No existing user record found for email: ${email}`)
        }
      } else {
        console.log("No email address found in webhook data")
      }
    } catch (error) {
      console.error("Error linking user:", error)
    }
  }

  return NextResponse.json({ received: true })
}
