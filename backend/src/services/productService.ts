import mongoose from 'mongoose';
import Product, { IProduct } from '../models/Product.js';
import Category from '../models/Category.js';
import VendorProfile from '../models/VendorProfile.js';
import { OnboardingStatus, ProductStatus } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { indexProduct, removeProduct } from './searchService.js';

const slugify = (text: string): string => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-') + '-' + Date.now().toString().slice(-4);
};

export const createProduct = async (
  vendorId: string,
  data: {
    name: string;
    description: string;
    price: number;
    comparePrice?: number;
    categoryId: string;
    stock: number;
    images?: string[];
    status?: ProductStatus;
    searchKeywords?: string[];
  }
) => {
  // Enforce vendor approval
  const profile = await VendorProfile.findOne({ user: vendorId });
  if (!profile || profile.onboardingStatus !== OnboardingStatus.APPROVED) {
    throw ApiError.forbidden('Vendor account must be approved before adding products');
  }

  // Validate category
  const category = await Category.findById(data.categoryId);
  if (!category || !category.isActive) {
    throw ApiError.badRequest('Invalid or inactive category specified');
  }

  const slug = slugify(data.name);

  const product = new Product({
    vendor: vendorId,
    category: data.categoryId,
    name: data.name,
    slug,
    description: data.description,
    price: data.price,
    comparePrice: data.comparePrice,
    stock: data.stock,
    images: data.images || [],
    status: data.status || ProductStatus.ACTIVE,
    searchKeywords: data.searchKeywords || []
  });

  await product.save();

  // Increment category product count
  await Category.findByIdAndUpdate(data.categoryId, { $inc: { productCount: 1 } });

  // Sync to Elasticsearch (asynchronous, non-blocking)
  indexProduct(product, profile.businessName).catch(() => {});

  return product;
};

export const getProducts = async (params: {
  page?: number;
  limit?: number;
  category?: string;
  vendor?: string;
  minPrice?: number;
  maxPrice?: number;
  rating?: number;
  search?: string;
  sort?: string;
  inStock?: boolean;
}) => {
  const {
    page = 1,
    limit = 12,
    category,
    vendor,
    minPrice,
    maxPrice,
    rating,
    search,
    sort = 'latest',
    inStock
  } = params;

  const query: any = { isDeleted: false, status: ProductStatus.ACTIVE };

  if (category) {
    if (mongoose.Types.ObjectId.isValid(category)) {
      query.category = category;
    } else {
      const cat = await Category.findOne({ slug: category });
      if (cat) query.category = cat._id;
    }
  }

  if (vendor && mongoose.Types.ObjectId.isValid(vendor)) {
    query.vendor = vendor;
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    query.price = {};
    if (minPrice !== undefined) query.price.$gte = Number(minPrice);
    if (maxPrice !== undefined) query.price.$lte = Number(maxPrice);
  }

  if (rating !== undefined) {
    query.avgRating = { $gte: Number(rating) };
  }

  if (inStock) {
    query.stock = { $gt: 0 };
  }

  if (search) {
    query.$text = { $search: search };
  }

  let sortCriteria: any = { createdAt: -1 };
  if (sort === 'price_asc') sortCriteria = { price: 1 };
  else if (sort === 'price_desc') sortCriteria = { price: -1 };
  else if (sort === 'rating') sortCriteria = { avgRating: -1 };
  else if (sort === 'popular') sortCriteria = { soldCount: -1 };

  const skip = (page - 1) * limit;

  const [products, total] = await Promise.all([
    Product.find(query)
      .populate('category', 'name slug')
      .populate('vendor', 'name')
      .sort(sortCriteria)
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(query)
  ]);

  return {
    data: products,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

export const getProductById = async (id: string) => {
  const product = await Product.findOne({ _id: id, isDeleted: false })
    .populate('category', 'name slug')
    .populate('vendor', 'name email');

  if (!product) {
    throw ApiError.notFound('Product not found');
  }
  return product;
};

export const getProductBySlug = async (slug: string) => {
  const product = await Product.findOne({ slug, isDeleted: false })
    .populate('category', 'name slug')
    .populate('vendor', 'name email');

  if (!product) {
    throw ApiError.notFound('Product not found');
  }
  return product;
};

export const updateProduct = async (
  vendorId: string,
  productId: string,
  data: Partial<{
    name: string;
    description: string;
    price: number;
    comparePrice: number;
    categoryId: string;
    stock: number;
    images: string[];
    status: ProductStatus;
    searchKeywords: string[];
  }>
) => {
  const product = await Product.findOne({ _id: productId, isDeleted: false });
  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  if (product.vendor.toString() !== vendorId) {
    throw ApiError.forbidden('You are not authorized to update this product');
  }

  if (data.categoryId && data.categoryId !== product.category.toString()) {
    const newCategory = await Category.findById(data.categoryId);
    if (!newCategory || !newCategory.isActive) {
      throw ApiError.badRequest('Invalid or inactive category specified');
    }
    // Update category counts
    await Category.findByIdAndUpdate(product.category, { $inc: { productCount: -1 } });
    await Category.findByIdAndUpdate(data.categoryId, { $inc: { productCount: 1 } });
    product.category = new mongoose.Types.ObjectId(data.categoryId);
  }

  if (data.name && data.name !== product.name) {
    product.name = data.name;
    product.slug = slugify(data.name);
  }

  if (data.description !== undefined) product.description = data.description;
  if (data.price !== undefined) product.price = data.price;
  if (data.comparePrice !== undefined) product.comparePrice = data.comparePrice;
  if (data.stock !== undefined) product.stock = data.stock;
  if (data.images !== undefined) product.images = data.images;
  if (data.status !== undefined) product.status = data.status;
  if (data.searchKeywords !== undefined) product.searchKeywords = data.searchKeywords;

  await product.save();

  // Sync to Elasticsearch
  indexProduct(product).catch(() => {});

  return product;
};

export const deleteProduct = async (vendorId: string, productId: string) => {
  const product = await Product.findOne({ _id: productId, isDeleted: false });
  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  if (product.vendor.toString() !== vendorId) {
    throw ApiError.forbidden('You are not authorized to delete this product');
  }

  product.isDeleted = true;
  await product.save();

  // Decrement category product count
  await Category.findByIdAndUpdate(product.category, { $inc: { productCount: -1 } });

  // Remove from Elasticsearch
  removeProduct(productId).catch(() => {});

  return { message: 'Product deleted successfully' };
};

export const getVendorProducts = async (
  vendorId: string,
  params: { page?: number; limit?: number; status?: string; search?: string }
) => {
  const { page = 1, limit = 10, status, search } = params;
  const skip = (page - 1) * limit;

  const query: any = { vendor: vendorId, isDeleted: false };
  if (status) query.status = status;
  if (search) query.name = { $regex: search, $options: 'i' };

  const [products, total] = await Promise.all([
    Product.find(query)
      .populate('category', 'name slug')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Product.countDocuments(query)
  ]);

  return {
    data: products,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

