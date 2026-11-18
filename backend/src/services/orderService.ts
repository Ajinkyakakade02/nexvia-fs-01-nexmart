import mongoose from 'mongoose';
import prisma, { isPrismaAvailable } from '../config/prisma.js';
import Order, { IOrder } from '../models/Order.js';
import Cart from '../models/Cart.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { OrderStatus, PaymentStatus, UserRole } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { generateOrderNumber } from '../utils/generateOrderNumber.js';
import { validateCoupon, recordCouponUsage } from './couponService.js';
import { clearCart } from './cartService.js';
import { serializePrisma, toDecimal } from '../utils/prismaSerializer.js';

export const createOrder = async (
  customerId: string,
  shippingAddressInput:
    | number
    | {
        shippingAddressId?: string | number;
        shippingAddress?: any;
      },
  couponCode?: string
) => {
  // Normalize address input
  let rawAddressObj: any = undefined;
  let addressLookupId: string | number | undefined = undefined;

  if (typeof shippingAddressInput === 'number') {
    addressLookupId = shippingAddressInput;
  } else if (shippingAddressInput && typeof shippingAddressInput === 'object') {
    if (shippingAddressInput.shippingAddress) {
      rawAddressObj = shippingAddressInput.shippingAddress;
    }
    if (shippingAddressInput.shippingAddressId !== undefined) {
      addressLookupId = shippingAddressInput.shippingAddressId;
    }
  }

  if (isPrismaAvailable()) {
    const user = await prisma.user.findUnique({
      where: { id: customerId },
      include: {
        addresses: { orderBy: { createdAt: 'desc' } },
        cart: {
          include: {
            items: {
              include: {
                product: {
                  include: { vendor: true }
                }
              }
            }
          }
        }
      }
    });

    if (!user) {
      throw ApiError.notFound('Customer not found');
    }

    let shippingAddress: any = null;

    if (rawAddressObj) {
      const street =
        rawAddressObj.street ||
        rawAddressObj.addressLine1 +
          (rawAddressObj.addressLine2 ? ', ' + rawAddressObj.addressLine2 : '');
      const postalCode = rawAddressObj.postalCode || rawAddressObj.pincode;

      let existing = await prisma.address.findFirst({
        where: {
          userId: customerId,
          street,
          city: rawAddressObj.city,
          postalCode
        }
      });

      if (!existing) {
        existing = await prisma.address.create({
          data: {
            userId: customerId,
            fullName: rawAddressObj.fullName || user.name,
            phone: rawAddressObj.phone || user.phone || '0000000000',
            street,
            city: rawAddressObj.city,
            state: rawAddressObj.state,
            postalCode,
            country: rawAddressObj.country || 'India',
            isDefault: user.addresses.length === 0
          }
        });
      }
      shippingAddress = existing;
    } else if (addressLookupId !== undefined) {
      if (typeof addressLookupId === 'number' || (/^\d+$/.test(String(addressLookupId)) && !isNaN(Number(addressLookupId)))) {
        const idx = Number(addressLookupId);
        shippingAddress = user.addresses[idx];
      } else {
        const idStr = String(addressLookupId);
        shippingAddress =
          user.addresses.find((a) => a.id === idStr) ||
          (await prisma.address.findUnique({ where: { id: idStr } }));
      }
    }

    if (!shippingAddress) {
      throw ApiError.badRequest('Invalid shipping address selected');
    }

    const cart = user.cart;
    if (!cart || cart.items.length === 0) {
      throw ApiError.badRequest('Cannot place an order with an empty cart');
    }

    // Validate stock and group by vendor
    const validatedItems: any[] = [];
    const vendorGroupMap = new Map<string, any[]>();
    let calculatedSubtotal = 0;

    for (const item of cart.items) {
      const product = item.product;
      if (!product || product.isDeleted || product.status !== 'ACTIVE') {
        throw ApiError.badRequest(`Product "${product?.name || 'Item'}" is no longer available`);
      }

      if (product.stock < item.quantity) {
        throw ApiError.badRequest(
          `Insufficient stock for "${product.name}". Available: ${product.stock}`
        );
      }

      const itemPrice = Number(product.price);
      const itemSubtotal = Math.round(itemPrice * item.quantity * 100) / 100;
      calculatedSubtotal += itemSubtotal;

      const orderItem = {
        productId: product.id,
        vendorId: product.vendorId,
        productName: product.name,
        unitPrice: toDecimal(itemPrice),
        quantity: item.quantity,
        subtotal: toDecimal(itemSubtotal),
        imageUrl: product.images?.[0] || ''
      };

      validatedItems.push(orderItem);

      if (!vendorGroupMap.has(product.vendorId)) {
        vendorGroupMap.set(product.vendorId, []);
      }
      vendorGroupMap.get(product.vendorId)!.push(orderItem);
    }

    // Coupon calculation
    let discountAmount = 0;
    let appliedCouponCode: string | undefined = undefined;

    if (couponCode) {
      const couponResult = await validateCoupon(couponCode, calculatedSubtotal, customerId);
      discountAmount = couponResult.discountAmount;
      appliedCouponCode = couponResult.code;
    }

    const shippingCost = calculatedSubtotal >= 500 ? 0 : 50;
    const total = Math.max(0, calculatedSubtotal - discountAmount + shippingCost);
    const orderNumber = generateOrderNumber();

    const createdOrder = await prisma.$transaction(async (tx) => {
      // 1. Decrement stock
      for (const item of validatedItems) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stock: { decrement: item.quantity },
            soldCount: { increment: item.quantity }
          }
        });
      }

      // 2. Create Master Order
      const newOrder = await tx.order.create({
        data: {
          customerId,
          orderNumber,
          shippingAddressId: shippingAddress.id,
          shippingAddressSnapshot: {
            fullName: shippingAddress.fullName,
            phone: shippingAddress.phone,
            street: shippingAddress.street,
            city: shippingAddress.city,
            state: shippingAddress.state,
            postalCode: shippingAddress.postalCode,
            country: shippingAddress.country
          },
          subtotal: toDecimal(calculatedSubtotal),
          discount: toDecimal(discountAmount),
          shippingCost: toDecimal(shippingCost),
          tax: toDecimal(0),
          total: toDecimal(total),
          paymentStatus: PaymentStatus.PENDING,
          overallStatus: OrderStatus.PLACED
        }
      });

      // 3. Create Status History
      await tx.orderStatusHistory.create({
        data: {
          orderId: newOrder.id,
          status: OrderStatus.PLACED,
          changedBy: `Customer (${customerId})`,
          comment: 'Order placed'
        }
      });

      // 4. Create Vendor Sub-orders and Items
      for (const [vendorId, items] of vendorGroupMap.entries()) {
        const vendorSubtotal = items.reduce((sum, it) => sum + Number(it.subtotal), 0);

        const vo = await tx.vendorOrder.create({
          data: {
            orderId: newOrder.id,
            vendorId,
            subtotal: toDecimal(vendorSubtotal),
            status: OrderStatus.PLACED
          }
        });

        await tx.vendorOrderStatusHistory.create({
          data: {
            vendorOrderId: vo.id,
            status: OrderStatus.PLACED,
            changedBy: `Customer (${customerId})`,
            comment: 'Suborder created'
          }
        });

        for (const it of items) {
          await tx.vendorOrderItem.create({
            data: {
              vendorOrderId: vo.id,
              productId: it.productId,
              name: it.productName,
              price: it.unitPrice,
              quantity: it.quantity,
              subtotal: it.subtotal,
              image: it.imageUrl
            }
          });
        }
      }

      // 5. Record coupon usage
      if (appliedCouponCode) {
        const coupon = await tx.coupon.findUnique({ where: { code: appliedCouponCode } });
        if (coupon) {
          await tx.coupon.update({
            where: { id: coupon.id },
            data: { usedCount: { increment: 1 } }
          });
          await tx.couponUsage.create({
            data: {
              couponId: coupon.id,
              userId: customerId,
              orderId: newOrder.id
            }
          });
        }
      }

      // 6. Clear customer cart
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      return newOrder;
    });

    return serializePrisma(await getOrderById(createdOrder.id, customerId, UserRole.CUSTOMER));
  }

  // Fallback to Mongoose
  const user = await User.findById(customerId);
  if (!user) {
    throw ApiError.notFound('Customer not found');
  }

  let shippingAddress: any = null;

  if (rawAddressObj) {
    const street =
      rawAddressObj.street ||
      rawAddressObj.addressLine1 +
        (rawAddressObj.addressLine2 ? ', ' + rawAddressObj.addressLine2 : '');
    const postalCode = rawAddressObj.postalCode || rawAddressObj.pincode;

    shippingAddress = {
      fullName: rawAddressObj.fullName || user.name,
      phone: rawAddressObj.phone || user.phone || '0000000000',
      street,
      city: rawAddressObj.city,
      state: rawAddressObj.state,
      postalCode,
      country: rawAddressObj.country || 'India',
      isDefault: !user.addresses || user.addresses.length === 0
    };

    // Save to user addresses if not already existing
    const exists = user.addresses?.some(
      (a: any) => a.street === street && a.city === rawAddressObj.city && a.postalCode === postalCode
    );
    if (!exists) {
      user.addresses = user.addresses || [];
      user.addresses.push(shippingAddress);
      await user.save();
    }
  } else if (addressLookupId !== undefined) {
    if (typeof addressLookupId === 'number' || (/^\d+$/.test(String(addressLookupId)) && !isNaN(Number(addressLookupId)))) {
      const idx = Number(addressLookupId);
      shippingAddress = user.addresses?.[idx];
    } else {
      const idStr = String(addressLookupId);
      shippingAddress = user.addresses?.find((a: any) => a._id?.toString() === idStr || a.id === idStr);
    }
  }

  if (!shippingAddress) {
    throw ApiError.badRequest('Invalid shipping address selected');
  }

  const cart = await Cart.findOne({ customer: customerId });
  if (!cart || cart.items.length === 0) {
    throw ApiError.badRequest('Cannot place an order with an empty cart');
  }

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

  let discountAmount = 0;
  let appliedCouponCode: string | undefined = undefined;

  if (couponCode) {
    const couponResult = await validateCoupon(couponCode, calculatedSubtotal, customerId);
    discountAmount = couponResult.discountAmount;
    appliedCouponCode = couponResult.code;
  }

  const shippingCost = calculatedSubtotal >= 500 ? 0 : 50;
  const total = Math.max(0, calculatedSubtotal - discountAmount + shippingCost);

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

  for (const item of validatedItems) {
    await Product.findByIdAndUpdate(item.product, {
      $inc: {
        stock: -item.quantity,
        soldCount: item.quantity
      }
    });
  }

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

  if (appliedCouponCode) {
    await recordCouponUsage(appliedCouponCode, customerId);
  }

  await clearCart(customerId);
  return order;
};

