import mongoose from 'mongoose';
import prisma, { isPrismaAvailable } from '../config/prisma.js';
import VendorProfile, { IVendorProfile } from '../models/VendorProfile.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import Commission from '../models/Commission.js';
import { OnboardingStatus, OrderStatus, UserRole } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { serializePrisma, toDecimal } from '../utils/prismaSerializer.js';

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
  if (isPrismaAvailable()) {
    let profile = await prisma.vendorProfile.findUnique({ where: { userId } });

    if (profile && profile.onboardingStatus === OnboardingStatus.APPROVED) {
      throw ApiError.badRequest('Vendor profile is already approved');
    }

    if (profile && profile.onboardingStatus === OnboardingStatus.PENDING) {
      throw ApiError.badRequest('A vendor onboarding application is already pending review');
    }

    if (!profile) {
      profile = await prisma.vendorProfile.create({
        data: {
          userId,
          businessName: data.businessName,
          businessDescription: data.businessDescription,
          businessEmail: data.businessEmail,
          businessPhone: data.businessPhone,
          businessAddress: data.businessAddress,
          gstNumber: data.gstNumber,
          onboardingStatus: OnboardingStatus.PENDING
        }
      });
    } else {
      profile = await prisma.vendorProfile.update({
        where: { userId },
        data: {
          businessName: data.businessName,
          businessDescription: data.businessDescription,
          businessEmail: data.businessEmail,
          businessPhone: data.businessPhone,
          businessAddress: data.businessAddress,
          gstNumber: data.gstNumber,
          onboardingStatus: OnboardingStatus.PENDING,
          adminNotes: null
        }
      });
    }

    // Update user role to VENDOR
    await prisma.user.update({
      where: { id: userId },
      data: { role: UserRole.VENDOR }
    });

    return serializePrisma(profile);
  }

  // Fallback to Mongoose
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
  if (isPrismaAvailable()) {
    const profile = await prisma.vendorProfile.findUnique({
      where: { userId },
      include: { user: { select: { name: true, email: true, phone: true } } }
    });
    if (!profile) {
      throw ApiError.notFound('Vendor profile not found');
    }
    return serializePrisma(profile);
  }

  const profile = await VendorProfile.findOne({ user: userId });
  if (!profile) {
    throw ApiError.notFound('Vendor profile not found');
  }
  return profile;
};

