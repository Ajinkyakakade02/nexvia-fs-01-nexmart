import mongoose from 'mongoose';
import Order, { IOrder } from '../models/Order.js';
import Cart from '../models/Cart.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { OrderStatus, PaymentStatus, UserRole } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { generateOrderNumber } from '../utils/generateOrderNumber.js';
import { validateCoupon, recordCouponUsage } from './couponService.js';
import { clearCart } from './cartService.js';

export const createOrder = async (
  customerId: string,
  shippingAddressIndex: number,
  couponCode?: string
) => {
  const user = await User.findById(customerId);
  if (!user) {
    throw ApiError.notFound('Customer not found');
  }

  const shippingAddress = user.addresses[shippingAddressIndex];
  if (!shippingAddress) {
    throw ApiError.badRequest('Invalid shipping address selected');
  }

  // 1. Fetch Cart
  const cart = await Cart.findOne({ customer: customerId });
  if (!cart || cart.items.length === 0) {
    throw ApiError.badRequest('Cannot place an order with an empty cart');
  }

  // 2. Validate current stock & price directly from MongoDB
  const validatedItems: any[] = [];
  const vendorGroupMap = new Map<string, any[]>();
  let calculatedSubtotal = 0;

  for (const item of cart.items) {
    const product = await Product.findOne({ _id: item.product, isDeleted: false });
    if (!product) {
      throw ApiError.badRequest(`Product in cart is no longer available`);
    }

    if (product.stock < item.quantity) {
      throw ApiError.badRequest(
        `Insufficient stock for "${product.name}". Available: ${product.stock}`
      );
    }

    const itemSubtotal = Math.round(product.price * item.quantity * 100) / 100;
    calculatedSubtotal += itemSubtotal;

    const orderItem = {
      product: product._id,
      vendor: product.vendor,
      name: product.name,
      price: product.price,
      quantity: item.quantity,
      subtotal: itemSubtotal,
      image: product.images?.[0] || ''
    };

    validatedItems.push(orderItem);

    // Group items by vendor
    const vId = product.vendor.toString();
    if (!vendorGroupMap.has(vId)) {
      vendorGroupMap.set(vId, []);
    }
    vendorGroupMap.get(vId)!.push({
      product: product._id,
      name: product.name,
      price: product.price,
      quantity: item.quantity,
      subtotal: itemSubtotal,
      image: product.images?.[0] || ''
    });
  }

  // 3. Coupon validation & discount calculation
  let discountAmount = 0;
  let appliedCouponCode: string | undefined = undefined;

  if (couponCode) {
    const couponResult = await validateCoupon(couponCode, calculatedSubtotal, customerId);
    discountAmount = couponResult.discountAmount;
    appliedCouponCode = couponResult.code;
  }

  // Shipping calculation (Demo rule: free over ₹500, else ₹50)
  const shippingCost = calculatedSubtotal >= 500 ? 0 : 50;
  const total = Math.max(0, calculatedSubtotal - discountAmount + shippingCost);

  // 4. Build vendorOrders suborders
  const vendorOrders = [];
  for (const [vendorId, items] of vendorGroupMap.entries()) {
    const subtotal = items.reduce((acc, it) => acc + it.subtotal, 0);
    vendorOrders.push({
      vendor: new mongoose.Types.ObjectId(vendorId),
      items,
      subtotal,
      status: OrderStatus.PLACED,
      statusHistory: [
        {
          status: OrderStatus.PLACED,
          changedAt: new Date(),
          changedBy: `Customer (${customerId})`,
          comment: 'Order placed'
        }
      ]
    });
  }

  // 5. Atomic stock reduction & sold count increment
  for (const item of validatedItems) {
    await Product.findByIdAndUpdate(item.product, {
      $inc: {
        stock: -item.quantity,
        soldCount: item.quantity
      }
    });
  }

  // 6. Create Order
  const orderNumber = generateOrderNumber();
  const order = new Order({
    customer: customerId,
    orderNumber,
    items: validatedItems,
    shippingAddress,
    subtotal: calculatedSubtotal,
    discount: discountAmount,
    couponCode: appliedCouponCode,
    shippingCost,
    tax: 0,
    total,
    paymentStatus: PaymentStatus.PENDING,
    overallStatus: OrderStatus.PLACED,
    vendorOrders
  });

  await order.save();

  // 7. Record coupon usage
  if (appliedCouponCode) {
    await recordCouponUsage(appliedCouponCode, customerId);
  }

  // 8. Clear customer cart
  await clearCart(customerId);

  return order;
};

export const getCustomerOrders = async (
  customerId: string,
  params: { page?: number; limit?: number }
) => {
  const { page = 1, limit = 10 } = params;
  const skip = (page - 1) * limit;

  const [orders, total] = await Promise.all([
    Order.find({ customer: customerId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('vendorOrders.vendor', 'name')
      .lean(),
    Order.countDocuments({ customer: customerId })
  ]);

  return {
    data: orders,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

export const getOrderById = async (orderId: string, userId: string, role: UserRole) => {
  const order = await Order.findById(orderId)
    .populate('customer', 'name email phone')
    .populate('vendorOrders.vendor', 'name email')
    .populate('items.product', 'name images slug price');

  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  // Access check: Customer can only view their own order
  if (role === UserRole.CUSTOMER && order.customer._id.toString() !== userId) {
    throw ApiError.forbidden('You do not have permission to view this order');
  }

  // Vendor can only view suborder details relating to their products
  if (role === UserRole.VENDOR) {
    const isVendorInOrder = order.vendorOrders.some((vo) => vo.vendor._id.toString() === userId);
    if (!isVendorInOrder) {
      throw ApiError.forbidden('You do not have permission to view this order');
    }
  }

  return order;
};

export const getOrderTracking = async (orderId: string, userId: string, role: UserRole) => {
  const order = await getOrderById(orderId, userId, role);

  return {
    orderNumber: order.orderNumber,
    overallStatus: order.overallStatus,
    createdAt: order.createdAt,
    vendorOrders: order.vendorOrders.map((vo) => ({
      vendor: vo.vendor,
      items: vo.items,
      subtotal: vo.subtotal,
      status: vo.status,
      trackingNumber: vo.trackingNumber,
      statusHistory: vo.statusHistory
    }))
  };
};

export const adminGetAllOrders = async (params: {
  page?: number;
  limit?: number;
  status?: string;
  paymentStatus?: string;
  search?: string;
}) => {
  const { page = 1, limit = 10, status, paymentStatus, search } = params;
  const skip = (page - 1) * limit;

  const query: any = {};
  if (status) query.overallStatus = status;
  if (paymentStatus) query.paymentStatus = paymentStatus;
  if (search) query.orderNumber = { $regex: search, $options: 'i' };

  const [orders, total] = await Promise.all([
    Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name email phone')
      .lean(),
    Order.countDocuments(query)
  ]);

  return {
    data: orders,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

