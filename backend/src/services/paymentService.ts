import crypto from 'crypto';
import prisma, { isPrismaAvailable } from '../config/prisma.js';
import Payment, { IPayment } from '../models/Payment.js';
import Order from '../models/Order.js';
import env from '../config/env.js';
import { PaymentStatus } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { getRazorpayInstance } from '../config/razorpay.js';
import { calculateAndRecordCommissions } from './commissionService.js';
import logger from '../utils/logger.js';
import { serializePrisma, toDecimal } from '../utils/prismaSerializer.js';

export const createRazorpayOrder = async (orderId: string, amount: number, currency = 'INR') => {
  // Check if Razorpay live/test credentials are configured
  const razorpay = getRazorpayInstance();
  const isGenuineRazorpay = razorpay && env.PAYMENT_PROVIDER === 'razorpay' && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET;

  if (isPrismaAvailable()) {
    const order = await prisma.order.findUnique({
      where: { id: orderId }
    });
    if (!order) {
      throw ApiError.notFound('Order not found');
    }

    if (order.paymentStatus === PaymentStatus.COMPLETED) {
      throw ApiError.badRequest('This order has already been paid for');
    }

    if (isGenuineRazorpay) {
      try {
        const rzpOrder = await razorpay.orders.create({
          amount: Math.round(amount * 100), // in paise
          currency,
          receipt: order.orderNumber,
          notes: {
            orderId: order.id,
            orderNumber: order.orderNumber
          }
        });

        const payment = await prisma.payment.create({
          data: {
            orderId: order.id,
            razorpayOrderId: rzpOrder.id,
            amount: toDecimal(amount),
            currency,
            status: PaymentStatus.PENDING,
            method: 'razorpay'
          }
        });

        return {
          mode: 'razorpay',
          razorpayOrderId: rzpOrder.id,
          amount: rzpOrder.amount,
          currency: rzpOrder.currency,
          key: env.RAZORPAY_KEY_ID,
          paymentId: payment.id
        };
      } catch (error: any) {
        logger.error('Razorpay test gateway order creation failed:', error);
        throw ApiError.internal('Failed to initialize payment gateway with Razorpay', error.message);
      }
    }

    // Genuine Simulation Mode
    const simOrderId = `order_sim_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        razorpayOrderId: simOrderId,
        amount: toDecimal(amount),
        currency,
        status: PaymentStatus.PENDING,
        method: 'simulation'
      }
    });

    return {
      mode: 'simulation',
      label: 'SIMULATED_TEST_MODE (Zero Cost)',
      razorpayOrderId: simOrderId,
      amount: Math.round(amount * 100),
      currency,
      key: 'rzp_test_simulation',
      paymentId: payment.id
    };
  }

  // Fallback to Mongoose
  const order = await Order.findById(orderId);
  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  if (order.paymentStatus === PaymentStatus.COMPLETED) {
    throw ApiError.badRequest('This order has already been paid for');
  }

  if (isGenuineRazorpay) {
    try {
      const rzpOrder = await razorpay.orders.create({
        amount: Math.round(amount * 100),
        currency,
        receipt: order.orderNumber,
        notes: {
          orderId: order._id.toString(),
          orderNumber: order.orderNumber
        }
      });

      const payment = new Payment({
        order: order._id,
        razorpayOrderId: rzpOrder.id,
        amount,
        currency,
        status: PaymentStatus.PENDING,
        method: 'razorpay'
      });
      await payment.save();

      order.payment = payment._id;
      await order.save();

      return {
        mode: 'razorpay',
        razorpayOrderId: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        key: env.RAZORPAY_KEY_ID,
        paymentId: payment._id
      };
    } catch (error: any) {
      logger.error('Razorpay order creation error:', error);
      throw ApiError.internal('Failed to initialize payment gateway', error.message);
    }
  }

  // Simulation mode
  const simOrderId = `order_sim_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const payment = new Payment({
    order: order._id,
    razorpayOrderId: simOrderId,
    amount,
    currency,
    status: PaymentStatus.PENDING,
    method: 'simulation'
  });
  await payment.save();

  order.payment = payment._id;
  await order.save();

  return {
    mode: 'simulation',
    label: 'SIMULATED_TEST_MODE (Zero Cost)',
    razorpayOrderId: simOrderId,
    amount: Math.round(amount * 100),
    currency,
    key: 'rzp_test_simulation',
    paymentId: payment._id
  };
};

export const verifyPayment = async (
  orderId: string,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string
) => {
  if (isPrismaAvailable()) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { vendorOrders: true }
    });

    if (!order) {
      throw ApiError.notFound('Order not found');
    }

    const payment = await prisma.payment.findFirst({
      where: {
        orderId,
        razorpayOrderId
      }
    });

    if (!payment) {
      throw ApiError.notFound('Payment record not found for this order');
    }

    // Idempotency: duplicate protection
    if (payment.status === PaymentStatus.COMPLETED) {
      return { success: true, message: 'Payment already completed (Duplicate Protected)', payment: serializePrisma(payment) };
    }

    // Genuine Razorpay HMAC SHA256 Signature Verification
    if (env.PAYMENT_PROVIDER === 'razorpay' && env.RAZORPAY_KEY_SECRET && payment.method === 'razorpay') {
      const generatedSignature = crypto
        .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (generatedSignature !== razorpaySignature) {
        await prisma.$transaction([
          prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              razorpayPaymentId,
              razorpaySignature
            }
          }),
          prisma.order.update({
            where: { id: orderId },
            data: { paymentStatus: PaymentStatus.FAILED }
          })
        ]);

        throw ApiError.badRequest('Payment signature verification failed');
      }
    }

    // Mark as completed atomically
    const [updatedPayment] = await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.COMPLETED,
          razorpayPaymentId,
          razorpaySignature,
          processedAt: new Date()
        }
      }),
      prisma.order.update({
        where: { id: orderId },
        data: { paymentStatus: PaymentStatus.COMPLETED }
      })
    ]);

    // Calculate commissions & Route transfers for all vendors
    await calculateAndRecordCommissions(orderId, order.vendorOrders);

    return {
      success: true,
      message: 'Payment verified and captured successfully',
      payment: serializePrisma(updatedPayment),
      order: serializePrisma(order)
    };
  }

  // Fallback to Mongoose
  const order = await Order.findById(orderId);
  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  const payment = await Payment.findOne({ order: orderId, razorpayOrderId });
  if (!payment) {
    throw ApiError.notFound('Payment record not found for this order');
  }

  // Idempotency check
  if (payment.status === PaymentStatus.COMPLETED) {
    return { success: true, message: 'Payment already completed', payment };
  }

  // Signature check if razorpay provider
  if (env.PAYMENT_PROVIDER === 'razorpay' && env.RAZORPAY_KEY_SECRET && payment.method === 'razorpay') {
    const generatedSignature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (generatedSignature !== razorpaySignature) {
      payment.status = PaymentStatus.FAILED;
      payment.razorpayPaymentId = razorpayPaymentId;
      payment.razorpaySignature = razorpaySignature;
      await payment.save();

      order.paymentStatus = PaymentStatus.FAILED;
      await order.save();

      throw ApiError.badRequest('Payment signature verification failed');
    }
  }

  payment.status = PaymentStatus.COMPLETED;
  payment.razorpayPaymentId = razorpayPaymentId;
  payment.razorpaySignature = razorpaySignature;
  payment.processedAt = new Date();
  await payment.save();

  order.paymentStatus = PaymentStatus.COMPLETED;
  await order.save();

  await calculateAndRecordCommissions(order._id.toString(), order.vendorOrders);

  return {
    success: true,
    message: 'Payment verified and captured successfully',
    payment,
    order
  };
};

