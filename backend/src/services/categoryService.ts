import Category, { ICategory } from '../models/Category.js';
import Product from '../models/Product.js';
import { ApiError } from '../utils/apiError.js';

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
  const query = includeInactive ? {} : { isActive: true };
  return Category.find(query).sort({ name: 1 });
};

export const getCategoryById = async (id: string) => {
  const category = await Category.findById(id);
  if (!category) {
    throw ApiError.notFound('Category not found');
  }
  return category;
};

export const getCategoryBySlug = async (slug: string) => {
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
  const category = await Category.findById(id);
  if (!category) {
    throw ApiError.notFound('Category not found');
  }

  // Check if active products exist in category
  const productCount = await Product.countDocuments({ category: id, isDeleted: false });
  if (productCount > 0) {
    throw ApiError.badRequest(
      `Cannot delete category with ${productCount} active product(s). Reassign products first.`
    );
  }

  await category.deleteOne();
  return { message: 'Category deleted successfully' };
};

