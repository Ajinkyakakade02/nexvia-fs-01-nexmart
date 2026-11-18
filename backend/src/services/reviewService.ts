import mongoose from 'mongoose';
import Review, { IReview } from '../models/Review.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import { OrderStatus, UserRole } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';

export const recalculateProductRating = async (productId: string) => {
  const stats = await Review.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId), isApproved: true } },
    {
      $group: {
        _id: '$product',
        avgRating: { $avg: '$rating' },
        ratingCount: { $sum: 1 }
      }
    }
  ]);

  const avgRating = stats[0] ? Math.round(stats[0].avgRating * 10) / 10 : 0;
  const ratingCount = stats[0]?.ratingCount || 0;

  await Product.findByIdAndUpdate(productId, { avgRating, ratingCount });
  return { avgRating, ratingCount };
};

export const createReview = async (
  customerId: string,
  data: {
    productId: string;
    rating: number;
    title?: string;
    comment: string;
  }
) => {
  const product = await Product.findOne({ _id: data.productId, isDeleted: false });
  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  // One review per customer per product
  const existingReview = await Review.findOne({
    customer: customerId,
    product: data.productId
  });

  if (existingReview) {
    throw ApiError.conflict('You have already submitted a review for this product');
  }

  // Check verified purchase (customer has delivered order containing product)
  const deliveredOrder = await Order.findOne({
    customer: customerId,
    overallStatus: OrderStatus.DELIVERED,
    'items.product': data.productId
  });

  const isVerifiedPurchase = !!deliveredOrder;

  const review = new Review({
    customer: customerId,
    product: data.productId,
    order: deliveredOrder?._id,
    rating: data.rating,
    title: data.title,
    comment: data.comment,
    isVerifiedPurchase,
    isApproved: true
  });

  await review.save();
  await recalculateProductRating(data.productId);

  return review;
};

export const updateReview = async (
  customerId: string,
  reviewId: string,
  data: { rating?: number; title?: string; comment?: string }
) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw ApiError.notFound('Review not found');
  }

  if (review.customer.toString() !== customerId) {
    throw ApiError.forbidden('You can only update your own review');
  }

  if (data.rating !== undefined) review.rating = data.rating;
  if (data.title !== undefined) review.title = data.title;
  if (data.comment !== undefined) review.comment = data.comment;

  await review.save();
  await recalculateProductRating(review.product.toString());

  return review;
};

export const deleteReview = async (userId: string, role: UserRole, reviewId: string) => {
  const review = await Review.findById(reviewId);
  if (!review) {
    throw ApiError.notFound('Review not found');
  }

  if (role !== UserRole.ADMIN && review.customer.toString() !== userId) {
    throw ApiError.forbidden('You do not have permission to delete this review');
  }

  const productId = review.product.toString();
  await review.deleteOne();
  await recalculateProductRating(productId);

  return { message: 'Review deleted successfully' };
};

export const getProductReviews = async (
  productId: string,
  params: { page?: number; limit?: number }
) => {
  const { page = 1, limit = 10 } = params;
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    Review.find({ product: productId, isApproved: true })
      .populate('customer', 'name avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Review.countDocuments({ product: productId, isApproved: true })
  ]);

  return {
    data: reviews,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

