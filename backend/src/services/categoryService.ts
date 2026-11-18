import prisma, { isPrismaAvailable } from '../config/prisma.js';
import Category, { ICategory } from '../models/Category.js';
import Product from '../models/Product.js';
import { ApiError } from '../utils/apiError.js';
import { serializePrisma } from '../utils/prismaSerializer.js';

const slugify = (text: string): string => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
};

export const getCategories = async (includeInactive = false) => {
  if (isPrismaAvailable()) {
    const categories = await prisma.category.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' }
    });
    return serializePrisma(categories);
  }

  const query = includeInactive ? {} : { isActive: true };
  return Category.find(query).sort({ name: 1 });
};

export const getCategoryById = async (id: string) => {
  if (isPrismaAvailable()) {
    const category = await prisma.category.findUnique({
      where: { id }
    });
    if (!category) {
      throw ApiError.notFound('Category not found');
    }
    return serializePrisma(category);
  }

  const category = await Category.findById(id);
  if (!category) {
    throw ApiError.notFound('Category not found');
  }
  return category;
};

export const getCategoryBySlug = async (slug: string) => {
  if (isPrismaAvailable()) {
    const category = await prisma.category.findUnique({
      where: { slug }
    });
    if (!category) {
      throw ApiError.notFound('Category not found');
    }
    return serializePrisma(category);
  }

  const category = await Category.findOne({ slug });
  if (!category) {
    throw ApiError.notFound('Category not found');
  }
  return category;
};

export const createCategory = async (data: {
  name: string;
  description?: string;
  image?: string;
  isActive?: boolean;
}) => {
  const slug = slugify(data.name);

  if (isPrismaAvailable()) {
    const existing = await prisma.category.findFirst({
      where: { OR: [{ name: data.name }, { slug }] }
    });
    if (existing) {
      throw ApiError.conflict('A category with this name or slug already exists');
    }

    const category = await prisma.category.create({
      data: {
        name: data.name,
        slug,
        description: data.description,
        image: data.image,
        isActive: data.isActive !== undefined ? data.isActive : true
      }
    });
    return serializePrisma(category);
  }

  const existing = await Category.findOne({ $or: [{ name: data.name }, { slug }] });
  if (existing) {
    throw ApiError.conflict('A category with this name or slug already exists');
  }

  const category = new Category({
    ...data,
    slug
  });

  await category.save();
  return category;
};

export const updateCategory = async (
  id: string,
  data: Partial<{ name: string; description: string; image: string; isActive: boolean }>
) => {
  if (isPrismaAvailable()) {
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) {
      throw ApiError.notFound('Category not found');
    }

    let newSlug = category.slug;
    if (data.name && data.name !== category.name) {
      newSlug = slugify(data.name);
      const existing = await prisma.category.findFirst({
        where: {
          id: { not: id },
          OR: [{ name: data.name }, { slug: newSlug }]
        }
      });
      if (existing) {
        throw ApiError.conflict('A category with this name or slug already exists');
      }
    }

    const updated = await prisma.category.update({
      where: { id },
      data: {
        ...(data.name ? { name: data.name, slug: newSlug } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.image !== undefined ? { image: data.image } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {})
      }
    });
    return serializePrisma(updated);
  }

  const category = await Category.findById(id);
  if (!category) {
    throw ApiError.notFound('Category not found');
  }

  if (data.name && data.name !== category.name) {
    const slug = slugify(data.name);
    const existing = await Category.findOne({
      _id: { $ne: id },
      $or: [{ name: data.name }, { slug }]
    });
    if (existing) {
      throw ApiError.conflict('A category with this name or slug already exists');
    }
    category.name = data.name;
    category.slug = slug;
  }

  if (data.description !== undefined) category.description = data.description;
  if (data.image !== undefined) category.image = data.image;
  if (data.isActive !== undefined) category.isActive = data.isActive;

  await category.save();
  return category;
};

export const deleteCategory = async (id: string) => {
  if (isPrismaAvailable()) {
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) {
      throw ApiError.notFound('Category not found');
    }

    const productCount = await prisma.product.count({
      where: { categoryId: id, isDeleted: false }
    });
    if (productCount > 0) {
      throw ApiError.badRequest(
        `Cannot delete category with ${productCount} active product(s). Reassign products first.`
      );
    }

    await prisma.category.delete({ where: { id } });
    return { message: 'Category deleted successfully' };
  }

  const category = await Category.findById(id);
  if (!category) {
    throw ApiError.notFound('Category not found');
  }

  const productCount = await Product.countDocuments({ category: id, isDeleted: false });
  if (productCount > 0) {
    throw ApiError.badRequest(
      `Cannot delete category with ${productCount} active product(s). Reassign products first.`
    );
  }

  await category.deleteOne();
  return { message: 'Category deleted successfully' };
};
