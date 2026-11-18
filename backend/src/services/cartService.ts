import Cart, { ICart } from '../models/Cart.js';
import Product from '../models/Product.js';
import { getRedisClient } from '../config/redis.js';
import { ApiError } from '../utils/apiError.js';
import { ProductStatus } from '../types/index.js';

const CART_CACHE_TTL = 86400; // 24 hours in seconds

const getCartCacheKey = (customerId: string) => `cart:${customerId}`;

const syncCartToRedis = async (customerId: string, cartData: any) => {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.setex(getCartCacheKey(customerId), CART_CACHE_TTL, JSON.stringify(cartData));
  } catch (err) {
    // Redis degradation: non-fatal
  }
};

const invalidateCartRedis = async (customerId: string) => {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(getCartCacheKey(customerId));
  } catch (err) {
    // Non-fatal
  }
};

export const getCart = async (customerId: string) => {
  // Try Redis first for fast response
  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get(getCartCacheKey(customerId));
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Fallback to MongoDB
    }
  }

  let cart = await Cart.findOne({ customer: customerId })
    .populate({
      path: 'items.product',
      select: 'name slug price comparePrice images stock status isDeleted',
      populate: { path: 'vendor', select: 'name' }
    })
    .populate('items.vendor', 'name');

  if (!cart) {
    cart = new Cart({ customer: customerId, items: [] });
    await cart.save();
  }

  // Filter out deleted/inactive products or adjust out-of-stock
  let hasChanges = false;
  const validItems = cart.items.filter((item: any) => {
    if (!item.product || item.product.isDeleted || item.product.status !== ProductStatus.ACTIVE) {
      hasChanges = true;
      return false;
    }
    return true;
  });

  if (hasChanges) {
    cart.items = validItems;
    await cart.save();
  }

  // Calculate totals
  const subtotal = validItems.reduce((sum: number, item: any) => {
    const currentPrice = item.product?.price ?? item.priceAtAdd;
    return sum + currentPrice * item.quantity;
  }, 0);

  const result = {
    _id: cart._id,
    customer: cart.customer,
    items: validItems,
    itemCount: validItems.reduce((count: number, item: any) => count + item.quantity, 0),
    subtotal,
    updatedAt: cart.updatedAt
  };

  await syncCartToRedis(customerId, result);
  return result;
};

export const addToCart = async (
  customerId: string,
  productId: string,
  quantity = 1
) => {
  if (quantity <= 0) {
    throw ApiError.badRequest('Quantity must be at least 1');
  }

  const product = await Product.findOne({ _id: productId, isDeleted: false });
  if (!product || product.status !== ProductStatus.ACTIVE) {
    throw ApiError.notFound('Product is unavailable or does not exist');
  }

  // Vendor cannot buy their own product
  if (product.vendor.toString() === customerId) {
    throw ApiError.badRequest('Vendors cannot purchase their own products');
  }

  if (product.stock < quantity) {
    throw ApiError.badRequest(`Insufficient stock available (in stock: ${product.stock})`);
  }

  let cart = await Cart.findOne({ customer: customerId });
  if (!cart) {
    cart = new Cart({ customer: customerId, items: [] });
  }

  const existingIndex = cart.items.findIndex(
    (item) => item.product.toString() === productId
  );

  if (existingIndex > -1) {
    const newQty = cart.items[existingIndex].quantity + quantity;
    if (newQty > product.stock) {
      throw ApiError.badRequest(`Cannot add more than available stock (${product.stock})`);
    }
    cart.items[existingIndex].quantity = newQty;
    cart.items[existingIndex].priceAtAdd = product.price;
  } else {
    cart.items.push({
      product: product._id,
      vendor: product.vendor,
      quantity,
      priceAtAdd: product.price
    });
  }

  await cart.save();
  await invalidateCartRedis(customerId);

  return getCart(customerId);
};

export const updateCartItem = async (
  customerId: string,
  productId: string,
  quantity: number
) => {
  if (quantity <= 0) {
    return removeCartItem(customerId, productId);
  }

  const product = await Product.findOne({ _id: productId, isDeleted: false });
  if (!product || product.status !== ProductStatus.ACTIVE) {
    throw ApiError.notFound('Product is unavailable or has been removed');
  }

  if (product.stock < quantity) {
    throw ApiError.badRequest(`Only ${product.stock} items currently available`);
  }

  const cart = await Cart.findOne({ customer: customerId });
  if (!cart) {
    throw ApiError.notFound('Cart not found');
  }

  const item = cart.items.find((i) => i.product.toString() === productId);
  if (!item) {
    throw ApiError.notFound('Item not in cart');
  }

  item.quantity = quantity;
  item.priceAtAdd = product.price;

  await cart.save();
  await invalidateCartRedis(customerId);

  return getCart(customerId);
};

export const removeCartItem = async (customerId: string, productId: string) => {
  const cart = await Cart.findOne({ customer: customerId });
  if (!cart) {
    throw ApiError.notFound('Cart not found');
  }

  cart.items = cart.items.filter((item) => item.product.toString() !== productId);
  await cart.save();
  await invalidateCartRedis(customerId);

  return getCart(customerId);
};

export const clearCart = async (customerId: string) => {
  const cart = await Cart.findOne({ customer: customerId });
  if (cart) {
    cart.items = [];
    await cart.save();
  }
  await invalidateCartRedis(customerId);
  return { message: 'Cart cleared successfully' };
};

