import { z } from 'zod';
import { OrderStatus } from '../types/index.js';

export const createOrderSchema = z.object({
  shippingAddressId: z.union([z.string(), z.number()]).optional(),
  shippingAddress: z
    .object({
      fullName: z.string().min(2),
      phone: z.string().min(8),
      street: z.string().min(3),
      city: z.string().min(2),
      state: z.string().min(2),
      postalCode: z.string().min(3),
      country: z.string().default('India')
    })
    .optional(),
  couponCode: z.string().optional()
}).refine((data) => data.shippingAddressId !== undefined || data.shippingAddress !== undefined, {
  message: 'Either shippingAddressId or shippingAddress object must be provided'
});

export const updateOrderStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus),
  trackingNumber: z.string().optional(),
  comment: z.string().optional()
});