export const getCustomerOrders = async (
  customerId: string,
  params: { page?: number; limit?: number }
) => {
  const { page = 1, limit = 10 } = params;
  const skip = (page - 1) * limit;

  if (isPrismaAvailable()) {
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { customerId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          vendorOrders: {
            include: {
              vendor: { select: { id: true, businessName: true } },
              items: true
            }
          }
        }
      }),
      prisma.order.count({ where: { customerId } })
    ]);

    const formatted = orders.map((ord) => ({
      _id: ord.id,
      id: ord.id,
      orderNumber: ord.orderNumber,
      total: Number(ord.total),
      subtotal: Number(ord.subtotal),
      discount: Number(ord.discount),
      shippingCost: Number(ord.shippingCost),
      paymentStatus: ord.paymentStatus,
      overallStatus: ord.overallStatus,
      createdAt: ord.createdAt,
      shippingAddress: ord.shippingAddressSnapshot,
      vendorOrders: ord.vendorOrders.map((vo) => ({
        _id: vo.id,
        id: vo.id,
        vendor: {
          _id: vo.vendor.id,
          id: vo.vendor.id,
          name: vo.vendor.businessName,
          businessName: vo.vendor.businessName
        },
        subtotal: Number(vo.subtotal),
        status: vo.status,
        items: vo.items.map((it) => ({
          _id: it.id,
          id: it.id,
          name: it.name,
          price: Number(it.price),
          quantity: it.quantity,
          subtotal: Number(it.subtotal),
          image: it.image
        }))
      }))
    }));

    return {
      data: serializePrisma(formatted),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  // Fallback to Mongoose
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
  if (isPrismaAvailable()) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true } },
        vendorOrders: {
          include: {
            vendor: { select: { id: true, businessName: true, userId: true } },
            items: true,
            statusHistory: true
          }
        },
        statusHistory: true,
        payments: true
      }
    });

    if (!order) {
      throw ApiError.notFound('Order not found');
    }

    if (role === UserRole.CUSTOMER && order.customerId !== userId) {
      throw ApiError.forbidden('You do not have permission to view this order');
    }

    if (role === UserRole.VENDOR) {
      const isVendorInOrder = order.vendorOrders.some(
        (vo) => vo.vendor.userId === userId || vo.vendorId === userId
      );
      if (!isVendorInOrder) {
        throw ApiError.forbidden('You do not have permission to view this order');
      }
    }

    const items = order.vendorOrders.flatMap((vo) =>
      vo.items.map((it) => ({
        _id: it.id,
        id: it.id,
        product: it.productId,
        name: it.name,
        price: Number(it.price),
        quantity: it.quantity,
        subtotal: Number(it.subtotal),
        image: it.image
      }))
    );

    const formattedOrder = {
      _id: order.id,
      id: order.id,
      orderNumber: order.orderNumber,
      customer: order.customer,
      items,
      shippingAddress: order.shippingAddressSnapshot,
      subtotal: Number(order.subtotal),
      discount: Number(order.discount),
      shippingCost: Number(order.shippingCost),
      tax: Number(order.tax),
      total: Number(order.total),
      paymentStatus: order.paymentStatus,
      overallStatus: order.overallStatus,
      createdAt: order.createdAt,
      vendorOrders: order.vendorOrders.map((vo) => ({
        _id: vo.id,
        id: vo.id,
        vendor: {
          _id: vo.vendor.id,
          id: vo.vendor.id,
          name: vo.vendor.businessName,
          businessName: vo.vendor.businessName
        },
        items: vo.items,
        subtotal: Number(vo.subtotal),
        status: vo.status,
        statusHistory: vo.statusHistory
      })),
      payment: (order as any).payments?.[0]
    };

    return serializePrisma(formattedOrder);
  }

  // Fallback to Mongoose
  const order = await Order.findById(orderId)
    .populate('customer', 'name email phone')
    .populate('vendorOrders.vendor', 'name email')
    .populate('items.product', 'name images slug price');

  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  if (role === UserRole.CUSTOMER && order.customer._id.toString() !== userId) {
    throw ApiError.forbidden('You do not have permission to view this order');
  }

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
    vendorOrders: order.vendorOrders.map((vo: any) => ({
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

  if (isPrismaAvailable()) {
    const where: any = {};
    if (status) where.overallStatus = status as OrderStatus;
    if (paymentStatus) where.paymentStatus = paymentStatus as PaymentStatus;
    if (search) where.orderNumber = { contains: search, mode: 'insensitive' };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { id: true, name: true, email: true, phone: true } }
        }
      }),
      prisma.order.count({ where })
    ]);

    return {
      data: serializePrisma(orders),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  // Fallback to Mongoose
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
