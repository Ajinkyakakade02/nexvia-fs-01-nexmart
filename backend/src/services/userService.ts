import User from '../models/User.js';
import { IAddress } from '../types/index.js';
import { ApiError } from '../utils/apiError.js';

export const getProfile = async (userId: string) => {
  const user = await User.findById(userId).select('-passwordHash -resetPasswordToken -resetPasswordExpires');
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return user;
};

export const updateProfile = async (
  userId: string,
  data: { name?: string; phone?: string; avatar?: string }
) => {
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }

  if (data.name) user.name = data.name;
  if (data.phone !== undefined) user.phone = data.phone;
  if (data.avatar !== undefined) user.avatar = data.avatar;

  await user.save();
  return user;
};

export const getAddresses = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return user.addresses || [];
};

export const addAddress = async (userId: string, addressData: IAddress) => {
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }

  if (addressData.isDefault || user.addresses.length === 0) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
    });
    addressData.isDefault = true;
  }

  user.addresses.push(addressData);
  await user.save();
  return user.addresses;
};

export const updateAddress = async (
  userId: string,
  addressId: string,
  addressData: Partial<IAddress>
) => {
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }

  const address = (user.addresses as any).id(addressId);
  if (!address) {
    throw ApiError.notFound('Address not found');
  }

  if (addressData.isDefault) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
    });
  }

  Object.assign(address, addressData);
  await user.save();
  return user.addresses;
};

export const deleteAddress = async (userId: string, addressId: string) => {
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found');
  }

  const address = (user.addresses as any).id(addressId);
  if (!address) {
    throw ApiError.notFound('Address not found');
  }

  address.deleteOne();
  await user.save();
  return user.addresses;
};

