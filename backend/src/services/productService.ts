import mongoose from 'mongoose';
import prisma, { isPrismaAvailable } from '../config/prisma.js';
import Product, { IProduct } from '../models/Product.js';
import Category from '../models/Category.js';
import VendorProfile from '../models/VendorProfile.js';
import { OnboardingStatus, ProductStatus } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';
import { indexProduct, removeProduct } from './searchService.js';
import { serializePrisma, toDecimal } from '../utils/prismaSerializer.js';

const slugify = (text: string): string => {
  return (
    text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\-]+/g, '')
      .replace(/\-\-+/g, '-') +
    '-' +
    Date.now().toString().slice(-4)
  );
};

export const createProduct = async (
  vendorId: string,
  data: {
    name: string;
    description: string;
    price: number;
    comparePrice?: number;
    categoryId?: string;
    category?: string;
    stock: number;
    images?: string[];
    status?: ProductStatus;
    searchKeywords?: string[];
  }
) => {
  const categoryId = data.categoryId || data.category;
  if (!categoryId) {
    throw ApiError.badRequest('Category is required');
  }

  if (isPrismaAvailable()) {
    const profile = await prisma.vendorProfile.findUnique({ where: { userId: vendorId } });
    if (!profile || profile.onboardingStatus !== OnboardingStatus.APPROVED) {
      throw ApiError.forbidden('Vendor account must be approved before adding products');
    }

    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category || !category.isActive) {
      throw ApiError.badRequest('Invalid or inactive category specified');
    }

    const slug = slugify(data.name);

    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          vendorId: profile.id,
          categoryId: category.id,
          name: data.name,
          slug,
          description: data.description,
          price: toDecimal(data.price),
          comparePrice: data.comparePrice ? toDecimal(data.comparePrice) : null,
          stock: data.stock,
          images: data.images || [],
          status: data.status || ProductStatus.ACTIVE,
          searchKeywords: data.searchKeywords || []
        },
        include: {
          category: { select: { id: true, name: true, slug: true } },
          vendor: { select: { id: true, businessName: true } }
        }
      });

      await tx.category.update({
        where: { id: category.id },
        data: { productCount: { increment: 1 } }
      });

      // Sync to search (non-blocking)
      indexProduct(product as any, profile.businessName).catch(() => {});

      return serializePrisma(product);
    });
  }

  // Fallback to Mongoose
  const profile = await VendorProfile.findOne({ user: vendorId });
  if (!profile || profile.onboardingStatus !== OnboardingStatus.APPROVED) {
    throw ApiError.forbidden('Vendor account must be approved before adding products');
  }

  const category = await Category.findById(categoryId);
  if (!category || !category.isActive) {
    throw ApiError.badRequest('Invalid or inactive category specified');
  }

  const slug = slugify(data.name);

  const product = new Product({
    vendor: vendorId,
    category: categoryId,
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
  await Category.findByIdAndUpdate(categoryId, { $inc: { productCount: 1 } });
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
  const skip = (page - 1) * limit;

  if (isPrismaAvailable()) {
    const where: any = {
      isDeleted: false,
      status: ProductStatus.ACTIVE
    };

    if (category) {
      where.OR = [
        { categoryId: category },
        { category: { slug: category } }
      ];
    }

    if (vendor) {
      where.OR = [
        { vendorId: vendor },
        { vendor: { userId: vendor } }
      ];
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price.gte = toDecimal(minPrice);
      if (maxPrice !== undefined) where.price.lte = toDecimal(maxPrice);
    }

    if (rating !== undefined) {
      where.avgRating = { gte: rating };
    }

    if (inStock) {
      where.stock = { gt: 0 };
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { searchKeywords: { has: search.toLowerCase() } }
      ];
    }

    let orderBy: any = { createdAt: 'desc' };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    else if (sort === 'price_desc') orderBy = { price: 'desc' };
    else if (sort === 'rating') orderBy = { avgRating: 'desc' };
    else if (sort === 'popular') orderBy = { soldCount: 'desc' };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          category: { select: { id: true, name: true, slug: true } },
          vendor: { select: { id: true, businessName: true } }
        }
      }),
      prisma.product.count({ where })
    ]);

    return {
      data: serializePrisma(products),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  // Fallback to Mongoose
  const query: any = { isDeleted: false, status: ProductStatus.ACTIVE };

  if (category) {
    if (mongoose.Types.ObjectId.isValid(category)) {
      query.category = category;
    } else {
      const catDoc = await Category.findOne({ slug: category });
      if (catDoc) query.category = catDoc._id;
    }
  }

  if (vendor) {
    query.vendor = vendor;
  }

  if (minPrice !== undefined || maxPrice !== undefined) {
    query.price = {};
    if (minPrice !== undefined) query.price.$gte = minPrice;
    if (maxPrice !== undefined) query.price.$lte = maxPrice;
  }

  if (rating !== undefined) {
    query.avgRating = { $gte: rating };
  }

  if (inStock) {
    query.stock = { $gt: 0 };
  }

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
      { searchKeywords: { $in: [new RegExp(search, 'i')] } }
    ];
  }

  let sortOption: any = { createdAt: -1 };
  if (sort === 'price_asc') sortOption = { price: 1 };
  else if (sort === 'price_desc') sortOption = { price: -1 };
  else if (sort === 'rating') sortOption = { avgRating: -1 };
  else if (sort === 'popular') sortOption = { soldCount: -1 };

  const [products, total] = await Promise.all([
    Product.find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .populate('category', 'name slug')
      .populate('vendor', 'businessName')
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
  if (isPrismaAvailable()) {
    const product = await prisma.product.findFirst({
      where: { id, isDeleted: false },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        vendor: { select: { id: true, businessName: true, businessDescription: true } },
        reviews: {
          where: { isApproved: true },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { customer: { select: { id: true, name: true, avatar: true } } }
        }
      }
    });

    if (!product) {
      throw ApiError.notFound('Product not found');
    }
    return serializePrisma(product);
  }

  const product = await Product.findOne({ _id: id, isDeleted: false })
    .populate('category', 'name slug')
    .populate('vendor', 'businessName businessDescription')
    .populate({
      path: 'reviews',
      match: { isApproved: true },
      options: { limit: 5, sort: { createdAt: -1 } },
      populate: { path: 'customer', select: 'name avatar' }
    });

  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  return product;
};