export const handleWebhook = async (rawBody: Buffer, signature: string) => {
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    throw ApiError.badRequest('Webhook secret not configured');
  }

  const expectedSignature = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expectedSignature !== signature) {
    throw ApiError.badRequest('Invalid webhook signature');
  }

  const event = JSON.parse(rawBody.toString());
  const paymentEntity = event?.payload?.payment?.entity;
  const razorpayOrderId = paymentEntity?.order_id;

  if (isPrismaAvailable()) {
    if (event.event === 'payment.captured' && razorpayOrderId) {
      const payment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
      if (payment && payment.status !== PaymentStatus.COMPLETED) {
        await prisma.$transaction([
          prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.COMPLETED,
              razorpayPaymentId: paymentEntity.id,
              webhookVerified: true,
              processedAt: new Date()
            }
          }),
          prisma.order.update({
            where: { id: payment.orderId },
            data: { paymentStatus: PaymentStatus.COMPLETED }
          })
        ]);

        const order = await prisma.order.findUnique({
          where: { id: payment.orderId },
          include: { vendorOrders: true }
        });
        if (order) {
          await calculateAndRecordCommissions(order.id, order.vendorOrders);
        }
      }
    } else if (event.event === 'payment.failed' && razorpayOrderId) {
      const payment = await prisma.payment.findFirst({ where: { razorpayOrderId } });
      if (payment) {
        await prisma.$transaction([
          prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              webhookVerified: true
            }
          }),
          prisma.order.update({
            where: { id: payment.orderId },
            data: { paymentStatus: PaymentStatus.FAILED }
          })
        ]);
      }
    }

    return { received: true };
  }

  // Fallback to Mongoose
  if (event.event === 'payment.captured' && razorpayOrderId) {
    const payment = await Payment.findOne({ razorpayOrderId });
    if (payment && payment.status !== PaymentStatus.COMPLETED) {
      payment.status = PaymentStatus.COMPLETED;
      payment.razorpayPaymentId = paymentEntity.id;
      payment.webhookVerified = true;
      payment.processedAt = new Date();
      await payment.save();

      const order = await Order.findById(payment.order);
      if (order) {
        order.paymentStatus = PaymentStatus.COMPLETED;
        await order.save();
        await calculateAndRecordCommissions(order._id.toString(), order.vendorOrders);
      }
    }
  } else if (event.event === 'payment.failed' && razorpayOrderId) {
    const payment = await Payment.findOne({ razorpayOrderId });
    if (payment) {
      payment.status = PaymentStatus.FAILED;
      payment.webhookVerified = true;
      await payment.save();

      await Order.findByIdAndUpdate(payment.order, { paymentStatus: PaymentStatus.FAILED });
    }
  }

  return { received: true };
};

export const getPaymentById = async (paymentId: string) => {
  if (isPrismaAvailable()) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            paymentStatus: true
          }
        }
      }
    });
    if (!payment) {
      throw ApiError.notFound('Payment not found');
    }
    return serializePrisma(payment);
  }

  const payment = await Payment.findById(paymentId).populate('order', 'orderNumber total');
  if (!payment) {
    throw ApiError.notFound('Payment not found');
  }
  return payment;
};

export default {
  createRazorpayOrder,
  verifyPayment,
  handleWebhook,
  getPaymentById
};
