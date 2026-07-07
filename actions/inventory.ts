"use server"

import { auth } from "@clerk/nextjs/server"
import { db } from "@/db"
import { products, stockMovements, users, suppliers } from "@/db/schema"
import { eq, and, desc, gte, lte, sql, inArray } from "drizzle-orm"
import { z } from "zod"
import {
  createSuccessResponse,
  createErrorResponse,
  createValidationErrorResponse,
  handleDatabaseOperation,
  validateInput,
  ErrorCodes,
  type ApiResponse
} from "@/lib/utils"

// Type definitions for related objects
interface SupplierData {
  id: string
  name: string
  contactPerson: string | null
  phone: string | null
}

interface ProductData {
  id: string
  name: string
  stationId: string
}

interface StockMovementData {
  quantity: string
  movementType: string
  createdAt: Date
}

// Input validation schemas
const stockAdjustmentSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.number(),
  reason: z.string().min(1, "Reason is required"),
  reference: z.string().optional()
})

const deliverySchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.number().min(0.01, "Quantity must be positive"),
  supplierId: z.string().optional(),
  deliveryNote: z.string().optional(),
  unitCost: z.number().min(0, "Unit cost cannot be negative").optional()
})

const bulkStockUpdateSchema = z.object({
  updates: z.array(
    z.object({
      productId: z.string().min(1, "Product ID is required"),
      quantity: z.number(),
      movementType: z.enum(["adjustment", "delivery"]),
      reason: z.string().min(1, "Reason is required")
    })
  )
})

const stockAlertThresholdSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  newThreshold: z.number().min(0, "Threshold cannot be negative")
})

const stockMovementHistorySchema = z.object({
  stationId: z.string().min(1, "Station ID is required"),
  productId: z.string().optional(),
  movementType: z.enum(["sale", "adjustment", "delivery"]).optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  limit: z.number().min(1).max(1000).optional()
})

// Helper function to get user role
async function getUserRole(userId: string): Promise<string | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, userId)
  })
  return user?.role || null
}

/**
 * Record a stock adjustment (Manager only)
 */
export async function recordStockAdjustment(
  input: z.infer<typeof stockAdjustmentSchema>
): Promise<
  ApiResponse<{
    product: typeof products.$inferSelect
    movement: typeof stockMovements.$inferSelect
    previousStock: number
    newStock: number
    adjustment: number
  }>
> {
  // Validate input
  const validation = validateInput(stockAdjustmentSchema, input)
  if (!validation.isValid) {
    return validation.error
  }

  const validatedInput = validation.data

  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  // Check authorization
  const userRole = await getUserRole(userId)
  if (userRole !== "manager") {
    return createErrorResponse("Manager access required", ErrorCodes.FORBIDDEN)
  }

  return handleDatabaseOperation(async () => {
    const result = await db.transaction(async tx => {
      // Get current product (for name validation / existence check)
      const product = await tx.query.products.findFirst({
        where: eq(products.id, validatedInput.productId)
      })

      if (!product) {
        throw new Error("Product not found")
      }

      const adjustment = validatedInput.quantity

      // Atomically update stock — arithmetic done in PostgreSQL, not JS float math.
      // Guard against negative result for positive-direction safety:
      const updatedRows = await tx.execute(
        sql`UPDATE ${products} SET current_stock = current_stock::numeric + ${adjustment}::numeric, updated_at = NOW() WHERE ${products.id} = ${validatedInput.productId} AND (current_stock::numeric + ${adjustment}::numeric) >= 0 RETURNING current_stock, (current_stock::numeric - ${adjustment}::numeric) AS previous_stock`
      )

      const updatedRow = updatedRows[0] as
        | { current_stock: string; previous_stock: string }
        | undefined

      if (!updatedRow) {
        throw new Error("Stock adjustment would result in negative stock")
      }

      const previousStock = parseFloat(updatedRow.previous_stock)
      const newStock = parseFloat(updatedRow.current_stock)

      // Build the updated product object from the pre-update fetch + new stock
      const updatedProduct = { ...product, currentStock: updatedRow.current_stock, updatedAt: new Date() }

      // Record stock movement
      const [movement] = await tx
        .insert(stockMovements)
        .values({
          productId: validatedInput.productId,
          movementType: "adjustment",
          quantity: adjustment.toString(),
          previousStock: previousStock.toString(),
          newStock: newStock.toString(),
          reference: `${validatedInput.reason}${validatedInput.reference ? ` - ${validatedInput.reference}` : ""}`
        })
        .returning()

      return {
        product: updatedProduct,
        movement,
        previousStock,
        newStock,
        adjustment
      }
    })

    return result
  }, "Record stock adjustment")
}