export const getStatus = async (userId: string) => {
  if (isPrismaAvailable()) {
    const profile = await prisma.vendorProfile.findUnique({ where: { userId } });
    if (!profile) {
      return { onboardingStatus: 'NOT_APPLIED' };
    }
    return {
      onboardingStatus: profile.onboardingStatus,
      adminNotes: profile.adminNotes,
      approvedAt: profile.approvedAt,
      rejectedAt: profile.rejectedAt
    };
  }

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
  if (isPrismaAvailable()) {
    const vendorProfile = await prisma.vendorProfile.findUnique({ where: { userId } });
    const vendorId = vendorProfile ? vendorProfile.id : userId;

    const totalProducts = await prisma.product.count({
      where: { vendorId, isDeleted: false }
    });

    const vendorOrders = await prisma.vendorOrder.findMany({
      where: { vendorId },
      include: {
        order: {
          include: {
            customer: { select: { id: true, name: true, email: true } }
          }
        },
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const totalOrders = vendorOrders.length;
    const totalRevenue = vendorOrders.reduce((sum, vo) => sum + Number(vo.subtotal), 0);

    const commissions = await prisma.commission.findMany({
      where: { vendorId }
    });

    const totalCommission = commissions.reduce((sum, c) => sum + Number(c.commissionAmount), 0);
    const totalNet = commissions.reduce(
      (sum, c) => sum + Number(c.vendorNetAmount),
      totalRevenue - totalCommission
    );

    const recentOrders = vendorOrders.slice(0, 5).map((vo) => ({
      orderId: vo.orderId,
      orderNumber: vo.order.orderNumber,
      customer: vo.order.customer,
      items: vo.items,
      subtotal: Number(vo.subtotal),
      status: vo.status,
      createdAt: vo.createdAt
    }));

    return serializePrisma({
      totalProducts,
      totalOrders,
      totalRevenue,
      totalCommission,
      totalNet,
      recentOrders
    });
  }

  // Fallback to Mongoose
  const vendorObjId = new mongoose.Types.ObjectId(userId);

  const totalProducts = await Product.countDocuments({ vendor: vendorObjId, isDeleted: false });

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

  const recentOrders = await Order.find({ 'vendorOrders.vendor': vendorObjId })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('customer', 'name email');

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

  if (isPrismaAvailable()) {
    const vendorProfile = await prisma.vendorProfile.findUnique({ where: { userId } });
    const vendorId = vendorProfile ? vendorProfile.id : userId;

    const where: any = { vendorId };
    if (status) {
      where.status = status as OrderStatus;
    }

    const [vendorOrders, total] = await Promise.all([
      prisma.vendorOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: {
            include: {
              customer: { select: { id: true, name: true, email: true, phone: true } }
            }
          },
          items: true
        }
      }),
      prisma.vendorOrder.count({ where })
    ]);

    const data = vendorOrders.map((vo) => ({
      _id: vo.order.id,
      id: vo.order.id,
      orderNumber: vo.order.orderNumber,
      createdAt: vo.order.createdAt,
      customer: vo.order.customer,
      shippingAddress: vo.order.shippingAddressSnapshot,
      suborder: {
        _id: vo.id,
        id: vo.id,
        vendor: vo.vendorId,
        items: vo.items,
        subtotal: Number(vo.subtotal),
        status: vo.status,
        trackingNumber: vo.trackingNumber
      },
      paymentStatus: vo.order.paymentStatus
    }));

    return serializePrisma({
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  }

  // Fallback to Mongoose
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
  if (isPrismaAvailable()) {
    const vendorProfile = await prisma.vendorProfile.findUnique({ where: { userId: vendorId } });
    const resolvedVendorId = vendorProfile ? vendorProfile.id : vendorId;

    const suborder = await prisma.vendorOrder.findFirst({
      where: {
        orderId,
        vendorId: resolvedVendorId
      },
      include: { order: { include: { vendorOrders: true } } }
    });

    if (!suborder) {
      throw ApiError.forbidden('You are not authorized to update this order');
    }

    const validTransitions: Record<OrderStatus, OrderStatus[]> = {
      [OrderStatus.PLACED]: [OrderStatus.PACKED, OrderStatus.CANCELLED],
      [OrderStatus.PACKED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
      [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
      [OrderStatus.DELIVERED]: [],
      [OrderStatus.CANCELLED]: []
    };

    const allowed = validTransitions[suborder.status as OrderStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw ApiError.badRequest(
        `Invalid status transition from ${suborder.status} to ${newStatus}`
      );
    }

    return await prisma.$transaction(async (tx) => {
      const updatedSuborder = await tx.vendorOrder.update({
        where: { id: suborder.id },
        data: {
          status: newStatus,
          ...(trackingNumber ? { trackingNumber } : {})
        }
      });

      await tx.vendorOrderStatusHistory.create({
        data: {
          vendorOrderId: suborder.id,
          status: newStatus,
          changedBy: `Vendor (${vendorId})`,
          comment: comment || `Status updated to ${newStatus}`
        }
      });

      // Recalculate overall master order status
      const allSuborders = await tx.vendorOrder.findMany({ where: { orderId } });
      const allDelivered = allSuborders.every((vo) => vo.status === OrderStatus.DELIVERED);
      const someShipped = allSuborders.some((vo) => vo.status === OrderStatus.SHIPPED);
      const somePacked = allSuborders.some((vo) => vo.status === OrderStatus.PACKED);

      let overallStatus = suborder.order.overallStatus;
      if (allDelivered) {
        overallStatus = OrderStatus.DELIVERED;
      } else if (someShipped) {
        overallStatus = OrderStatus.SHIPPED;
      } else if (somePacked) {
        overallStatus = OrderStatus.PACKED;
      }

      if (overallStatus !== suborder.order.overallStatus) {
        await tx.order.update({
          where: { id: orderId },
          data: { overallStatus }
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            status: overallStatus,
            changedBy: `System (Vendor order status update)`,
            comment: `Master order transitioned to ${overallStatus}`
          }
        });
      }

      return serializePrisma(updatedSuborder);
    });
  }

  // Fallback to Mongoose
  const order = await Order.findById(orderId);
  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  const suborder = order.vendorOrders.find((vo) => vo.vendor.toString() === vendorId);
  if (!suborder) {
    throw ApiError.forbidden('You are not authorized to update this order');
  }

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