export const getProductBySlug = async (slug: string) => {
  if (isPrismaAvailable()) {
    const product = await prisma.product.findFirst({
      where: { slug, isDeleted: false },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        vendor: { select: { id: true, businessName: true, businessDescription: true } }
      }
    });

    if (!product) {
      throw ApiError.notFound('Product not found');
    }
    return serializePrisma(product);
  }

  const product = await Product.findOne({ slug, isDeleted: false })
    .populate('category', 'name slug')
    .populate('vendor', 'businessName businessDescription');

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
    comparePrice?: number;
    categoryId?: string;
    category?: string;
    stock: number;
    images: string[];
    status: ProductStatus;
    searchKeywords: string[];
  }>
) => {
  const categoryId = data.categoryId || data.category;

  if (isPrismaAvailable()) {
    const profile = await prisma.vendorProfile.findUnique({ where: { userId: vendorId } });
    const resolvedVendorId = profile ? profile.id : vendorId;

    const product = await prisma.product.findFirst({
      where: { id: productId, isDeleted: false }
    });

    if (!product) {
      throw ApiError.notFound('Product not found');
    }

    if (product.vendorId !== resolvedVendorId) {
      throw ApiError.forbidden('You are not authorized to update this product');
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.description ? { description: data.description } : {}),
        ...(data.price !== undefined ? { price: toDecimal(data.price) } : {}),
        ...(data.comparePrice !== undefined
          ? { comparePrice: data.comparePrice ? toDecimal(data.comparePrice) : null }
          : {}),
        ...(data.stock !== undefined ? { stock: data.stock } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(data.images ? { images: data.images } : {}),
        ...(data.status ? { status: data.status } : {}),
        ...(data.searchKeywords ? { searchKeywords: data.searchKeywords } : {})
      },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        vendor: { select: { id: true, businessName: true } }
      }
    });

    return serializePrisma(updated);
  }

  // Fallback to Mongoose
  const product = await Product.findOne({ _id: productId, isDeleted: false });
  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  if (product.vendor.toString() !== vendorId) {
    throw ApiError.forbidden('You are not authorized to update this product');
  }

  if (data.name) product.name = data.name;
  if (data.description) product.description = data.description;
  if (data.price !== undefined) product.price = data.price;
  if (data.comparePrice !== undefined) product.comparePrice = data.comparePrice;
  if (data.stock !== undefined) product.stock = data.stock;
  if (categoryId) product.category = categoryId as any;
  if (data.images) product.images = data.images;
  if (data.status) product.status = data.status;
  if (data.searchKeywords) product.searchKeywords = data.searchKeywords;

  await product.save();
  return product;
};