/**
 * Record a delivery (Manager only)
 */
export async function recordDelivery(
  input: z.infer<typeof deliverySchema>
): Promise<
  ApiResponse<{
    product: typeof products.$inferSelect
    movement: typeof stockMovements.$inferSelect
    previousStock: number
    newStock: number
    deliveryQuantity: number
    priceUpdated: boolean
  }>
> {
  // Validate input
  const validation = validateInput(deliverySchema, input)
  if (!validation.isValid) {
    return validation.error
  }

  const validatedInput = validation.data

  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  // Check authorization
  const userRole = await getUserRole(userId)
  if (userRole !== "manager") {
    return createErrorResponse("Manager access required", ErrorCodes.FORBIDDEN)
  }

  return handleDatabaseOperation(async () => {
    const result = await db.transaction(async tx => {
      // Get current product (for existence check)
      const product = await tx.query.products.findFirst({
        where: eq(products.id, validatedInput.productId)
      })

      if (!product) {
        throw new Error("Product not found")
      }

      const deliveryQuantity = validatedInput.quantity

      // Atomically update stock — arithmetic done in PostgreSQL.
      // Optionally update unit_price if a unit cost was provided.
      const updatedRows = validatedInput.unitCost !== undefined
        ? await tx.execute(
            sql`UPDATE ${products} SET current_stock = current_stock::numeric + ${deliveryQuantity}::numeric, unit_price = ${validatedInput.unitCost}::numeric, updated_at = NOW() WHERE ${products.id} = ${validatedInput.productId} RETURNING *, (current_stock::numeric - ${deliveryQuantity}::numeric) AS previous_stock`
          )
        : await tx.execute(
            sql`UPDATE ${products} SET current_stock = current_stock::numeric + ${deliveryQuantity}::numeric, updated_at = NOW() WHERE ${products.id} = ${validatedInput.productId} RETURNING *, (current_stock::numeric - ${deliveryQuantity}::numeric) AS previous_stock`
          )

      const updatedRow = updatedRows[0] as
        | (typeof products.$inferSelect & { previous_stock: string })
        | undefined

      if (!updatedRow) {
        throw new Error("Product not found")
      }

      const previousStock = parseFloat(updatedRow.previous_stock)
      const newStock = parseFloat(updatedRow.currentStock)

      // Build reference string - moved supplier query inside transaction
      let reference = "Delivery"
      if (validatedInput.deliveryNote) {
        reference += ` - ${validatedInput.deliveryNote}`
      }
      if (validatedInput.supplierId) {
        const supplier = await tx.query.suppliers.findFirst({
          where: eq(suppliers.id, validatedInput.supplierId)
        })
        if (supplier) {
          reference += ` from ${supplier.name}`
        }
      }

      // Record stock movement
      const [movement] = await tx
        .insert(stockMovements)
        .values({
          productId: validatedInput.productId,
          movementType: "delivery",
          quantity: deliveryQuantity.toString(),
          previousStock: previousStock.toString(),
          newStock: newStock.toString(),
          reference
        })
        .returning()

      // Strip the extra previous_stock column before returning
      const { previous_stock: _ps, ...productData } = updatedRow

      return {
        product: productData,
        movement,
        previousStock,
        newStock,
        deliveryQuantity,
        priceUpdated: validatedInput.unitCost !== undefined
      }
    })

    return result
  }, "Record delivery")
}

/**
 * Get comprehensive stock movement history with filters
 */
export async function getStockMovementHistory(
  input: z.infer<typeof stockMovementHistorySchema>
): Promise<
  ApiResponse<
    Array<
      typeof stockMovements.$inferSelect & {
        product: typeof products.$inferSelect | null
      }
    >
  >
> {
  // Validate input
  const validation = validateInput(stockMovementHistorySchema, input)
  if (!validation.isValid) {
    return validation.error
  }

  const {
    stationId,
    productId,
    movementType,
    startDate,
    endDate,
    limit = 100
  } = validation.data

  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  return handleDatabaseOperation(async () => {
    // Build where conditions
    const whereConditions = []

    if (productId) {
      whereConditions.push(eq(stockMovements.productId, productId))
    }

    if (movementType) {
      whereConditions.push(eq(stockMovements.movementType, movementType))
    }

    if (startDate) {
      whereConditions.push(gte(stockMovements.createdAt, startDate))
    }

    if (endDate) {
      whereConditions.push(lte(stockMovements.createdAt, endDate))
    }

    // Add station filter using proper relationship
    whereConditions.push(
      inArray(
        stockMovements.productId,
        db
          .select({ id: products.id })
          .from(products)
          .where(eq(products.stationId, stationId))
      )
    )

    const movements = await db.query.stockMovements.findMany({
      where: whereConditions.length > 0 ? and(...whereConditions) : undefined,
      with: {
        product: true
      },
      orderBy: [desc(stockMovements.createdAt)],
      limit
    })

    // Return movements (product will be null for movements not in this station)
    return movements as Array<
      typeof stockMovements.$inferSelect & {
        product: typeof products.$inferSelect | null
      }
    >
  }, "Fetch stock movement history")
}

