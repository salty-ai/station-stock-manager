import { NextRequest, NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/db"
import { users } from "@/db/schema"
import { eq } from "drizzle-orm"

export async function POST(request: NextRequest) {
  try {
    // Require Clerk session — prevents unauthenticated enumeration
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      )
    }

    const { email } = await request.json()

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 })
    }

    // Find the pending user record by exact email match
    const pendingUser = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim())
    })

    if (!pendingUser) {
      return NextResponse.json(
        { error: "No pending invitation found" },
        { status: 404 }
      )
    }

    // Return only the minimum needed for pre-activation setup — no role/stationId leakage
    return NextResponse.json({
      exists: true,
      username: pendingUser.username
    })
  } catch (error) {
    console.error("Error fetching pending user:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
