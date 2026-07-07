"use server"

// Fixed imports for sales actions
import { auth } from "@clerk/nextjs/server"
import { getCurrentUserProfile } from "@/actions/auth"
import { db } from "@/db"
import {
  products,
  transactions,
  transactionItems,
  stockMovements,
  users
} from "@/db/schema"
import { eq, and, desc, sql } from "drizzle-orm"
import { z } from "zod"

// Type for transactions with items and products
type TransactionWithItems = {
  id: string
  stationId: string
  userId: string
  totalAmount: string
  transactionDate: Date
  syncStatus: "pending" | "synced" | "failed"
  createdAt: Date
  items: Array<{
    id: string
    quantity: string
    totalPrice: string
    product: {
      id: string
      name: string
      type: "pms" | "lubricant"
      unit: string
    }
  }>
}

// Input validation schemas
const saleItemSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.number().min(0.01, "Quantity must be greater than 0"),
  unitPrice: z.number().min(0, "Unit price must be positive")
})

const recordSaleSchema = z.object({
  stationId: z.string().min(1, "Station ID is required"),
  items: z.array(saleItemSchema).min(1, "At least one item is required"),
  totalAmount: z.number().min(0, "Total amount must be positive")
})

const getSalesHistorySchema = z.object({
  stationId: z.string().min(1, "Station ID is required"),
  userId: z.string().optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  limit: z.number().min(1).max(100).default(50)
})

// Helper function to get user info
async function getUserInfo(userId: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, userId)
  })
  return user
}

/**
 * Record a new sale transaction
 */
export async function recordSale(input: z.infer<typeof recordSaleSchema>) {
  try {
    const validatedInput = recordSaleSchema.parse(input)

    const { userId } = await auth()
    if (!userId) {
      return { isSuccess: false, error: "Unauthorized" }
    }

    // Get user info
    const userInfo = await getUserInfo(userId)
    if (!userInfo) {
      return { isSuccess: false, error: "User not found" }
    }

    // Verify user belongs to the station
    if (userInfo.stationId !== validatedInput.stationId) {
      return { isSuccess: false, error: "Access denied for this station" }
    }

    const result = await db.transaction(async tx => {
      // Validate all products exist and belong to the station
      const productChecks = await Promise.all(
        validatedInput.items.map(async item => {
          const product = await tx.query.products.findFirst({
            where: and(
              eq(products.id, item.productId),
              eq(products.stationId, validatedInput.stationId),
              eq(products.isActive, true)
            )
          })

          if (!product) {
            throw new Error(`Product not found: ${item.productId}`)
          }

          return { product, item }
        })
      )

      // Create the transaction record
      const [transaction] = await tx
        .insert(transactions)
        .values({
          stationId: validatedInput.stationId,
          userId: userInfo.id,
          totalAmount: validatedInput.totalAmount.toString(),
          syncStatus: "synced"
        })
        .returning()

      // Process each item
      const transactionItemsData = []
      for (const { product, item } of productChecks) {
        // Calculate total price for this item
        const totalPrice = item.quantity * item.unitPrice

        // Create transaction item
        const [transactionItem] = await tx
          .insert(transactionItems)
          .values({
            transactionId: transaction.id,
            productId: item.productId,
            quantity: item.quantity.toString(),
            unitPrice: item.unitPrice.toString(),
            totalPrice: totalPrice.toString()
          })
          .returning()

        transactionItemsData.push({
          ...transactionItem,
          product: {
            id: product.id,
            name: product.name,
            type: product.type,
            unit: product.unit
          }
        })

        // Atomically decrement stock only if sufficient — prevents race conditions
        // and avoids float-math rounding by doing the arithmetic in PostgreSQL.
        const updatedRows = await tx.execute(
          sql`UPDATE ${products} SET current_stock = current_stock::numeric - ${item.quantity}::numeric, updated_at = NOW() WHERE ${products.id} = ${item.productId} AND ${products.currentStock}::numeric >= ${item.quantity}::numeric RETURNING current_stock, (current_stock::numeric + ${item.quantity}::numeric) AS previous_stock`
        )

        const updatedRow = updatedRows[0] as
          | { current_stock: string; previous_stock: string }
          | undefined

        if (!updatedRow) {
          throw new Error(
            `Insufficient stock for ${product.name}. Requested: ${item.quantity}`
          )
        }

        const previousStock = parseFloat(updatedRow.previous_stock)
        const newStock = parseFloat(updatedRow.current_stock)

        // Record stock movement
        await tx.insert(stockMovements).values({
          productId: item.productId,
          movementType: "sale",
          quantity: (-item.quantity).toString(), // Negative for sale
          previousStock: previousStock.toString(),
          newStock: newStock.toString(),
          reference: transaction.id
        })
      }

      return {
        transaction: {
          ...transaction,
          items: transactionItemsData
        }
      }
    })

    return { isSuccess: true, data: result.transaction }
  } catch (error) {
    console.error("Error recording sale:", error)
    if (error instanceof z.ZodError) {
      return { isSuccess: false, error: error.issues[0].message }
    }
    return {
      isSuccess: false,
      error: error instanceof Error ? error.message : "Failed to record sale"
    }
  }
}