/**
 * Get real-time inventory status with low stock alerts
 */
export async function getInventoryStatus(stationId: string): Promise<
  ApiResponse<{
    items: Array<{
      id: string
      name: string
      brand: string | null
      type: "pms" | "lubricant"
      currentStock: number
      minThreshold: number
      unitPrice: number
      value: number
      unit: string
      isLowStock: boolean
      isOutOfStock: boolean
      supplier: { id: string; name: string } | null
      stockStatus: "out_of_stock" | "low_stock" | "normal"
    }>
    summary: {
      totalProducts: number
      totalValue: number
      lowStockCount: number
      outOfStockCount: number
      normalStockCount: number
    }
  }>
> {
  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  if (!stationId) {
    return createErrorResponse("Station ID is required", ErrorCodes.BAD_REQUEST)
  }

  return handleDatabaseOperation(async () => {
    const productList = await db.query.products.findMany({
      where: and(
        eq(products.stationId, stationId),
        eq(products.isActive, true)
      ),
      with: {
        supplier: {
          columns: {
            id: true,
            name: true
          }
        }
      },
      orderBy: [products.name]
    })

    let totalValue = 0
    let lowStockCount = 0
    let outOfStockCount = 0

    const inventoryItems = productList.map(product => {
      const currentStock = parseFloat(product.currentStock)
      const minThreshold = parseFloat(product.minThreshold)
      const unitPrice = parseFloat(product.unitPrice)
      const value = currentStock * unitPrice

      totalValue += value

      const isLowStock = currentStock <= minThreshold
      const isOutOfStock = currentStock === 0

      if (isLowStock) lowStockCount++
      if (isOutOfStock) outOfStockCount++

      return {
        id: product.id,
        name: product.name,
        brand: product.brand,
        type: product.type,
        currentStock,
        minThreshold,
        unitPrice,
        value,
        unit: product.unit,
        isLowStock,
        isOutOfStock,
        supplier: product.supplier
          ? {
              id: (product.supplier as SupplierData).id,
              name: (product.supplier as SupplierData).name
            }
          : null,
        stockStatus: (isOutOfStock
          ? "out_of_stock"
          : isLowStock
            ? "low_stock"
            : "normal") as "out_of_stock" | "low_stock" | "normal"
      }
    })

    return {
      items: inventoryItems,
      summary: {
        totalProducts: productList.length,
        totalValue,
        lowStockCount,
        outOfStockCount,
        normalStockCount: productList.length - lowStockCount
      }
    }
  }, "Fetch inventory status")
}

/**
 * Update stock alert threshold (Manager only)
 */
export async function updateStockAlertThreshold(
  input: z.infer<typeof stockAlertThresholdSchema>
): Promise<ApiResponse<typeof products.$inferSelect>> {
  // Validate input
  const validation = validateInput(stockAlertThresholdSchema, input)
  if (!validation.isValid) {
    return validation.error
  }

  const validatedInput = validation.data

  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  // Check authorization
  const userRole = await getUserRole(userId)
  if (userRole !== "manager") {
    return createErrorResponse("Manager access required", ErrorCodes.FORBIDDEN)
  }

  return handleDatabaseOperation(async () => {
    const [product] = await db
      .update(products)
      .set({
        minThreshold: validatedInput.newThreshold.toString(),
        updatedAt: new Date()
      })
      .where(eq(products.id, validatedInput.productId))
      .returning()

    if (!product) {
      throw new Error("Product not found")
    }

    return product
  }, "Update stock alert threshold")
}

/**
 * Bulk stock update (Manager only)
 */
export async function bulkStockUpdate(
  input: z.infer<typeof bulkStockUpdateSchema>
): Promise<
  ApiResponse<{
    updates: Array<{
      productId: string
      productName: string
      previousStock: number
      newStock: number
      quantity: number
    }>
    count: number
  }>
