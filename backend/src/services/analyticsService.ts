import Order from '../models/Order.js';
import User from '../models/User.js';
import VendorProfile from '../models/VendorProfile.js';
import Product from '../models/Product.js';
import Commission from '../models/Commission.js';
import Payment from '../models/Payment.js';
import { OnboardingStatus, PaymentStatus, UserRole } from '../types/index.js';

export const getAdminDashboardStats = async () => {
  const [
    salesAgg,
    totalOrders,
    totalCustomers,
    totalVendors,
    pendingVendors,
    totalProducts,
    commissionAgg
  ] = await Promise.all([
    Order.aggregate([
      { $match: { paymentStatus: PaymentStatus.COMPLETED } },
      { $group: { _id: null, totalSales: { $sum: '$total' } } }
    ]),
    Order.countDocuments(),
    User.countDocuments({ role: UserRole.CUSTOMER }),
    VendorProfile.countDocuments({ onboardingStatus: OnboardingStatus.APPROVED }),
    VendorProfile.countDocuments({ onboardingStatus: OnboardingStatus.PENDING }),
    Product.countDocuments({ isDeleted: false }),
    Commission.aggregate([
      { $group: { _id: null, totalCommission: { $sum: '$commissionAmount' } } }
    ])
  ]);

  const totalSales = salesAgg[0]?.totalSales || 0;
  const totalCommission = commissionAgg[0]?.totalCommission || 0;

  // Revenue by month (last 6-12 months)
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const revenueByMonth = await Order.aggregate([
    {
      $match: {
        paymentStatus: PaymentStatus.COMPLETED,
        createdAt: { $gte: sixMonthsAgo }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        },
        revenue: { $sum: '$total' },
        orders: { $sum: 1 }
      }
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } }
  ]);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const formattedRevenue = revenueByMonth.map((item) => ({
    name: `${monthNames[item._id.month - 1]} ${item._id.year}`,
    revenue: item.revenue,
    orders: item.orders
  }));

  // Top 5 selling products
  const topProducts = await Product.find({ isDeleted: false })
    .sort({ soldCount: -1 })
    .limit(5)
    .select('name price soldCount avgRating images')
    .lean();

  // Order status breakdown
  const orderStatusBreakdown = await Order.aggregate([
    {
      $group: {
        _id: '$overallStatus',
        count: { $sum: 1 }
      }
    }
  ]);

  // Recent 10 transactions
  const recentTransactions = await Payment.find()
    .sort({ createdAt: -1 })
    .limit(10)
    .populate({
      path: 'order',
      select: 'orderNumber customer total',
      populate: { path: 'customer', select: 'name email' }
    })
    .lean();

  return {
    overview: {
      totalSales,
      totalOrders,
      totalCustomers,
      totalVendors,
      pendingVendors,
      totalProducts,
      totalCommission
    },
    revenueByMonth: formattedRevenue,
    topProducts,
    orderStatusBreakdown: orderStatusBreakdown.map((item) => ({
      status: item._id,
      count: item.count
    })),
    recentTransactions
  };
};

