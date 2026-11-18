import Coupon, { ICoupon } from '../models/Coupon.js';
import { DiscountType } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';

export const validateCoupon = async (code: string, orderTotal: number, userId?: string) => {
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
  if (!coupon) {
    throw ApiError.badRequest('Invalid or inactive coupon code');
  }

  // Check expiration
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    throw ApiError.badRequest('Coupon has expired');
  }

  // Check total usage limit
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw ApiError.badRequest('Coupon usage limit reached');
  }

  // Check minimum order value
  if (coupon.minOrderValue && orderTotal < coupon.minOrderValue) {
    throw ApiError.badRequest(
      `Minimum order value of ₹${coupon.minOrderValue} required for this coupon`
    );
  }

  // Check per-user usage limit if userId provided
  if (userId && coupon.perUserLimit) {
    const userUses = coupon.usedBy.filter((id) => id.toString() === userId).length;
    if (userUses >= coupon.perUserLimit) {
      throw ApiError.badRequest('You have already used this coupon the maximum allowed times');
    }
  }

  // Calculate discount
  let discount = 0;
  if (coupon.discountType === DiscountType.PERCENTAGE) {
    discount = (orderTotal * coupon.discountValue) / 100;
    if (coupon.maxDiscount && discount > coupon.maxDiscount) {
      discount = coupon.maxDiscount;
    }
  } else {
    discount = Math.min(coupon.discountValue, orderTotal);
  }

  discount = Math.round(discount * 100) / 100;

  return {
    valid: true,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discountAmount: discount,
    finalTotal: Math.max(0, orderTotal - discount)
  };
};

export const recordCouponUsage = async (code: string, userId: string) => {
  await Coupon.findOneAndUpdate(
    { code: code.toUpperCase() },
    {
      $inc: { usedCount: 1 },
      $push: { usedBy: userId }
    }
  );
};

export const createCoupon = async (data: {
  code: string;
  discountType: DiscountType;
  discountValue: number;
  minOrderValue?: number;
  maxDiscount?: number;
  expiryDate: Date;
  usageLimit?: number;
  perUserLimit?: number;
  isActive?: boolean;
}) => {
  const existing = await Coupon.findOne({ code: data.code.toUpperCase() });
  if (existing) {
    throw ApiError.conflict('Coupon code already exists');
  }

  const coupon = new Coupon({
    ...data,
    code: data.code.toUpperCase()
  });

  await coupon.save();
  return coupon;
};

export const updateCoupon = async (id: string, data: Partial<ICoupon>) => {
  const coupon = await Coupon.findById(id);
  if (!coupon) {
    throw ApiError.notFound('Coupon not found');
  }

  if (data.code && data.code.toUpperCase() !== coupon.code) {
    const existing = await Coupon.findOne({
      _id: { $ne: id },
      code: data.code.toUpperCase()
    });
    if (existing) {
      throw ApiError.conflict('Coupon code already exists');
    }
    coupon.code = data.code.toUpperCase();
  }

  if (data.discountType !== undefined) coupon.discountType = data.discountType;
  if (data.discountValue !== undefined) coupon.discountValue = data.discountValue;
  if (data.minOrderValue !== undefined) coupon.minOrderValue = data.minOrderValue;
  if (data.maxDiscount !== undefined) coupon.maxDiscount = data.maxDiscount;
  if (data.expiryDate !== undefined) coupon.expiryDate = data.expiryDate;
  if (data.usageLimit !== undefined) coupon.usageLimit = data.usageLimit;
  if (data.perUserLimit !== undefined) coupon.perUserLimit = data.perUserLimit;
  if (data.isActive !== undefined) coupon.isActive = data.isActive;

  await coupon.save();
  return coupon;
};

export const deleteCoupon = async (id: string) => {
  const coupon = await Coupon.findByIdAndDelete(id);
  if (!coupon) {
    throw ApiError.notFound('Coupon not found');
  }
  return { message: 'Coupon deleted successfully' };
};

export const getCoupons = async (params: { page?: number; limit?: number }) => {
  const { page = 1, limit = 20 } = params;
  const skip = (page - 1) * limit;

  const [coupons, total] = await Promise.all([
    Coupon.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
    Coupon.countDocuments()
  ]);

  return {
    data: coupons,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