> {
  // Validate input
  const validation = validateInput(bulkStockUpdateSchema, input)
  if (!validation.isValid) {
    return validation.error
  }

  const validatedInput = validation.data

  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  // Check authorization
  const userRole = await getUserRole(userId)
  if (userRole !== "manager") {
    return createErrorResponse("Manager access required", ErrorCodes.FORBIDDEN)
  }

  return handleDatabaseOperation(async () => {
    const results = await db.transaction(async tx => {
      const updateResults = []

      for (const update of validatedInput.updates) {
        // Get current product (for existence check / name)
        const product = await tx.query.products.findFirst({
          where: eq(products.id, update.productId)
        })

        if (!product) {
          throw new Error(`Product not found: ${update.productId}`)
        }

        // Atomically update stock — arithmetic done in PostgreSQL
        const updatedRows = await tx.execute(
          sql`UPDATE ${products} SET current_stock = current_stock::numeric + ${update.quantity}::numeric, updated_at = NOW() WHERE ${products.id} = ${update.productId} AND (current_stock::numeric + ${update.quantity}::numeric) >= 0 RETURNING current_stock, (current_stock::numeric - ${update.quantity}::numeric) AS previous_stock`
        )

        const updatedRow = updatedRows[0] as
          | { current_stock: string; previous_stock: string }
          | undefined

        if (!updatedRow) {
          throw new Error(
            `Invalid stock update for ${product.name}: would result in negative stock`
          )
        }

        const previousStock = parseFloat(updatedRow.previous_stock)
        const newStock = parseFloat(updatedRow.current_stock)

        // Record stock movement
        await tx.insert(stockMovements).values({
          productId: update.productId,
          movementType: update.movementType,
          quantity: update.quantity.toString(),
          previousStock: previousStock.toString(),
          newStock: newStock.toString(),
          reference: update.reason
        })

        updateResults.push({
          productId: update.productId,
          productName: product.name,
          previousStock,
          newStock,
          quantity: update.quantity
        })
      }

      return updateResults
    })

    return {
      updates: results,
      count: results.length
    }
  }, "Bulk stock update")
}

/**
 * Get inventory analytics and insights
 */
export async function getInventoryAnalytics(
  stationId: string,
  days: number = 30
): Promise<
  ApiResponse<{
    totalMovements: number
    salesCount: number
    deliveriesCount: number
    adjustmentsCount: number
    productActivity: Record<
      string,
      { name: string; movements: number; totalQuantity: number }
    >
    dailyTrends: Record<
      string,
      { sales: number; deliveries: number; adjustments: number }
    >
  }>
> {
  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  if (!stationId) {
    return createErrorResponse("Station ID is required", ErrorCodes.BAD_REQUEST)
  }

  return handleDatabaseOperation(async () => {
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    // Get stock movements for the period
    const movements = await db.query.stockMovements.findMany({
      where: and(
        gte(stockMovements.createdAt, startDate),
        sql`EXISTS (
          SELECT 1 FROM ${products} 
          WHERE ${products.id} = ${stockMovements.productId} 
          AND ${products.stationId} = ${stationId}
        )`
      ),
      with: {
        product: true
      }
    })

    // All movements are already filtered for this station
    const stationMovements = movements

    // Calculate analytics
    const analytics = {
      totalMovements: stationMovements.length,
      salesCount: stationMovements.filter(m => m.movementType === "sale")
        .length,
      deliveriesCount: stationMovements.filter(
        m => m.movementType === "delivery"
      ).length,
      adjustmentsCount: stationMovements.filter(
        m => m.movementType === "adjustment"
      ).length,
      productActivity: {} as Record<
        string,
        { name: string; movements: number; totalQuantity: number }
      >,
      dailyTrends: {} as Record<
        string,
        { sales: number; deliveries: number; adjustments: number }
      >
    }

    // Calculate product activity
    stationMovements.forEach(movement => {
      if (movement.product) {
        const product = movement.product as ProductData
        const productId = product.id
        if (!analytics.productActivity[productId]) {
          analytics.productActivity[productId] = {
            name: product.name,
            movements: 0,
            totalQuantity: 0
          }
        }
        analytics.productActivity[productId].movements++
        analytics.productActivity[productId].totalQuantity += Math.abs(
          parseFloat(movement.quantity)
        )
      }
    })

    // Calculate daily trends
    stationMovements.forEach(movement => {
      const date = movement.createdAt.toISOString().split("T")[0]
      if (!analytics.dailyTrends[date]) {
        analytics.dailyTrends[date] = {
          sales: 0,
          deliveries: 0,
          adjustments: 0
        }
      }
      const type = movement.movementType
      if (type === "sale") {
        analytics.dailyTrends[date].sales++
      } else if (type === "delivery") {
        analytics.dailyTrends[date].deliveries++
      } else {
        analytics.dailyTrends[date].adjustments++
      }
    })

    return analytics
  }, "Fetch inventory analytics")
}

