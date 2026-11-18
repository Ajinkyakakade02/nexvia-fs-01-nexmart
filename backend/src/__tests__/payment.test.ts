import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { connectDB, disconnectDB } from '../config/db.js';
import User from '../models/User.js';
import Product from '../models/Product.js';
import Category from '../models/Category.js';
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import Commission from '../models/Commission.js';
import { OrderStatus, PaymentStatus, UserRole } from '../types/index.js';

describe('NexMart Payment Gateway & Commission Suite', () => {
  let customerToken: string;
  let customerId: string;
  let vendorId: string;
  let testOrderId: string;
  let testAmount: number;

  beforeAll(async () => {
    await connectDB();

    const timestamp = Date.now();

    // 1. Create Customer
    const customer = new User({
      name: 'Payment Test Customer',
      email: `pay_customer_${timestamp}@test.com`,
      passwordHash: 'Password@123',
      role: UserRole.CUSTOMER,
      addresses: [
        {
          fullName: 'Pay Customer',
          phone: '9988776655',
          street: '123 Market St',
          city: 'Mumbai',
          state: 'Maharashtra',
          postalCode: '400001',
          country: 'India',
          isDefault: true
        }
      ]
    });
    await customer.save();
    customerId = customer._id.toString();

    // Login customer to get token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: customer.email, password: 'Password@123' });
    customerToken = loginRes.body.data.accessToken;

    // 2. Create Vendor
    const vendor = new User({
      name: 'Payment Test Vendor',
      email: `pay_vendor_${timestamp}@test.com`,
      passwordHash: 'Password@123',
      role: UserRole.VENDOR
    });
    await vendor.save();
    vendorId = vendor._id.toString();

    // 3. Create Category & Product
    const category = new Category({
      name: `Pay Category ${timestamp}`,
      slug: `pay-cat-${timestamp}`,
      isActive: true
    });
    await category.save();

    const product = new Product({
      vendor: vendor._id,
      category: category._id,
      name: `Test Product ${timestamp}`,
      slug: `test-prod-${timestamp}`,
      description: 'Test product for payment gateway verification',
      price: 1500,
      stock: 50,
      status: 'ACTIVE'
    });
    await product.save();

    // 4. Create Order
    testAmount = 1500;
    const order = new Order({
      customer: customer._id,
      orderNumber: `ORD-PAY-${timestamp}`,
      items: [
        {
          product: product._id,
          vendor: vendor._id,
          name: product.name,
          price: 1500,
          quantity: 1,
          subtotal: 1500
        }
      ],
      shippingAddress: customer.addresses[0],
      subtotal: 1500,
      discount: 0,
      shippingCost: 0,
      tax: 0,
      total: testAmount,
      paymentStatus: PaymentStatus.PENDING,
      overallStatus: OrderStatus.PLACED,
      vendorOrders: [
        {
          vendor: vendor._id,
          items: [
            {
              product: product._id,
              name: product.name,
              price: 1500,
              quantity: 1,
              subtotal: 1500
            }
          ],
          subtotal: 1500,
          status: OrderStatus.PLACED,
          statusHistory: []
        }
      ]
    });
    await order.save();
    testOrderId = order._id.toString();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  describe('1. Payment Order Initialization', () => {
    it('should initialize a payment order (test mode / simulation) with proper amounts and tracking', async () => {
      const res = await request(app)
        .post('/api/payments/create-order')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          orderId: testOrderId,
          amount: testAmount,
          currency: 'INR'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.razorpayOrderId).toBeDefined();
      expect(res.body.data.amount).toBe(testAmount * 100); // 150000 paise
      expect(res.body.data.currency).toBe('INR');
      expect(res.body.data.mode).toBeDefined(); // 'simulation' or 'razorpay'

      // Check payment record created in pending state
      const payment = await Payment.findOne({ order: testOrderId });
      expect(payment).toBeDefined();
      expect(payment?.status).toBe(PaymentStatus.PENDING);
    });

    it('should reject payment initialization for a non-existent order', async () => {
      const fakeId = '000000000000000000000000';
      const res = await request(app)
        .post('/api/payments/create-order')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          orderId: fakeId,
          amount: 500
        });

      expect(res.status).toBe(404);
    });
  });

  describe('2. Payment Verification & Duplicate Protection', () => {
    it('should capture payment, update order status to COMPLETED, and record commissions', async () => {
      const payment = await Payment.findOne({ order: testOrderId });
      expect(payment).toBeDefined();

      const simPaymentId = `pay_sim_${Date.now()}`;
      const simSignature = 'sim_sig_valid';

      const res = await request(app)
        .post('/api/payments/verify')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          orderId: testOrderId,
          razorpayOrderId: payment?.razorpayOrderId,
          razorpayPaymentId: simPaymentId,
          razorpaySignature: simSignature
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payment.status).toBe(PaymentStatus.COMPLETED);

      // Verify order status updated in database
      const updatedOrder = await Order.findById(testOrderId);
      expect(updatedOrder?.paymentStatus).toBe(PaymentStatus.COMPLETED);

      // Verify commission calculated and recorded for vendor
      const commission = await Commission.findOne({ order: testOrderId, vendor: vendorId });
      expect(commission).toBeDefined();
      expect(commission?.grossAmount).toBe(1500);
      // Default platform commission is 10%: 150, Vendor net: 1350
      expect(commission?.commissionPercent).toBe(10);
      expect(commission?.commissionAmount).toBe(150);
      expect(commission?.vendorNetAmount).toBe(1350);
    });

    it('should enforce duplicate protection (idempotency) when verifying already completed payment', async () => {
      const payment = await Payment.findOne({ order: testOrderId });

      const res = await request(app)
        .post('/api/payments/verify')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          orderId: testOrderId,
          razorpayOrderId: payment?.razorpayOrderId,
          razorpayPaymentId: 'pay_sim_duplicate',
          razorpaySignature: 'sim_sig_valid'
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('already completed');

      // Verify no duplicate commissions were created
      const commissionCount = await Commission.countDocuments({ order: testOrderId });
      expect(commissionCount).toBe(1);
    });
  });
});
