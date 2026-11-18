import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as analyticsService from '../services/analyticsService.js';
import * as commissionService from '../services/commissionService.js';
import * as orderService from '../services/orderService.js';
import User from '../models/User.js';
import VendorProfile from '../models/VendorProfile.js';
import Product from '../models/Product.js';
import Payment from '../models/Payment.js';
import { OnboardingStatus, UserRole } from '../types/index.js';
import { success } from '../utils/apiResponse.js';
import { ApiError } from '../utils/apiError.js';

export const getDashboard = asyncHandler(async (_req: Request, res: Response) => {
  const stats = await analyticsService.getAdminDashboardStats();
  return success(res, stats, 'Admin dashboard statistics retrieved', StatusCodes.OK);
});

export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const role = req.query.role as string;
  const search = req.query.search as string;

  const query: any = {};
  if (role) query.role = role;
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } }
    ];
  }

  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find(query).select('-passwordHash').sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(query)
  ]);

  return res.status(StatusCodes.OK).json({
    success: true,
    message: 'Users retrieved',
    data: users,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
  });
});

export const getVendors = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;

  const query: any = {};
  if (status) query.onboardingStatus = status;

  const skip = (page - 1) * limit;
  const [vendors, total] = await Promise.all([
    VendorProfile.find(query)
      .populate('user', 'name email phone createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    VendorProfile.countDocuments(query)
  ]);

  return res.status(StatusCodes.OK).json({
    success: true,
    message: 'Vendors retrieved',
    data: vendors,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
  });
});

export const approveVendor = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { adminNotes, razorpayLinkedAccountId } = req.body;

  const vendor = await VendorProfile.findById(id);
  if (!vendor) {
    throw ApiError.notFound('Vendor profile not found');
  }

  vendor.onboardingStatus = OnboardingStatus.APPROVED;
  vendor.approvedAt = new Date();
  if (adminNotes) vendor.adminNotes = adminNotes;
  if (razorpayLinkedAccountId) vendor.razorpayLinkedAccountId = razorpayLinkedAccountId;

  await vendor.save();

  // Ensure user has VENDOR role
  await User.findByIdAndUpdate(vendor.user, { role: UserRole.VENDOR });

  return success(res, vendor, 'Vendor approved successfully', StatusCodes.OK);
});

export const rejectVendor = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { adminNotes } = req.body;

  const vendor = await VendorProfile.findById(id);
  if (!vendor) {
    throw ApiError.notFound('Vendor profile not found');
  }

  vendor.onboardingStatus = OnboardingStatus.REJECTED;
  vendor.rejectedAt = new Date();
  if (adminNotes) vendor.adminNotes = adminNotes;

  await vendor.save();
  return success(res, vendor, 'Vendor application rejected', StatusCodes.OK);
});

export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  const [products, total] = await Promise.all([
    Product.find({ isDeleted: false })
      .populate('category', 'name slug')
      .populate('vendor', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Product.countDocuments({ isDeleted: false })
  ]);

  return res.status(StatusCodes.OK).json({
    success: true,
    message: 'Admin products retrieved',
    data: products,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
  });
});

export const getOrders = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;
  const paymentStatus = req.query.paymentStatus as string;
  const search = req.query.search as string;

  const result = await orderService.adminGetAllOrders({
    page,
    limit,
    status,
    paymentStatus,
    search
  });

  return res.status(StatusCodes.OK).json({
    success: true,
    message: 'Admin orders retrieved',
    data: result.data,
    pagination: result.pagination
  });
});

export const getPayments = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  const [payments, total] = await Promise.all([
    Payment.find()
      .populate({
        path: 'order',
        select: 'orderNumber customer total',
        populate: { path: 'customer', select: 'name email' }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Payment.countDocuments()
  ]);

  return res.status(StatusCodes.OK).json({
    success: true,
    message: 'Payments retrieved',
    data: payments,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
  });
});

export const getCommissions = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  const result = await commissionService.getAdminCommissions({ page, limit });
  return res.status(StatusCodes.OK).json({
    success: true,
    message: 'Commissions retrieved',
    data: result.data,
    summary: result.summary,
    pagination: result.pagination
  });
});

export const getAnalytics = asyncHandler(async (_req: Request, res: Response) => {
  const stats = await analyticsService.getAdminDashboardStats();
  return success(res, stats, 'Platform analytics retrieved', StatusCodes.OK);
});

export const updateCommissionSettings = asyncHandler(async (req: Request, res: Response) => {
  const { commissionPercent } = req.body;
  const updatedRate = commissionService.setPlatformCommissionRate(commissionPercent);
  return success(
    res,
    { commissionPercent: updatedRate },
    'Platform commission percentage updated',
    StatusCodes.OK
  );
});

export const reindexSearch = asyncHandler(async (_req: Request, res: Response) => {
  const searchService = await import('../services/searchService.js');
  await searchService.reindexAll();
  return success(res, null, 'Elasticsearch search index rebuild initiated', StatusCodes.OK);
});

