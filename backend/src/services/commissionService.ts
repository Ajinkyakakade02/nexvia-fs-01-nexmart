import mongoose from 'mongoose';
import Commission from '../models/Commission.js';
import VendorProfile from '../models/VendorProfile.js';
import env from '../config/env.js';
import { TransferStatus } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { getRazorpayInstance } from '../config/razorpay.js';
import logger from '../utils/logger.js';

let platformCommissionRate = env.PLATFORM_COMMISSION_PERCENT;

export const getPlatformCommissionRate = (): number => {
  return platformCommissionRate;
};

export const setPlatformCommissionRate = (rate: number): number => {
  if (rate < 0 || rate > 100) {
    throw ApiError.badRequest('Commission percentage must be between 0 and 100');
  }
  platformCommissionRate = rate;
  return platformCommissionRate;
};

export const calculateAndRecordCommissions = async (
  orderId: string,
  vendorOrders: any[],
  customRate?: number
) => {
  const rate = customRate !== undefined ? customRate : platformCommissionRate;
  const records = [];

  for (let i = 0; i < vendorOrders.length; i++) {
    const vo = vendorOrders[i];
    const grossAmount = vo.subtotal;
    const commissionAmount = Math.round(((grossAmount * rate) / 100) * 100) / 100;
    const vendorNetAmount = Math.round((grossAmount - commissionAmount) * 100) / 100;

    const commissionDoc = new Commission({
      order: orderId,
      vendor: vo.vendor,
      vendorOrderIndex: i,
      grossAmount,
      commissionPercent: rate,
      commissionAmount,
      vendorNetAmount,
      transferStatus: TransferStatus.SIMULATION
    });

    await commissionDoc.save();
    records.push(commissionDoc);

    // If Razorpay Route is configured and vendor has linked account, attempt transfer
    try {
      const razorpay = getRazorpayInstance();
      if (razorpay && env.PAYMENT_PROVIDER === 'razorpay') {
        const vendorProfile = await VendorProfile.findOne({ user: vo.vendor });
        if (vendorProfile?.razorpayLinkedAccountId) {
          // Official Razorpay Route transfer API
          const transfer = await (razorpay as any).transfers.create({
            account: vendorProfile.razorpayLinkedAccountId,
            amount: Math.round(vendorNetAmount * 100), // paise
            currency: 'INR',
            notes: {
              orderId,
              vendorId: vo.vendor.toString()
            }
          });
          commissionDoc.transferStatus = TransferStatus.COMPLETED;
          commissionDoc.razorpayTransferId = transfer.id;
          commissionDoc.processedAt = new Date();
          await commissionDoc.save();
        } else {
          logger.info(`Vendor ${vo.vendor} has no linked Razorpay Route account; logged as SIMULATION`);
        }
      }
    } catch (err: any) {
      logger.warn(`Razorpay Route transfer note: ${err.message}`);
    }
  }

  return records;
};

export const getVendorCommissions = async (
  vendorId: string,
  params: { page?: number; limit?: number }
) => {
  const { page = 1, limit = 10 } = params;
  const skip = (page - 1) * limit;

  const [commissions, total] = await Promise.all([
    Commission.find({ vendor: vendorId })
      .populate('order', 'orderNumber createdAt paymentStatus')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Commission.countDocuments({ vendor: vendorId })
  ]);

  return {
    data: commissions,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

export const getAdminCommissions = async (params: { page?: number; limit?: number }) => {
  const { page = 1, limit = 10 } = params;
  const skip = (page - 1) * limit;

  const [commissions, total] = await Promise.all([
    Commission.find()
      .populate('order', 'orderNumber createdAt total')
      .populate('vendor', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Commission.countDocuments()
  ]);

  const summary = await Commission.aggregate([
    {
      $group: {
        _id: null,
        totalGross: { $sum: '$grossAmount' },
        totalCommission: { $sum: '$commissionAmount' },
        totalVendorNet: { $sum: '$vendorNetAmount' }
      }
    }
  ]);

  return {
    data: commissions,
    summary: summary[0] || { totalGross: 0, totalCommission: 0, totalVendorNet: 0 },
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};
