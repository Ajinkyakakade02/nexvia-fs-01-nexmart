import mongoose from 'mongoose';
import VendorProfile, { IVendorProfile } from '../models/VendorProfile.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import Commission from '../models/Commission.js';
import { OnboardingStatus, OrderStatus, UserRole } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';

export const apply = async (
  userId: string,
  data: {
    businessName: string;
    businessDescription: string;
    businessEmail: string;
    businessPhone: string;
    businessAddress: any;
    gstNumber?: string;
  }
) => {
  let profile = await VendorProfile.findOne({ user: userId });

  if (profile && profile.onboardingStatus === OnboardingStatus.APPROVED) {
    throw ApiError.badRequest('Vendor profile is already approved');
  }

  if (profile && profile.onboardingStatus === OnboardingStatus.PENDING) {
    throw ApiError.badRequest('A vendor onboarding application is already pending review');
  }

  if (!profile) {
    profile = new VendorProfile({
      user: userId,
      ...data,
      onboardingStatus: OnboardingStatus.PENDING
    });
  } else {
    Object.assign(profile, data, {
      onboardingStatus: OnboardingStatus.PENDING,
      adminNotes: undefined
    });
  }

  await profile.save();

  // Update user role to VENDOR
  await User.findByIdAndUpdate(userId, { role: UserRole.VENDOR });

  return profile;
};

export const getProfile = async (userId: string) => {
  const profile = await VendorProfile.findOne({ user: userId });
  if (!profile) {
    throw ApiError.notFound('Vendor profile not found');
  }
  return profile;
};

export const getStatus = async (userId: string) => {
  const profile = await VendorProfile.findOne({ user: userId });
  if (!profile) {
    return { onboardingStatus: 'NOT_APPLIED' };
  }
  return {
    onboardingStatus: profile.onboardingStatus,
    adminNotes: profile.adminNotes,
    approvedAt: profile.approvedAt,
    rejectedAt: profile.rejectedAt
  };
};

export const getDashboard = async (userId: string) => {
  const vendorObjId = new mongoose.Types.ObjectId(userId);

  const totalProducts = await Product.countDocuments({ vendor: vendorObjId, isDeleted: false });

  // Aggregation for vendor orders and revenue
  const stats = await Order.aggregate([
    { $unwind: '$vendorOrders' },
    { $match: { 'vendorOrders.vendor': vendorObjId } },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalRevenue: { $sum: '$vendorOrders.subtotal' }
      }
    }
  ]);

  const totalOrders = stats[0]?.totalOrders || 0;
  const totalRevenue = stats[0]?.totalRevenue || 0;

  // Vendor commissions
  const commStats = await Commission.aggregate([
    { $match: { vendor: vendorObjId } },
    {
      $group: {
        _id: null,
        totalCommission: { $sum: '$commissionAmount' },
        totalNet: { $sum: '$vendorNetAmount' }
      }
    }
  ]);

  const totalCommission = commStats[0]?.totalCommission || 0;
  const totalNet = commStats[0]?.totalNet || totalRevenue - totalCommission;

  // Recent 5 orders
  const recentOrders = await Order.find({ 'vendorOrders.vendor': vendorObjId })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('customer', 'name email');

  // Filter vendorOrders in recentOrders to only this vendor
  const formattedRecent = recentOrders.map((ord) => {
    const vo = ord.vendorOrders.find((v) => v.vendor.toString() === userId);
    return {
      orderId: ord._id,
      orderNumber: ord.orderNumber,
      customer: ord.customer,
      items: vo?.items || [],
      subtotal: vo?.subtotal || 0,
      status: vo?.status || ord.overallStatus,
      createdAt: ord.createdAt
    };
  });

  return {
    totalProducts,
    totalOrders,
    totalRevenue,
    totalCommission,
    totalNet,
    recentOrders: formattedRecent
  };
};

export const getOrders = async (
  userId: string,
  options: { page?: number; limit?: number; status?: string }
) => {
  const { page = 1, limit = 10, status } = options;
  const skip = (page - 1) * limit;
  const vendorObjId = new mongoose.Types.ObjectId(userId);

  const matchQuery: any = { 'vendorOrders.vendor': vendorObjId };
  if (status) {
    matchQuery['vendorOrders.status'] = status;
  }

  const [orders, total] = await Promise.all([
    Order.find(matchQuery)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name email phone')
      .lean(),
    Order.countDocuments(matchQuery)
  ]);

  // Transform each order to highlight the vendor's suborder
  const data = orders.map((ord: any) => {
    const suborder = ord.vendorOrders.find((vo: any) => vo.vendor.toString() === userId);
    return {
      _id: ord._id,
      orderNumber: ord.orderNumber,
      createdAt: ord.createdAt,
      customer: ord.customer,
      shippingAddress: ord.shippingAddress,
      suborder: suborder || null,
      paymentStatus: ord.paymentStatus
    };
  });

  return {
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

export const updateOrderStatus = async (
  vendorId: string,
  orderId: string,
  newStatus: OrderStatus,
  comment?: string,
  trackingNumber?: string
) => {
  const order = await Order.findById(orderId);
  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  const suborder = order.vendorOrders.find((vo) => vo.vendor.toString() === vendorId);
  if (!suborder) {
    throw ApiError.forbidden('You are not authorized to update this order');
  }

  // Validate state transitions
  const validTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.PLACED]: [OrderStatus.PACKED, OrderStatus.CANCELLED],
    [OrderStatus.PACKED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
    [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
    [OrderStatus.DELIVERED]: [],
    [OrderStatus.CANCELLED]: []
  };

  const allowed = validTransitions[suborder.status] || [];
  if (!allowed.includes(newStatus)) {
    throw ApiError.badRequest(
      `Invalid status transition from ${suborder.status} to ${newStatus}`
    );
  }

  suborder.status = newStatus;
  if (trackingNumber) {
    suborder.trackingNumber = trackingNumber;
  }

  suborder.statusHistory.push({
    status: newStatus,
    changedAt: new Date(),
    changedBy: `Vendor (${vendorId})`,
    comment
  });

  // Check if all suborders are delivered
  const allDelivered = order.vendorOrders.every((vo) => vo.status === OrderStatus.DELIVERED);
  if (allDelivered) {
    order.overallStatus = OrderStatus.DELIVERED;
  } else if (order.vendorOrders.some((vo) => vo.status === OrderStatus.SHIPPED)) {
    order.overallStatus = OrderStatus.SHIPPED;
  } else if (order.vendorOrders.some((vo) => vo.status === OrderStatus.PACKED)) {
    order.overallStatus = OrderStatus.PACKED;
  }

  await order.save();
  return suborder;
};