/**
 * Generate reorder recommendations
 */
export async function generateReorderRecommendations(
  stationId: string
): Promise<
  ApiResponse<{
    recommendations: Array<{
      productId: string
      name: string
      brand: string | null
      type: "pms" | "lubricant"
      currentStock: number
      minThreshold: number
      recommendedQuantity: number
      avgDailySales: number
      daysUntilStockout: number | null
      supplier: {
        id: string
        name: string
        contactPerson: string | null
        phone: string | null
      } | null
      priority: "urgent" | "high" | "medium"
    }>
    summary: {
      totalProducts: number
      urgentCount: number
      highPriorityCount: number
      mediumPriorityCount: number
    }
  }>
> {
  // Check authentication
  const { userId } = await auth()
  if (!userId) {
    return createErrorResponse(
      "Authentication required",
      ErrorCodes.UNAUTHORIZED
    )
  }

  if (!stationId) {
    return createErrorResponse("Station ID is required", ErrorCodes.BAD_REQUEST)
  }

  return handleDatabaseOperation(async () => {
    // Get products that need reordering
    const productList = await db.query.products.findMany({
      where: and(
        eq(products.stationId, stationId),
        eq(products.isActive, true)
      ),
      with: {
        supplier: true,
        stockMovements: {
          where: eq(stockMovements.movementType, "sale"),
          orderBy: [desc(stockMovements.createdAt)],
          limit: 30 // Last 30 sales movements for trend analysis
        }
      }
    })

    const recommendations = productList
      .filter(product => {
        const currentStock = parseFloat(product.currentStock)
        const minThreshold = parseFloat(product.minThreshold)
        return currentStock <= minThreshold
      })
      .map(product => {
        const currentStock = parseFloat(product.currentStock)
        const minThreshold = parseFloat(product.minThreshold)

        // Calculate average daily sales from recent movements
        const salesMovements =
          (
            product as typeof products.$inferSelect & {
              stockMovements?: StockMovementData[]
            }
          ).stockMovements || []
        const totalSold = salesMovements.reduce(
          (sum: number, movement: StockMovementData) =>
            sum + Math.abs(parseFloat(movement.quantity)),
          0
        )
        const avgDailySales =
          salesMovements.length > 0
            ? totalSold / Math.min(salesMovements.length, 30)
            : 0

        // Calculate recommended order quantity (enough for 2 weeks + buffer)
        const recommendedQuantity = Math.max(
          minThreshold * 2, // At least double the minimum threshold
          avgDailySales * 14 + minThreshold // 2 weeks of sales + minimum threshold
        )

        return {
          productId: product.id,
          name: product.name,
          brand: product.brand,
          type: product.type,
          currentStock,
          minThreshold,
          recommendedQuantity: Math.ceil(recommendedQuantity),
          avgDailySales: Math.round(avgDailySales * 100) / 100,
          daysUntilStockout:
            avgDailySales > 0 ? Math.floor(currentStock / avgDailySales) : null,
          supplier: product.supplier
            ? {
                id: (product.supplier as SupplierData).id,
                name: (product.supplier as SupplierData).name,
                contactPerson: (product.supplier as SupplierData).contactPerson,
                phone: (product.supplier as SupplierData).phone
              }
            : null,
          priority: (currentStock === 0
            ? "urgent"
            : currentStock <= minThreshold * 0.5
              ? "high"
              : "medium") as "urgent" | "high" | "medium"
        }
      })
      .sort((a, b) => {
        // Sort by priority: urgent > high > medium, then by days until stockout
        const priorityOrder = { urgent: 3, high: 2, medium: 1 }
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[b.priority] - priorityOrder[a.priority]
        }
        return (a.daysUntilStockout || 0) - (b.daysUntilStockout || 0)
      })

    return {
      recommendations,
      summary: {
        totalProducts: recommendations.length,
        urgentCount: recommendations.filter(r => r.priority === "urgent")
          .length,
        highPriorityCount: recommendations.filter(r => r.priority === "high")
          .length,
        mediumPriorityCount: recommendations.filter(
          r => r.priority === "medium"
        ).length
      }
    }
  }, "Generate reorder recommendations")
}
