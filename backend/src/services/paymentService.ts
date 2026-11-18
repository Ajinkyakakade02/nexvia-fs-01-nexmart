import crypto from 'crypto';
import Payment, { IPayment } from '../models/Payment.js';
import Order from '../models/Order.js';
import env from '../config/env.js';
import { PaymentStatus } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { getRazorpayInstance } from '../config/razorpay.js';
import { calculateAndRecordCommissions } from './commissionService.js';
import logger from '../utils/logger.js';

export const createRazorpayOrder = async (orderId: string, amount: number, currency = 'INR') => {
  const order = await Order.findById(orderId);
  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  // If Razorpay credentials configured and provider is razorpay
  const razorpay = getRazorpayInstance();
  if (razorpay && env.PAYMENT_PROVIDER === 'razorpay') {
    try {
      const rzpOrder = await razorpay.orders.create({
        amount: Math.round(amount * 100), // in paise
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
        status: PaymentStatus.PENDING
      });
      await payment.save();

      order.payment = payment._id;
      await order.save();

      return {
        mode: 'razorpay',
        razorpayOrderId: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        key: env.RAZORPAY_KEY_ID
      };
    } catch (error: any) {
      logger.error('Razorpay order creation error:', error);
      throw ApiError.internal('Failed to initialize payment gateway', error.message);
    }
  }

  // Simulation mode for zero-cost / testing without credentials
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
    razorpayOrderId: simOrderId,
    amount: Math.round(amount * 100),
    currency,
    key: 'rzp_test_simulation'
  };
};

export const verifyPayment = async (
  orderId: string,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string
) => {
  const order = await Order.findById(orderId);
  if (!order) {
    throw ApiError.notFound('Order not found');
  }

  const payment = await Payment.findOne({ order: orderId, razorpayOrderId });
  if (!payment) {
    throw ApiError.notFound('Payment record not found for this order');
  }

  // Idempotency: already processed
  if (payment.status === PaymentStatus.COMPLETED) {
    return { success: true, message: 'Payment already completed', payment };
  }

  // Real signature verification if razorpay provider
  if (env.PAYMENT_PROVIDER === 'razorpay' && env.RAZORPAY_KEY_SECRET) {
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

  // Complete payment
  payment.status = PaymentStatus.COMPLETED;
  payment.razorpayPaymentId = razorpayPaymentId;
  payment.razorpaySignature = razorpaySignature;
  payment.processedAt = new Date();
  await payment.save();

  order.paymentStatus = PaymentStatus.COMPLETED;
  await order.save();

  // Calculate and record platform/vendor commissions
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
  const payment = await Payment.findById(paymentId).populate('order', 'orderNumber total');
  if (!payment) {
    throw ApiError.notFound('Payment not found');
  }
  return payment;
};
