import { z } from 'zod';
import { ProductStatus } from '../types/index.js';

export const createProductSchema = z.object({
  name: z.string().min(2, 'Product name must be at least 2 characters'),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  price: z.coerce.number().positive('Price must be greater than 0'),
  comparePrice: z.coerce.number().positive('Compare price must be greater than 0').optional(),
  stock: z.coerce.number().int().nonnegative('Stock cannot be negative').default(0),
  categoryId: z.string().min(1, 'Category is required'),
  images: z.array(z.string().url()).optional().default([]),
  status: z.nativeEnum(ProductStatus).optional().default(ProductStatus.DRAFT),
  searchKeywords: z.array(z.string()).optional()
});

export const updateProductSchema = createProductSchema.partial();

export const productQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  category: z.string().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  search: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  vendor: z.string().optional(),
  status: z.nativeEnum(ProductStatus).optional()
});