export const deleteProduct = async (vendorId: string, productId: string) => {
  if (isPrismaAvailable()) {
    const profile = await prisma.vendorProfile.findUnique({ where: { userId: vendorId } });
    const resolvedVendorId = profile ? profile.id : vendorId;

    const product = await prisma.product.findFirst({
      where: { id: productId, isDeleted: false }
    });

    if (!product) {
      throw ApiError.notFound('Product not found');
    }

    if (product.vendorId !== resolvedVendorId) {
      throw ApiError.forbidden('You are not authorized to delete this product');
    }

    await prisma.$transaction([
      prisma.product.update({
        where: { id: productId },
        data: { isDeleted: true, status: ProductStatus.INACTIVE }
      }),
      prisma.category.update({
        where: { id: product.categoryId },
        data: { productCount: { decrement: 1 } }
      })
    ]);

    removeProduct(productId).catch(() => {});
    return { message: 'Product deleted successfully' };
  }

  const product = await Product.findOne({ _id: productId, isDeleted: false });
  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  if (product.vendor.toString() !== vendorId) {
    throw ApiError.forbidden('You are not authorized to delete this product');
  }

  product.isDeleted = true;
  product.status = ProductStatus.INACTIVE;
  await product.save();

  await Category.findByIdAndUpdate(product.category, { $inc: { productCount: -1 } });
  removeProduct(productId).catch(() => {});

  return { message: 'Product deleted successfully' };
};

export const getVendorProducts = async (
  vendorId: string,
  params: { page?: number; limit?: number; status?: string }
) => {
  const { page = 1, limit = 10, status } = params;
  const skip = (page - 1) * limit;

  if (isPrismaAvailable()) {
    const profile = await prisma.vendorProfile.findUnique({ where: { userId: vendorId } });
    const resolvedVendorId = profile ? profile.id : vendorId;

    const where: any = {
      vendorId: resolvedVendorId,
      isDeleted: false
    };

    if (status) {
      where.status = status as ProductStatus;
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { category: { select: { id: true, name: true } } }
      }),
      prisma.product.count({ where })
    ]);

    return {
      data: serializePrisma(products),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  const query: any = { vendor: vendorId, isDeleted: false };
  if (status) query.status = status;

  const [products, total] = await Promise.all([
    Product.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('category', 'name')
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

export const getFeaturedProducts = async () => {
  if (isPrismaAvailable()) {
    const products = await prisma.product.findMany({
      where: { isDeleted: false, status: ProductStatus.ACTIVE },
      orderBy: { avgRating: 'desc' },
      take: 8,
      include: {
        category: { select: { id: true, name: true, slug: true } },
        vendor: { select: { id: true, businessName: true } }
      }
    });
    return serializePrisma(products);
  }

  return Product.find({ isDeleted: false, status: ProductStatus.ACTIVE })
    .sort({ avgRating: -1 })
    .limit(8)
    .populate('category', 'name slug')
    .populate('vendor', 'businessName');
};