/**
 * Get sales history with optional filters
 */
export async function getSalesHistory(
  input: z.infer<typeof getSalesHistorySchema>
) {
  try {
    const validatedInput = getSalesHistorySchema.parse(input)

    const { userId } = await auth()
    if (!userId) {
      return { isSuccess: false, error: "Unauthorized" }
    }

    // Get user info
    const userInfo = await getUserInfo(userId)
    if (!userInfo) {
      return { isSuccess: false, error: "User not found" }
    }

    // Verify user belongs to the station
    if (userInfo.stationId !== validatedInput.stationId) {
      return { isSuccess: false, error: "Access denied for this station" }
    }

    // Build where conditions
    let whereConditions = [eq(transactions.stationId, validatedInput.stationId)]

    if (validatedInput.userId) {
      whereConditions.push(eq(transactions.userId, validatedInput.userId))
    }

    if (validatedInput.startDate) {
      whereConditions.push(
        sql`${transactions.transactionDate} >= ${validatedInput.startDate}`
      )
    }

    if (validatedInput.endDate) {
      whereConditions.push(
        sql`${transactions.transactionDate} <= ${validatedInput.endDate}`
      )
    }

    // Get transactions with items
    const salesHistory = await db.query.transactions.findMany({
      where: and(...whereConditions),
      orderBy: [desc(transactions.transactionDate)],
      limit: validatedInput.limit,
      with: {
        user: {
          columns: {
            id: true,
            username: true,
            role: true
          }
        },
        items: {
          with: {
            product: {
              columns: {
                id: true,
                name: true,
                type: true,
                unit: true,
                brand: true
              }
            }
          }
        }
      }
    })

    return { isSuccess: true, data: salesHistory }
  } catch (error) {
    console.error("Error fetching sales history:", error)
    if (error instanceof z.ZodError) {
      return { isSuccess: false, error: error.issues[0].message }
    }
    return { isSuccess: false, error: "Failed to fetch sales history" }
  }
}

/**
 * Get today's sales summary for a user
 */
export async function getTodaysSalesSummary(
  stationId: string,
  userId?: string
) {
  try {
    const { userId: authUserId } = await auth()
    if (!authUserId) {
      return { isSuccess: false, error: "Unauthorized" }
    }

    // Get user profile using the same method as other functions
    const userProfileResult = await getCurrentUserProfile()
    if (!userProfileResult.isSuccess || !userProfileResult.data) {
      return { isSuccess: false, error: "User profile not found" }
    }

    const { user } = userProfileResult.data

    // Verify user belongs to the station
    if (user.stationId !== stationId) {
      return { isSuccess: false, error: "Access denied for this station" }
    }

    // Use provided userId or current user's ID
    const targetUserId = userId || user.id

    // Get today's date range
    const today = new Date()
    const startOfDay = new Date(today)
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(today)
    endOfDay.setHours(23, 59, 59, 999)

    // Get today's transactions
    const todaysTransactions = (await db.query.transactions.findMany({
      where: and(
        eq(transactions.stationId, stationId),
        eq(transactions.userId, targetUserId),
        sql`${transactions.transactionDate} >= ${startOfDay.toISOString()}`,
        sql`${transactions.transactionDate} <= ${endOfDay.toISOString()}`
      ),
      with: {
        items: {
          with: {
            product: {
              columns: {
                id: true,
                name: true,
                type: true,
                unit: true
              }
            }
          }
        }
      }
    })) as TransactionWithItems[]

    // Calculate summary statistics
    const totalTransactions = todaysTransactions.length
    const totalAmount = todaysTransactions.reduce(
      (sum, transaction) => sum + parseFloat(transaction.totalAmount),
      0
    )

    // Group by product type
    const productTypeSummary = todaysTransactions.reduce(
      (acc, transaction) => {
        transaction.items.forEach(item => {
          const productType = item.product.type
          if (!acc[productType]) {
            acc[productType] = {
              totalQuantity: 0,
              totalAmount: 0,
              transactionCount: 0
            }
          }
          acc[productType].totalQuantity += parseFloat(item.quantity)
          acc[productType].totalAmount += parseFloat(item.totalPrice)
        })
        return acc
      },
      {} as Record<
        string,
        { totalQuantity: number; totalAmount: number; transactionCount: number }
      >
    )

    // Get most sold products
    const productSales = todaysTransactions.reduce(
      (acc, transaction) => {
        transaction.items.forEach(item => {
          const productId = item.product.id
          if (!acc[productId]) {
            acc[productId] = {
              product: item.product,
              totalQuantity: 0,
              totalAmount: 0,
              transactionCount: 0
            }
          }
          acc[productId].totalQuantity += parseFloat(item.quantity)
          acc[productId].totalAmount += parseFloat(item.totalPrice)
          acc[productId].transactionCount += 1
        })
        return acc
      },
      {} as Record<string, any>
    )

    const topProducts = Object.values(productSales)
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 5)

    return {
      isSuccess: true,
      data: {
        date: today.toISOString().split("T")[0],
        totalTransactions,
        totalAmount,
        productTypeSummary,
        topProducts,
        transactions: todaysTransactions
      }
    }
  } catch (error) {
    console.error("Error fetching today's sales summary:", error)
    return { isSuccess: false, error: "Failed to fetch sales summary" }
  }
}

/**
 * Get frequently sold products for quick access
 */
export async function getFrequentlysoldProducts(
  stationId: string,
  limit: number = 10
) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return { isSuccess: false, error: "Unauthorized" }
    }

    // Get user info
    const userInfo = await getUserInfo(userId)
    if (!userInfo) {
      return { isSuccess: false, error: "User not found" }
    }

    // Verify user belongs to the station
    if (userInfo.stationId !== stationId) {
      return { isSuccess: false, error: "Access denied for this station" }
    }

    // Get products with their sales frequency from the last 30 days
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const frequentProducts = await db
      .select({
        productId: transactionItems.productId,
        product: products,
        totalQuantity: sql<number>`SUM(${transactionItems.quantity}::numeric)`,
        totalTransactions: sql<number>`COUNT(DISTINCT ${transactionItems.transactionId})`,
        totalAmount: sql<number>`SUM(${transactionItems.totalPrice}::numeric)`
      })
      .from(transactionItems)
      .innerJoin(products, eq(transactionItems.productId, products.id))
      .innerJoin(
        transactions,
        eq(transactionItems.transactionId, transactions.id)
      )
      .where(
        and(
          eq(transactions.stationId, stationId),
          eq(products.isActive, true),
          sql`${transactions.transactionDate} >= ${thirtyDaysAgo}`
        )
      )
      .groupBy(transactionItems.productId, products.id)
      .orderBy(desc(sql`COUNT(DISTINCT ${transactionItems.transactionId})`))
      .limit(limit)

    return { isSuccess: true, data: frequentProducts }
  } catch (error) {
    console.error("Error fetching frequently sold products:", error)
    return {
      isSuccess: false,
      error: "Failed to fetch frequently sold products"
    }
  }
}

/**
 * Void a transaction (Manager only)
 */
export async function voidTransaction(transactionId: string, reason: string) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return { isSuccess: false, error: "Unauthorized" }
    }

    // Get user info
    const userInfo = await getUserInfo(userId)
    if (!userInfo) {
      return { isSuccess: false, error: "User not found" }
    }

    // Only managers can void transactions
    if (userInfo.role !== "manager") {
      return { isSuccess: false, error: "Only managers can void transactions" }
    }

    const result = await db.transaction(async tx => {
      // Get the transaction with its items
      const transaction = (await tx.query.transactions.findFirst({
        where: eq(transactions.id, transactionId),
        with: {
          items: {
            with: {
              product: true
            }
          }
        }
      })) as any

      if (!transaction) {
        throw new Error("Transaction not found")
      }

      // Verify transaction belongs to user's station
      if (transaction.stationId !== userInfo.stationId) {
        throw new Error("Access denied for this transaction")
      }

      // Restore stock for each item atomically
      for (const item of transaction.items) {
        const quantity = parseFloat(item.quantity)

        // Atomic stock increment — arithmetic done in PostgreSQL
        const updatedRows = await tx.execute(
          sql`UPDATE ${products} SET current_stock = current_stock::numeric + ${quantity}::numeric, updated_at = NOW() WHERE ${products.id} = ${item.productId} RETURNING current_stock, (current_stock::numeric - ${quantity}::numeric) AS previous_stock`
        )

        const updatedRow = updatedRows[0] as
          | { current_stock: string; previous_stock: string }
          | undefined

        if (!updatedRow) {
          throw new Error(`Product not found: ${item.productId}`)
        }

        const currentStock = parseFloat(updatedRow.previous_stock)
        const newStock = parseFloat(updatedRow.current_stock)

        // Record stock movement for void
        await tx.insert(stockMovements).values({
          productId: item.productId,
          movementType: "adjustment",
          quantity: quantity.toString(),
          previousStock: currentStock.toString(),
          newStock: newStock.toString(),
          reference: `VOID: ${transactionId} - ${reason}`
        })
      }

      // Mark transaction as voided (we could add a status field, but for now we'll delete)
      // In a production system, you might want to keep voided transactions for audit purposes
      await tx
        .delete(transactionItems)
        .where(eq(transactionItems.transactionId, transactionId))
      await tx.delete(transactions).where(eq(transactions.id, transactionId))

      return transaction
    })

    return { isSuccess: true, data: result }
  } catch (error) {
    console.error("Error voiding transaction:", error)
    return {
      isSuccess: false,
      error:
        error instanceof Error ? error.message : "Failed to void transaction"
    }
  }
}
